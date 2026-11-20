import { useApolloClient, useMutation, useQuery } from '@apollo/client/react';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Database } from '@/components/domain/app-icons';
import { BucketScanReport } from '@/components/domain/bucket-scan-report';
import { BulkTagDialog } from '@/components/domain/bulk-tag-dialog';
import { DocumentFilterBar, type TypeChoice } from '@/components/domain/document-filter-bar';
import { type DocumentRow, DocumentTable } from '@/components/domain/document-table';
import { UploadDialog } from '@/components/domain/upload-dialog';
import { EmptyState } from '@/components/empty-state';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { Button } from '@/components/ui/button';
import { FileText, Plus, ScanSearch, Tag, Upload, X } from '@/components/ui/icons';
import { useBucketScan } from '@/lib/bucket-scan';
import {
  type DocumentFilters,
  matchesDocumentFilters,
  readDocumentFilters,
  TagMatch,
  withDocumentFilters,
} from '@/lib/document-filters';
import { bareType, typeLabel } from '@/lib/document-type';
import { LIBRARY_QUERIES, Library, sortBuckets } from '@/lib/library';
import { FULL_WIDTH_BODY } from '@/lib/page';
import { queryLike } from '@/lib/query';
import { settingsLink } from '@/lib/settings-tabs';
import { BulkTagDocuments, sortTags, TAG_QUERIES, TagList } from '@/lib/tags';

/** Every filter back at "everything". */
const NO_FILTERS: DocumentFilters = { bucket: null, tagIds: [], match: TagMatch.Any, title: '', type: null };

/**
 * The documents, across every bucket, newest first, filtered by what the query string says: the bucket
 * (`?bucket=<slug>`), tags (any or all), title text and type. Every row is a link to its document's page, which is
 * how a phone, with no sidebar, reaches each one, and a box that chooses it for tagging in bulk. Until a bucket is
 * set up there is nowhere to upload to, so the page says so and links to Settings → Buckets. A bucket with no
 * documents can be scanned for the files already in it, and the scan's report stays over the list once they arrive.
 *
 * @returns The documents page.
 */
export function DocumentsRoute() {
  const result = useQuery(Library);
  const tagList = useQuery(TagList);
  const client = useApolloClient();
  const [bulkTag] = useMutation(BulkTagDocuments);
  const [params, setParams] = useSearchParams();
  const [uploading, setUploading] = useState(false);
  const [tagging, setTagging] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const { scans, scan } = useBucketScan();

  const buckets = useMemo(() => sortBuckets(result.data?.buckets ?? []), [result.data]);
  const tags = useMemo(() => sortTags(tagList.data?.tags ?? []), [tagList.data]);
  const filters = readDocumentFilters(params);
  // A slug that names no bucket (removed, or mistyped) filters nothing, and so does a tag that is gone.
  const filtered = buckets.find((bucket) => bucket.slug === filters.bucket);
  const knownTags = new Set(tags.map((tag) => tag.id));
  const shownFilters = { ...filters, tagIds: filters.tagIds.filter((id) => knownTags.has(id)) };
  const total = buckets.reduce((sum, bucket) => sum + bucket.documents.length, 0);
  const inScope = useMemo(
    () =>
      (filtered ? [filtered] : buckets)
        .flatMap((bucket) => bucket.documents.map((document): DocumentRow => ({ document, bucket })))
        .sort((a, b) => b.document.createdAt.localeCompare(a.document.createdAt)),
    [buckets, filtered],
  );
  const rows = inScope.filter((row) => matchesDocumentFilters(row.document, shownFilters));
  const chosen = rows.filter((row) => selected.has(row.document.id)).map((row) => row.document.id);
  const isNarrowed = shownFilters.tagIds.length > 0 || filters.title.trim() !== '' || filters.type !== null;

  const types = useMemo(() => {
    const seen = new Map<string, TypeChoice>();
    for (const { document } of inScope) {
      const type = bareType(document.contentType);
      seen.set(type, { value: type, label: typeLabel(document.contentType) });
    }
    return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [inScope]);

  const refetch = useCallback(() => void client.refetchQueries({ include: [...LIBRARY_QUERIES] }), [client]);

  const changeFilters = (change: Partial<DocumentFilters>) =>
    setParams((current) => withDocumentFilters(current, change), { replace: true });

  async function applyBulkTags(change: { add: string[]; remove: string[] }) {
    // The answer carries each document's tags, which updates the rows; the counts on the tags page are another read.
    await bulkTag({ variables: { documentIds: chosen, ...change } });
    setSelected(new Set());
    void client.refetchQueries({ include: [...TAG_QUERIES] });
  }

  const scannable = (filtered ? [filtered] : buckets).filter((bucket) => bucket.secretReadable);
  const isScanning = scannable.some((bucket) => scans[bucket.id]?.running === true);
  const scanAll = async () => {
    for (const bucket of scannable) {
      await scan(bucket.id);
    }
  };
  const scanButton = (size: 'sm' | 'xs') =>
    scannable.length > 0 ? (
      <Button
        variant="outline"
        size={size}
        iconSlot={<ScanSearch />}
        content={filtered ? 'Scan it for files' : 'Scan for files'}
        loading={isScanning}
        loadingLabel="Scanning…"
        onClick={() => void scanAll()}
      />
    ) : null;
  const reports = buckets.flatMap((bucket) => {
    const state = scans[bucket.id];
    return state ? [<BucketScanReport key={bucket.id} bucketName={bucket.name} scan={state} />] : [];
  });

  const uploadButton = (
    <Button variant="info" size="sm" iconSlot={<Upload />} content="Upload" onClick={() => setUploading(true)} />
  );

  let listed: ReactNode;
  if (rows.length > 0) {
    listed = <DocumentTable rows={rows} selected={selected} onSelectedChange={setSelected} />;
  } else if (isNarrowed) {
    listed = (
      <EmptyState
        compact
        title="No documents match these filters."
        actionSlot={
          <Button variant="outline" size="xs" content="Clear filters" onClick={() => changeFilters(NO_FILTERS)} />
        }
      />
    );
  } else {
    listed = (
      <EmptyState
        compact
        title={`Nothing in “${filtered?.name ?? ''}” yet.`}
        actionSlot={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="xs" content="Upload into it" onClick={() => setUploading(true)} />
            {scanButton('xs')}
          </div>
        }
      />
    );
  }

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
        description="Upload files into one of your buckets, or scan them for the files already there. Each one gets a page here, with a preview and a download."
        actionSlot={
          <div className="flex flex-wrap justify-center gap-2">
            {uploadButton}
            {scanButton('sm')}
          </div>
        }
      />
    );
  } else {
    body = (
      <div className="grid gap-4 pb-4">
        <DocumentFilterBar
          filters={filters}
          buckets={buckets}
          tags={tags}
          types={types}
          onChange={changeFilters}
          onClear={() => changeFilters(NO_FILTERS)}
        />
        {chosen.length > 0 && (
          // A polite status, so ticking a box says how many are chosen without moving focus.
          <div role="status" className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{chosen.length === 1 ? '1 chosen' : `${chosen.length} chosen`}</span>
            <Button
              variant="outline"
              size="xs"
              iconSlot={<Tag />}
              content="Add or remove tags"
              onClick={() => setTagging(true)}
            />
            <Button
              variant="ghost"
              size="xs"
              iconSlot={<X />}
              content="Clear choice"
              onClick={() => setSelected(new Set())}
            />
          </div>
        )}
        {listed}
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
        contentSlot={
          reports.length > 0 ? (
            <div className="grid gap-4">
              <div className="grid gap-2">{reports}</div>
              {body}
            </div>
          ) : (
            body
          )
        }
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
      {tagging && (
        <BulkTagDialog count={chosen.length} tags={tags} onSave={applyBulkTags} onClose={() => setTagging(false)} />
      )}
    </>
  );
}
