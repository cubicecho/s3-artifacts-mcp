import { bareType } from '@/lib/document-type';
import { BUCKET_FILTER_PARAM, TAGS_FILTER_PARAM } from '@/lib/routes';

// What the documents list is filtered by, held in the query string so a filtered list can be linked, bookmarked
// and reloaded: `?bucket=<slug>&tags=<id>,<id>&match=all&q=<title text>&type=<content type>`. A value the page
// does not recognise (a bucket or tag since removed, a mistyped type) filters nothing, as an absent one does.

/** How the chosen tags are matched: a document with any of them, or only one with every one. */
export const TagMatch = { Any: 'any', All: 'all' } as const;
/** One of the ways in `TagMatch`. */
export type TagMatch = (typeof TagMatch)[keyof typeof TagMatch];

/** What separates the tag ids in `?tags=`. A UUID never holds one. */
const TAG_SEPARATOR = ',';

/** The filters, as the page reads them from the URL. */
export interface DocumentFilters {
  /** A bucket's slug, or null for every bucket. */
  bucket: string | null;
  /** Tag ids, in the order they were chosen. Empty for no tag filter. */
  tagIds: readonly string[];
  /** How `tagIds` are matched. */
  match: TagMatch;
  /** Text the title has to contain, ignoring case. Empty for any title. */
  title: string;
  /** A bare content type (`application/pdf`), or null for every type. */
  type: string | null;
}

/** The query-string key of each filter. The bucket's is the one the sidebar's links already use. */
export const FILTER_PARAMS: Readonly<Record<keyof DocumentFilters, string>> = Object.freeze({
  bucket: BUCKET_FILTER_PARAM,
  tagIds: TAGS_FILTER_PARAM,
  match: 'match',
  title: 'q',
  type: 'type',
});

/** Every filter, in the order the URL writes them. */
const FILTER_KEYS: readonly (keyof DocumentFilters)[] = ['bucket', 'tagIds', 'match', 'title', 'type'];

/** What a document has to show to be filtered. */
export interface FilterableDocument {
  title: string;
  contentType: string;
  tags: readonly { id: string }[];
}

/**
 * The filters a query string asks for.
 *
 * @param params - The page's search params.
 * @returns The filters, each at "everything" when the URL leaves it out.
 */
export function readDocumentFilters(params: URLSearchParams): DocumentFilters {
  const tags = params.get(FILTER_PARAMS.tagIds) ?? '';
  return {
    bucket: params.get(FILTER_PARAMS.bucket) || null,
    tagIds: [...new Set(tags.split(TAG_SEPARATOR).filter((id) => id !== ''))],
    match: params.get(FILTER_PARAMS.match) === TagMatch.All ? TagMatch.All : TagMatch.Any,
    title: params.get(FILTER_PARAMS.title) ?? '',
    type: params.get(FILTER_PARAMS.type) || null,
  };
}

/**
 * The query string with some filters changed, every other parameter kept. A filter back at "everything" leaves the
 * URL, so a cleared list has a clean address; `match` is written only while tags are chosen and it is `all`.
 *
 * @param current - The page's search params now.
 * @param change - The filters to change.
 * @returns New search params.
 */
export function withDocumentFilters(current: URLSearchParams, change: Partial<DocumentFilters>): URLSearchParams {
  const next = new URLSearchParams(current);
  const filters = { ...readDocumentFilters(current), ...change };
  const values: Record<keyof DocumentFilters, string | null> = {
    bucket: filters.bucket,
    tagIds: filters.tagIds.length > 0 ? filters.tagIds.join(TAG_SEPARATOR) : null,
    match: filters.tagIds.length > 0 && filters.match === TagMatch.All ? TagMatch.All : null,
    title: filters.title === '' ? null : filters.title,
    type: filters.type,
  };
  for (const filter of FILTER_KEYS) {
    const value = values[filter];
    if (value === null) {
      next.delete(FILTER_PARAMS[filter]);
    } else {
      next.set(FILTER_PARAMS[filter], value);
    }
  }
  return next;
}

/**
 * Whether a document passes the tag, title and type filters. The bucket is chosen before this, by the rows asked
 * for.
 *
 * @param document - The document, with its tags.
 * @param filters - The filters. Tag ids no tag has any more are left out by the caller.
 * @returns True when it is shown.
 */
export function matchesDocumentFilters(document: FilterableDocument, filters: DocumentFilters): boolean {
  const title = filters.title.trim().toLowerCase();
  const isTitleShown = title === '' || document.title.toLowerCase().includes(title);
  const isTypeShown = filters.type === null || bareType(document.contentType) === filters.type;
  const held = new Set(document.tags.map((tag) => tag.id));
  const isTagged =
    filters.match === TagMatch.All
      ? filters.tagIds.every((id) => held.has(id))
      : filters.tagIds.some((id) => held.has(id));
  const isTagShown = filters.tagIds.length === 0 || isTagged;
  return isTitleShown && isTypeShown && isTagShown;
}
