import { useApolloClient, useMutation, useQuery } from '@apollo/client/react';
import { useState } from 'react';
import { graphql } from '@/__generated__';
import { CardLayout } from '@/components/card-layout';
import { ConfirmButton } from '@/components/confirm-button';
import { Link2 } from '@/components/domain/app-icons';
import { ShareLinkDialog } from '@/components/domain/share-link-dialog';
import { DeleteShareLink, ShareLinkList } from '@/components/domain/share-link-list';
import { EmptyState } from '@/components/empty-state';
import { LoadState } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { messageOf } from '@/lib/error-message';
import { queryLike } from '@/lib/query';
import { describeExpiry, SHARE_LINK_QUERIES } from '@/lib/share-links';

const DocumentShareLinksQuery = graphql(`
  query DocumentShareLinks($id: UUID!) {
    document(where: { id: { eq: $id } }) {
      id
      shareLinks(orderBy: { createdAt: { direction: desc, priority: 1 } }) {
        ...ShareLinkRow
      }
    }
    appSettings {
      userId
      defaultLinkExpiryHours
      defaultLinkPermission
    }
    appSettingsLimits {
      minLinkExpiryHours
      maxLinkExpiryHours
    }
  }
`);

const RekeyDocument = graphql(`
  mutation RekeyDocument($id: UUID!) {
    rekeyDocument(id: $id) {
      id
      objectKey
    }
  }
`);

/** The key an upload is stored at: `<uuid>-<name>`. Anything else is where a scan found the file. */
const APP_MADE_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i;

/** The document as the card needs it. */
interface SharedDocument {
  id: string;
  title: string;
  objectKey: string;
  status: string;
  bucket: { name: string };
}

/**
 * What revoking every link costs, said before it is done. A scanned file is at a key the owner chose, and
 * re-keying moves it to one the app makes.
 *
 * @param document - The document.
 * @returns The confirm's description.
 */
function revokeDescription(document: SharedDocument): string {
  const moves = `The file moves to a new key in “${document.bucket.name}”, so every link made for it so far answers “not found”. Links you make afterwards work as before.`;
  const isScanned = APP_MADE_KEY.test(document.objectKey) === false;
  return isScanned
    ? `${moves} It was found by a scan at “${document.objectKey}”, and leaves that path for one the app makes, so anything else that reads it there loses it.`
    : moves;
}

/**
 * A document's share links: making one, copying one again, removing one from the list, and revoking them all by
 * moving the file to a new key.
 *
 * @param props - The document.
 * @returns The card, and the share dialog while it is open.
 */
export function DocumentShareLinks({ document }: { document: SharedDocument }) {
  const client = useApolloClient();
  const result = useQuery(DocumentShareLinksQuery, { variables: { id: document.id } });
  const [deleteShareLink] = useMutation(DeleteShareLink);
  const [rekeyDocument, rekeying] = useMutation(RekeyDocument);
  const [sharing, setSharing] = useState(false);
  const [failure, setFailure] = useState<{ title: string; message: string } | null>(null);

  const links = result.data?.document?.shareLinks ?? [];
  const settings = result.data?.appSettings;
  const limits = result.data?.appSettingsLimits;
  const isReady = document.status === 'ready';
  const refetchLinks = () => client.refetchQueries({ include: [...SHARE_LINK_QUERIES] });

  async function remove(id: string) {
    setFailure(null);
    try {
      await deleteShareLink({ variables: { id } });
      await refetchLinks();
    } catch (error) {
      setFailure({ title: 'Could not remove the link', message: messageOf(error) ?? 'The server refused it' });
    }
  }

  async function revokeAll() {
    setFailure(null);
    try {
      await rekeyDocument({ variables: { id: document.id } });
      await refetchLinks();
    } catch (error) {
      setFailure({ title: 'Could not revoke the links', message: messageOf(error) ?? 'The server refused it' });
    }
  }

  const maxHours = limits?.maxLinkExpiryHours;

  return (
    <>
      <CardLayout
        level={2}
        title="Share links"
        description={`Links anyone can open without signing in, served by the bucket until they expire${maxHours === undefined ? '' : `, at most ${describeExpiry(maxHours)} after they are made`}.`}
        actionSlot={
          <>
            <ConfirmButton
              size="sm"
              variant="destructive-outline"
              content="Revoke all links"
              disabled={isReady === false}
              loading={rekeying.loading}
              title={`Revoke every link to “${document.title}”?`}
              description={revokeDescription(document)}
              confirmLabel="Revoke all links"
              onConfirm={() => void revokeAll()}
            />
            <Button
              size="sm"
              iconSlot={<Link2 />}
              content="Share"
              disabled={isReady === false || settings === undefined || limits === undefined}
              hint={isReady ? undefined : 'The upload has not finished'}
              onClick={() => setSharing(true)}
            />
          </>
        }
        contentSlot={
          <div className="grid gap-4">
            {failure && <Alert variant="destructive" title={failure.title} description={failure.message} />}
            {links.length === 0 ? (
              <LoadState
                compact
                query={queryLike(result)}
                what="the share links"
                count={links.length}
                emptySlot={<EmptyState compact title="No share links yet." />}
              />
            ) : (
              <ShareLinkList
                links={links}
                onRemove={(id) => void remove(id)}
                onCopyError={() =>
                  setFailure({
                    title: 'Could not copy the link',
                    message: 'This browser does not let the app use the clipboard here (it needs HTTPS).',
                  })
                }
              />
            )}
          </div>
        }
      />
      {sharing && settings && limits && (
        <ShareLinkDialog
          documentId={document.id}
          title={document.title}
          defaults={{ permission: settings.defaultLinkPermission, expiresInHours: settings.defaultLinkExpiryHours }}
          limits={limits}
          onCreated={refetchLinks}
          onClose={() => setSharing(false)}
        />
      )}
    </>
  );
}
