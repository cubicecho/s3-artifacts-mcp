import type { TreeEntry } from '@/lib/tree';

/** A bucket as the tree draws it. */
export interface TreeBucket {
  id: string;
  name: string;
  secretReadable: boolean;
  documents: readonly TreeDocument[];
}

/** A document as the tree draws it. */
export interface TreeDocument {
  id: string;
  title: string;
}

/** One row of the bucket tree, as cubeui's `FileTree` takes it. */
export type BucketTreeEntry = TreeEntry &
  (
    | { kind: 'bucket'; bucket: TreeBucket }
    | { kind: 'document'; document: TreeDocument; bucket: TreeBucket }
    /** The one row under a bucket with no documents, saying so. */
    | { kind: 'empty'; bucket: TreeBucket }
  );

/** What the row under an empty bucket says. */
export const EMPTY_BUCKET_LABEL = 'No documents yet';

// `FileTree` names a row by the last segment of its path, so a `/` in a name would draw as a
// folder. It is shown as the division slash instead, which looks the same and nests nothing.
const DIVISION_SLASH = '∕';

function segment(name: string): string {
  const cleaned = name.replaceAll('/', DIVISION_SLASH).trim();
  return cleaned === '' ? 'Untitled' : cleaned;
}

/**
 * Names unique within one level: the tree keys rows by path, so two documents titled "notes"
 * would otherwise be drawn as one. The second becomes "notes (2)", in the order given.
 */
function uniqueNames<T>(items: readonly T[], nameOf: (item: T) => string): Map<T, string> {
  const taken = new Set<string>();
  const names = new Map<T, string>();
  for (const item of items) {
    const base = segment(nameOf(item));
    let name = base;
    for (let copy = 2; taken.has(name); copy += 1) {
      name = `${base} (${copy})`;
    }
    taken.add(name);
    names.set(item, name);
  }
  return names;
}

/**
 * The tree's rows: each bucket a folder, its documents flat beneath it, and a hint row under a
 * bucket that holds none. There are no folders inside a bucket (D11).
 *
 * @param buckets - The buckets, each with its ready documents.
 * @returns The flat entry list `FileTree` nests and sorts.
 */
export function bucketTreeEntries(buckets: readonly TreeBucket[]): BucketTreeEntry[] {
  const bucketNames = uniqueNames(buckets, (bucket) => bucket.name);
  return buckets.flatMap((bucket): BucketTreeEntry[] => {
    const folder = bucketNames.get(bucket) ?? segment(bucket.name);
    const head: BucketTreeEntry = { path: folder, type: 'dir', kind: 'bucket', bucket };
    if (bucket.documents.length === 0) {
      return [head, { path: `${folder}/${EMPTY_BUCKET_LABEL}`, type: 'file', kind: 'empty', bucket }];
    }
    const titles = uniqueNames(bucket.documents, (document) => document.title);
    return [
      head,
      ...bucket.documents.map(
        (document): BucketTreeEntry => ({
          path: `${folder}/${titles.get(document) ?? segment(document.title)}`,
          type: 'file',
          kind: 'document',
          document,
          bucket,
        }),
      ),
    ];
  });
}
