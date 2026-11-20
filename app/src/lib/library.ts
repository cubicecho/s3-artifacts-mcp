import { graphql } from '@/__generated__';
import type { LibraryQuery } from '@/__generated__/graphql';

/**
 * Every bucket and the documents ready in it: what the sidebar's tree and the documents page both
 * draw. One query for both, so Apollo asks once, and a refetch after an upload, a rename or a
 * delete moves the two together.
 *
 * `buckets` takes no arguments here, as in Settings → Buckets, so both read the same cache field:
 * a bucket added or removed there shows in the tree without a reload. Sorting is done where it is
 * drawn. A document still `pending_upload` has no bytes yet, so it is not listed.
 */
export const Library = graphql(`
  query Library {
    buckets {
      id
      slug
      name
      secretReadable
      documents(where: { status: { eq: ready } }) {
        id
        bucketId
        title
        filename
        contentType
        size
        createdAt
      }
    }
  }
`);

/** The queries an upload, a rename or a delete changes, by operation name, for `refetchQueries`. */
export const LIBRARY_QUERIES = ['Library'] as const;

/** A bucket as the library has it. */
export type LibraryBucket = LibraryQuery['buckets'][number];

/** A document as the library has it. */
export type LibraryDocument = LibraryBucket['documents'][number];

/**
 * By name, so a list reads the same however the server orders it.
 *
 * @param buckets - The buckets.
 * @returns A sorted copy.
 */
export function sortBuckets<B extends { name: string }>(buckets: readonly B[]): B[] {
  return [...buckets].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}
