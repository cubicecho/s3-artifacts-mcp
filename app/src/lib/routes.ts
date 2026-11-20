/**
 * Every path the app answers at, as react-router patterns.
 *
 * The router, the sidebar and every redirect read the same entry, so a path that
 * moves is changed once rather than found by searching for a string.
 */
export const ROUTES = Object.freeze({
  /** The documents, across every bucket. */
  documents: '/',
  /** One document. Build a link to it with {@link documentPath}. */
  document: '/documents/:id',
  /** The owner's tags: made, renamed, recoloured and deleted here. */
  tags: '/tags',
  settings: '/settings',
  login: '/login',
  /** Where a magic link lands, carrying its token in the query string. */
  verify: '/auth/verify',
  /** Where an OIDC sign-in lands, carrying a one-time token the server's callback minted. */
  sso: '/auth/sso',
});

/** The query-string key the documents page filters by: a bucket's slug. */
export const BUCKET_FILTER_PARAM = 'bucket';

/**
 * Where one document's page is.
 *
 * @param id - The document's id.
 * @returns The path to its page.
 */
export function documentPath(id: string): string {
  return ROUTES.document.replace(':id', encodeURIComponent(id));
}

/**
 * The documents page, filtered to one bucket.
 *
 * @param slug - The bucket's slug.
 * @returns The path, with the bucket in the query string.
 */
export function bucketDocumentsPath(slug: string): string {
  return `${ROUTES.documents}?${new URLSearchParams({ [BUCKET_FILTER_PARAM]: slug })}`;
}

/** The query-string key the documents page filters by tags: their ids, comma-separated. */
export const TAGS_FILTER_PARAM = 'tags';

/**
 * The documents page, filtered to one tag.
 *
 * @param tagId - The tag's id.
 * @returns The path, with the tag in the query string.
 */
export function tagDocumentsPath(tagId: string): string {
  return `${ROUTES.documents}?${new URLSearchParams({ [TAGS_FILTER_PARAM]: tagId })}`;
}
