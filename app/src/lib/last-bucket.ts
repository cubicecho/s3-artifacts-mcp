// The bucket the last upload went to, kept in this browser so the upload panel can offer it
// again. A convenience only: a browser that refuses storage simply gets no preselection.
const LAST_BUCKET_KEY = 's3am_last_bucket';

/**
 * The bucket this browser last uploaded to.
 *
 * @returns Its id, or null when none is remembered or storage is blocked.
 */
export function lastBucketId(): string | null {
  try {
    return window.localStorage.getItem(LAST_BUCKET_KEY);
  } catch {
    return null;
  }
}

/**
 * Remembers the bucket an upload went to.
 *
 * @param id - The bucket's id.
 */
export function rememberBucket(id: string): void {
  try {
    window.localStorage.setItem(LAST_BUCKET_KEY, id);
  } catch {
    // Storage blocked: the next panel opens with nothing chosen, which is still correct.
  }
}

/** A bucket as the upload panel's picker reads it. */
export interface PickableBucket {
  id: string;
  slug: string;
  secretReadable: boolean;
}

/**
 * The bucket the upload panel opens on: the one the page is filtered to, else the only one, else
 * the one last uploaded to. Never one whose secret cannot be read, since nothing can be stored there.
 *
 * @param buckets - Every bucket.
 * @param filteredSlug - The slug the documents page is filtered to, if any.
 * @param remembered - The id last uploaded to, if any.
 * @returns The bucket's id, or null when none of the three applies.
 */
export function preselectBucket(
  buckets: readonly PickableBucket[],
  filteredSlug: string | null | undefined,
  remembered: string | null,
): string | null {
  const usable = buckets.filter((bucket) => bucket.secretReadable);
  const filtered = usable.find((bucket) => bucket.slug === filteredSlug);
  if (filtered) {
    return filtered.id;
  }
  const [only] = usable;
  if (usable.length === 1 && only) {
    return only.id;
  }
  return usable.find((bucket) => bucket.id === remembered)?.id ?? null;
}
