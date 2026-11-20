import type { DB } from '@cubicecho/s3-artifacts-mcp-db';
import {
  type Bucket,
  buckets,
  type Document,
  DocumentStatus,
  documents,
  documentTags,
  tags,
} from '@cubicecho/s3-artifacts-mcp-db/schema';
import { and, asc, count, desc, eq, exists, ilike, inArray, type SQL, sql } from 'drizzle-orm';
import { parseDocumentId } from '../documents/rows.ts';

// What an MCP client may reach: one bucket, the one its endpoint names, and the documents in it. Everything else
// (other buckets, other owners' rows) does not exist as far as `/mcp/b/:slug` is concerned. Every document a tool
// reads goes through `inBucket`, so the rule is written once. The bucket row is read again on every call, so
// switching MCP off or making the bucket read-only takes effect on the next one.

/** What a tool says about a document id outside its bucket, whatever the reason: missing, elsewhere, malformed. */
export const NO_SUCH_DOCUMENT = 'No document with that id in this bucket. list_documents names the ones there are.';
/** What a tool says once the bucket it was connected to is gone or no longer shared. */
export const BUCKET_GONE = 'This bucket is no longer shared over MCP. The owner turns it on in Settings → MCP.';
/** What a write tool says on a bucket that is shared read-only. */
export const BUCKET_READ_ONLY =
  'This bucket is shared read-only. The owner can allow uploads and share links in Settings → MCP.';

/** Characters `ILIKE` reads as wildcards or as its escape, which a title filter means literally. */
const LIKE_SPECIAL = /[\\%_]/g;

/**
 * The bucket an endpoint names, if it is the key owner's and MCP is on for it.
 *
 * @param db - The database.
 * @param userId - The API key's owner. Never from the request.
 * @param slug - The endpoint's slug.
 * @returns The bucket, or null when there is none of that slug, it is someone else's, or MCP is off for it.
 */
export async function findMcpBucket(db: DB, userId: string, slug: string): Promise<Bucket | null> {
  const [row] = await db
    .select()
    .from(buckets)
    .where(and(eq(buckets.slug, slug), eq(buckets.userId, userId), eq(buckets.mcpEnabled, true)));
  return row ?? null;
}

/**
 * Reads the endpoint's bucket again, as every tool does before it acts.
 *
 * @param db - The database.
 * @param userId - The API key's owner.
 * @param bucketId - The bucket the endpoint was opened for.
 * @returns The bucket as it is now.
 * @throws When it is gone or MCP has been switched off for it since.
 */
export async function currentBucket(db: DB, userId: string, bucketId: string): Promise<Bucket> {
  const [row] = await db
    .select()
    .from(buckets)
    .where(and(eq(buckets.id, bucketId), eq(buckets.userId, userId), eq(buckets.mcpEnabled, true)));
  if (row === undefined) {
    throw new Error(BUCKET_GONE);
  }
  return row;
}

/**
 * Refuses a write on a bucket shared read-only.
 *
 * @param bucket - The bucket as it is now.
 * @throws When `mcp_writable` is off.
 */
export function requireWritable(bucket: Bucket): void {
  if (bucket.mcpWritable === false) {
    throw new Error(BUCKET_READ_ONLY);
  }
}

/**
 * The scope every MCP read of `documents` is ANDed with: the bucket's owner, and the bucket.
 *
 * @param bucket - The endpoint's bucket.
 * @returns The condition.
 */
function inBucket(bucket: Bucket): SQL | undefined {
  return and(eq(documents.userId, bucket.userId), eq(documents.bucketId, bucket.id));
}

/**
 * One document in the bucket, in whatever state.
 *
 * @param db - The database.
 * @param bucket - The endpoint's bucket.
 * @param id - The id as the agent sent it.
 * @returns The document, or null when the id is malformed, missing or names a document elsewhere.
 */
export async function bucketDocument(db: DB, bucket: Bucket, id: unknown): Promise<Document | null> {
  const documentId = parseDocumentId(id);
  if (documentId === null) {
    return null;
  }
  const [row] = await db
    .select()
    .from(documents)
    .where(and(inBucket(bucket), eq(documents.id, documentId)));
  return row ?? null;
}

/**
 * One ready document in the bucket.
 *
 * @param db - The database.
 * @param bucket - The endpoint's bucket.
 * @param id - The id as the agent sent it.
 * @returns The document.
 * @throws When there is no ready document of that id in the bucket: a pending upload is not a document yet.
 */
export async function readyBucketDocument(db: DB, bucket: Bucket, id: unknown): Promise<Document> {
  const document = await bucketDocument(db, bucket, id);
  if (document === null || document.status !== DocumentStatus.Ready) {
    throw new Error(NO_SUCH_DOCUMENT);
  }
  return document;
}

/** How a list's tags are matched: a document with any of them, or only one with every one. */
export const TagMatch = { Any: 'any', All: 'all' } as const;
/** One of the ways in `TagMatch`. */
export type TagMatch = (typeof TagMatch)[keyof typeof TagMatch];

/** Which of a bucket's documents `listBucketDocuments` reads. */
export interface DocumentFilter {
  /** Only titles containing this, ignoring case. */
  title?: string;
  /** Only types starting with this, ignoring case: `image/` for every image. */
  contentType?: string;
  /** Only documents with these tags, by name in any case, as `match` says. */
  tags?: readonly string[];
  /** Whether a document needs any of `tags` (the default) or all of them. */
  match?: TagMatch;
  /** How many at most. */
  limit: number;
  /** The id of the last document of the page before, which this page follows. */
  cursor?: string;
}

/** One page of a bucket's documents. */
export interface DocumentPage {
  documents: Document[];
  /** The `cursor` for the next page, or null on the last. */
  nextCursor: string | null;
}

/**
 * The bucket's ready documents, newest first, a page at a time.
 *
 * @param db - The database.
 * @param bucket - The endpoint's bucket.
 * @param filter - The filters, the page size and where the page starts.
 * @returns The page.
 * @throws When the cursor names no document in the bucket.
 */
export async function listBucketDocuments(db: DB, bucket: Bucket, filter: DocumentFilter): Promise<DocumentPage> {
  const conditions: (SQL | undefined)[] = [inBucket(bucket), eq(documents.status, DocumentStatus.Ready)];
  if (filter.title !== undefined) {
    conditions.push(ilike(documents.title, `%${escapeLike(filter.title)}%`));
  }
  if (filter.contentType !== undefined) {
    conditions.push(ilike(documents.contentType, `${escapeLike(filter.contentType)}%`));
  }
  const tagNames = filter.tags ?? [];
  if (tagNames.length > 0) {
    const keys = tagNames.map((name) => name.toLowerCase());
    const groups = filter.match === TagMatch.All ? keys.map((key) => [key]) : [keys];
    conditions.push(...groups.map((names) => hasTagNamed(db, names)));
  }
  if (filter.cursor !== undefined) {
    const after = await bucketDocument(db, bucket, filter.cursor);
    if (after === null) {
      throw new Error('That cursor names no document in this bucket. List again without one.');
    }
    // Compared in the database, whose timestamps are finer than a JS Date, so no document is skipped or repeated.
    conditions.push(
      sql`(${documents.createdAt}, ${documents.id}) < (select d.created_at, d.id from documents d where d.id = ${after.id})`,
    );
  }
  const rows = await db
    .select()
    .from(documents)
    .where(and(...conditions))
    .orderBy(desc(documents.createdAt), desc(documents.id))
    .limit(filter.limit + 1);
  const page = rows.slice(0, filter.limit);
  const hasMore = rows.length > filter.limit;
  return { documents: page, nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null };
}

/**
 * The condition that a document carries one of the owner's tags of these names.
 *
 * @param db - The database.
 * @param keys - Names in lower case.
 * @returns An `EXISTS` over the document's links.
 */
function hasTagNamed(db: DB, keys: readonly string[]): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(documentTags)
      .innerJoin(tags, eq(tags.id, documentTags.tagId))
      .where(
        and(
          eq(documentTags.documentId, documents.id),
          eq(tags.userId, documents.userId),
          inArray(sql`lower(${tags.name})`, [...keys]),
        ),
      ),
  );
}

/**
 * The names of each document's tags, sorted, for documents in the bucket.
 *
 * @param db - The database.
 * @param bucket - The endpoint's bucket.
 * @param documentIds - Documents already read through this module.
 * @returns Each document's tag names, by id. A document with none is missing from the map.
 */
export async function bucketDocumentTags(
  db: DB,
  bucket: Bucket,
  documentIds: readonly string[],
): Promise<Map<string, string[]>> {
  const names = new Map<string, string[]>();
  if (documentIds.length === 0) {
    return names;
  }
  const rows = await db
    .select({ documentId: documentTags.documentId, name: tags.name })
    .from(documentTags)
    .innerJoin(tags, eq(tags.id, documentTags.tagId))
    .innerJoin(documents, eq(documents.id, documentTags.documentId))
    .where(and(inBucket(bucket), eq(tags.userId, bucket.userId), inArray(documentTags.documentId, [...documentIds])))
    .orderBy(asc(sql`lower(${tags.name})`));
  for (const { documentId, name } of rows) {
    names.set(documentId, [...(names.get(documentId) ?? []), name]);
  }
  return names;
}

/** One of the owner's tags, and how many of the bucket's documents carry it. */
export interface BucketTagCount {
  name: string;
  color: string;
  documents: number;
}

/**
 * Every one of the owner's tags, by name, with how many ready documents in the bucket carry each. Tags belong to the
 * owner, not to a bucket, so one no document here carries is listed with 0: tagging by its name reuses it.
 *
 * @param db - The database.
 * @param bucket - The endpoint's bucket.
 * @returns The tags, sorted by name ignoring case.
 */
export async function bucketTagCounts(db: DB, bucket: Bucket): Promise<BucketTagCount[]> {
  const inThisBucket = and(inBucket(bucket), eq(documents.status, DocumentStatus.Ready));
  const rows = await db
    .select({ name: tags.name, color: tags.color, documents: count(documents.id) })
    .from(tags)
    .leftJoin(documentTags, eq(documentTags.tagId, tags.id))
    .leftJoin(documents, and(eq(documents.id, documentTags.documentId), inThisBucket))
    .where(eq(tags.userId, bucket.userId))
    .groupBy(tags.id)
    .orderBy(asc(sql`lower(${tags.name})`));
  return rows;
}

/**
 * Makes text match itself literally in an `ILIKE` pattern.
 *
 * @param text - What the agent typed.
 * @returns The text with `\`, `%` and `_` escaped.
 */
function escapeLike(text: string): string {
  return text.replace(LIKE_SPECIAL, (char) => `\\${char}`);
}
