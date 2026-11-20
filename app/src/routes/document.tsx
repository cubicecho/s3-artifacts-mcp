import { CombinedGraphQLErrors } from '@apollo/client/errors';
import { useApolloClient, useMutation, useQuery } from '@apollo/client/react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { graphql } from '@/__generated__';
import { ConfirmButton } from '@/components/confirm-button';
import { DocumentDetailsCard } from '@/components/domain/document-details-card';
import { DocumentPreviewCard } from '@/components/domain/document-preview-card';
import { DocumentShareLinks } from '@/components/domain/document-share-links';
import { DocumentTagsCard } from '@/components/domain/document-tags-card';
import { RenameDocumentDialog } from '@/components/domain/rename-document-dialog';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DownloadButton } from '@/components/ui/download-button';
import { ArrowLeft, FileText, Pencil, Trash2 } from '@/components/ui/icons';
import { fetchContentUrl } from '@/lib/content-url';
import { describeError, messageOf } from '@/lib/error-message';
import { joinStats } from '@/lib/format';
import { LIBRARY_QUERIES } from '@/lib/library';
import { FULL_WIDTH_BODY } from '@/lib/page';
import { queryLike } from '@/lib/query';
import { ROUTES } from '@/lib/routes';

const DocumentDetail = graphql(`
  query DocumentDetail($id: UUID!) {
    document(where: { id: { eq: $id } }) {
      id
      title
      filename
      objectKey
      contentType
      size
      sha256
      status
      createdAt
      bucket {
        id
        slug
        name
      }
      tags {
        ...TagFields
      }
    }
  }
`);

const RenameDocument = graphql(`
  mutation RenameDocument($id: UUID!, $title: String!) {
    renameDocument(id: $id, title: $title) {
      id
      title
    }
  }
`);

const DeleteDocument = graphql(`
  mutation DeleteDocument($id: UUID!) {
    deleteDocument(id: $id)
  }
`);

/** The code a row that is not there, or not the caller's, or not a UUID, answers with. */
const NOT_FOUND = 'NOT_FOUND';

/**
 * Whether a failed request is the server saying the document is not there.
 *
 * @param error - What the query failed with.
 * @returns True for `NOT_FOUND`.
 */
function isNotFound(error: unknown): boolean {
  return CombinedGraphQLErrors.is(error) && error.errors.some((entry) => entry.extensions?.code === NOT_FOUND);
}

/**
 * One document: its preview, its tags, its share links, its details, and Rename, Download and Delete in the header. A
 * document that is not there, or not the owner's, is a not-found page rather than an error.
 *
 * @returns The document page.
 */
export function DocumentRoute() {
  const { id = '' } = useParams();
  const result = useQuery(DocumentDetail, { variables: { id } });
  const client = useApolloClient();
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const [failure, setFailure] = useState<{ title: string; message: string } | null>(null);
  const [renameDocument] = useMutation(RenameDocument);
  const [deleteDocument, deletion] = useMutation(DeleteDocument);

  const missing = isNotFound(result.error);
  // NOT_FOUND is the server's way of saying "no such document", which is the not-found rung.
  const query = missing ? { ...queryLike(result), isError: false, error: null } : queryLike(result);
  const document = missing ? null : result.data?.document;

  async function remove(id: string, title: string) {
    setFailure(null);
    try {
      await deleteDocument({ variables: { id } });
    } catch (error) {
      setFailure({ title: `Could not delete “${title}”`, message: messageOf(error) ?? 'The server refused it' });
      return;
    }
    void client.refetchQueries({ include: [...LIBRARY_QUERIES] });
    void navigate(ROUTES.documents);
  }

  const back = (
    <Button
      variant="outline"
      size="sm"
      iconSlot={<ArrowLeft />}
      content="Documents"
      linkSlot={<Link to={ROUTES.documents} />}
    />
  );

  if (!document) {
    return (
      <div className="p-4">
        <LoadState query={query} what="this document" record={document} notFoundLabel="Document not found" />
      </div>
    );
  }

  const isReady = document.status === 'ready';

  return (
    <>
      <PageLayout
        width="full"
        backSlot={back}
        iconSlot={<FileText />}
        title={document.title}
        description={joinStats(document.bucket.name, document.filename)}
        actionSlot={
          <>
            {/* Rename and Delete are icons, so the three fit a phone's header on one line. */}
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Rename"
              hint="Change the title"
              iconSlot={<Pencil />}
              onClick={() => setRenaming(true)}
            />
            <DownloadButton
              size="sm"
              label="Download"
              filename={document.filename}
              disabled={isReady === false}
              href={() => fetchContentUrl(client, document.id, true)}
              onError={(error) => setFailure({ title: 'Could not download it', message: describeError(error) })}
            />
            <ConfirmButton
              size="icon-sm"
              aria-label="Delete"
              hint="Delete the document and its file"
              iconSlot={<Trash2 />}
              loading={deletion.loading}
              title={`Delete “${document.title}”?`}
              description={`The file is removed from the bucket “${document.bucket.name}” as well as from this list. Nothing keeps a copy.`}
              onConfirm={() => void remove(document.id, document.title)}
            />
          </>
        }
        contentClassName={FULL_WIDTH_BODY}
        contentSlot={
          <div className="grid gap-4 pb-4">
            {failure && <Alert variant="destructive" title={failure.title} description={failure.message} />}
            {isReady ? (
              // Keyed by the object, so a re-key asks for a preview URL signed for the new key.
              <DocumentPreviewCard key={document.objectKey} document={document} />
            ) : (
              <Alert
                variant="warning"
                title="This upload has not finished"
                description="Its bytes have not all reached the bucket. Upload the file again if it does not finish."
              />
            )}
            <DocumentTagsCard document={document} />
            <DocumentShareLinks document={document} />
            <DocumentDetailsCard document={document} />
          </div>
        }
      />
      {renaming && (
        <RenameDocumentDialog
          title={document.title}
          onRename={(title) => renameDocument({ variables: { id: document.id, title } })}
          onClose={() => setRenaming(false)}
        />
      )}
    </>
  );
}
