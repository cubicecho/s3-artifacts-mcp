import { useMemo } from 'react';
import { Link } from 'react-router';
import { FileTree } from '@/components/file-tree';
import { Badge } from '@/components/ui/badge';
import { type BucketTreeEntry, bucketTreeEntries, type TreeBucket } from '@/lib/bucket-tree';
import { formatCount } from '@/lib/format';
import { documentPath } from '@/lib/routes';

/** Starts every bucket shut. `FileTree` opens every folder unless told otherwise. */
const ALL_SHUT: readonly string[] = [];

interface BucketTreeProps {
  /** The buckets, each with its ready documents. */
  buckets: readonly TreeBucket[];
  /** The document whose page is open, which the tree marks. Its bucket is not opened for it. */
  selectedDocumentId?: string | undefined;
}

/**
 * The buckets and what is in them: cubeui's `FileTree` with each bucket a folder and its documents
 * flat beneath it, each a link to its page. Every bucket starts shut and opens only when pressed;
 * nothing opens one for the reader, not an upload, not a document's page, and what is open is
 * not kept across a reload.
 *
 * @param props - The buckets and the open document.
 * @returns The tree.
 */
export function BucketTree({ buckets, selectedDocumentId }: BucketTreeProps) {
  const entries = useMemo(() => bucketTreeEntries(buckets), [buckets]);
  const selected = entries.find((entry) => entry.kind === 'document' && entry.document.id === selectedDocumentId);

  return (
    <FileTree<BucketTreeEntry>
      label="Buckets and documents"
      entries={entries}
      defaultOpen={ALL_SHUT}
      selected={selected?.path}
      linkSlot={(node) =>
        node.entry?.kind === 'document' ? (
          <Link to={documentPath(node.entry.document.id)} />
        ) : (
          // The hint under an empty bucket is a row, not a link.
          <span />
        )
      }
      meta={(node) => {
        const entry = node.entry;
        if (entry?.kind !== 'bucket') {
          return null;
        }
        if (entry.bucket.secretReadable === false) {
          return <Badge variant="warning-soft">Secret unreadable</Badge>;
        }
        return formatCount(entry.bucket.documents.length);
      }}
    />
  );
}
