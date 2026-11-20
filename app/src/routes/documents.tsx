import { useApolloClient, useQuery } from '@apollo/client/react';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Combobox } from '@/components/combobox';
import { Database } from '@/components/domain/app-icons';
import { UploadDialog } from '@/components/domain/upload-dialog';
import { EmptyState } from '@/components/empty-state';
import { FormField } from '@/components/form-field';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { Button } from '@/components/ui/button';
import { FileText, Plus, Upload } from '@/components/ui/icons';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { typeLabel } from '@/lib/document-type';
import { formatBytes, formatDate } from '@/lib/format';
import { LIBRARY_QUERIES, Library, type LibraryBucket, type LibraryDocument, sortBuckets } from '@/lib/library';
import { FULL_WIDTH_BODY } from '@/lib/page';
import { queryLike } from '@/lib/query';
import { BUCKET_FILTER_PARAM, documentPath } from '@/lib/routes';
import { settingsLink } from '@/routes/settings';

/** The filter's "every bucket" choice. Not a slug: a slug is lower-case letters, digits and dashes. */
const ALL_BUCKETS = '*';

/** One row of the table: a document and the bucket it is in. */
interface Row {
  document: LibraryDocument;
  bucket: LibraryBucket;
}

/**
 * The documents, across every bucket or in the one the query string names (`?bucket=<slug>`),
 * newest first. Every row is a link to its document's page, which is how a phone, with no
 * sidebar, reaches each one. Until a bucket is set up there is nowhere to upload to, so the page
 * says so and links to Settings → Buckets.
 *
 * @returns The documents page.
 */
export function DocumentsRoute() {
  const result = useQuery(Library);
  const client = useApolloClient();
  const [params, setParams] = useSearchParams();
  const [uploading, setUploading] = useState(false);

  const buckets = useMemo(() => sortBuckets(result.data?.buckets ?? []), [result.data]);
  const slug = params.get(BUCKET_FILTER_PARAM);
  // A slug that names no bucket (removed, or mistyped) filters nothing.
  const filtered = buckets.find((bucket) => bucket.slug === slug);
  const total = buckets.reduce((sum, bucket) => sum + bucket.documents.length, 0);
  const rows = useMemo(
    () =>
      (filtered ? [filtered] : buckets)
        .flatMap((bucket) => bucket.documents.map((document): Row => ({ document, bucket })))
        .sort((a, b) => b.document.createdAt.localeCompare(a.document.createdAt)),
    [buckets, filtered],
  );

  const refetch = useCallback(() => void client.refetchQueries({ include: [...LIBRARY_QUERIES] }), [client]);

  const chooseBucket = (value: string) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value === ALL_BUCKETS) {
          next.delete(BUCKET_FILTER_PARAM);
        } else {
          next.set(BUCKET_FILTER_PARAM, value);
        }
        return next;
      },
      { replace: true },
    );

  const uploadButton = (
    <Button variant="info" size="sm" iconSlot={<Upload />} content="Upload" onClick={() => setUploading(true)} />
  );

  let body: ReactNode;
  if (buckets.length === 0) {
    body = (
      <LoadState
        query={queryLike(result)}
        what="your documents"
        count={buckets.length}
        emptySlot={
          <EmptyState
            level={2}
            iconSlot={<Database />}
            title="No buckets yet"
            description="Documents are stored in buckets of your own: AWS S3, MinIO, RustFS or Backblaze B2, on as many accounts as you like. Add the first one to start uploading."
            actionSlot={
              <Button iconSlot={<Plus />} content="Add a bucket" linkSlot={<Link to={settingsLink('buckets')} />} />
            }
          />
        }
      />
    );
  } else if (total === 0) {
    body = (
      <EmptyState
        level={2}
        iconSlot={<FileText />}
        title="No documents yet"
        description="Upload files into one of your buckets. Each one gets a page here, with a preview and a download."
        actionSlot={uploadButton}
      />
    );
  } else {
    body = (
      <div className="grid gap-4 pb-4">
        <FormField
          className="max-w-xs"
          label="Bucket"
          controlSlot={(props) => (
            <Combobox
              {...props}
              options={[
                { value: ALL_BUCKETS, label: 'All buckets' },
                ...buckets.map((bucket) => ({ value: bucket.slug, label: bucket.name })),
              ]}
              value={filtered?.slug ?? ALL_BUCKETS}
              onValueChange={chooseBucket}
            />
          )}
        />
        {rows.length === 0 ? (
          <EmptyState
            compact
            title={`Nothing in “${filtered?.name ?? ''}” yet.`}
            actionSlot={
              <Button variant="outline" size="xs" content="Upload into it" onClick={() => setUploading(true)} />
            }
          />
        ) : (
          <DocumentTable rows={rows} />
        )}
      </div>
    );
  }

  return (
    <>
      <PageLayout
        width="full"
        iconSlot={<FileText />}
        title="Documents"
        description="Everything you have uploaded, in every bucket."
        actionSlot={buckets.length > 0 ? uploadButton : undefined}
        contentClassName={FULL_WIDTH_BODY}
        contentSlot={body}
      />
      {uploading && (
        <UploadDialog
          open
          onOpenChange={setUploading}
          buckets={buckets}
          preferredSlug={filtered?.slug}
          onUploaded={refetch}
        />
      )}
    </>
  );
}

/**
 * The documents as a table, one link per row. Below `md` the type and the date are left out, so
 * the title, the bucket and the size fit a phone without the page scrolling sideways.
 *
 * @param props - The rows, already sorted.
 * @returns The table.
 */
function DocumentTable({ rows }: { rows: readonly Row[] }) {
  return (
    <Table>
      <TableCaption className="sr-only">Documents</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Title</TableHead>
          <TableHead>Bucket</TableHead>
          <TableHead className="hidden md:table-cell">Type</TableHead>
          <TableHead className="text-right">Size</TableHead>
          <TableHead className="hidden md:table-cell">Uploaded</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(({ document, bucket }) => (
          <TableRow key={document.id}>
            <TableHead className="max-w-[16rem] font-normal">
              <Link
                className="block truncate font-medium text-foreground underline-offset-2 hover:underline"
                to={documentPath(document.id)}
              >
                {document.title}
              </Link>
            </TableHead>
            <TableCell className="max-w-[10rem] truncate">{bucket.name}</TableCell>
            <TableCell className="hidden md:table-cell">{typeLabel(document.contentType)}</TableCell>
            <TableCell className="whitespace-nowrap text-right">{formatBytes(document.size)}</TableCell>
            <TableCell className="hidden whitespace-nowrap md:table-cell">{formatDate(document.createdAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
