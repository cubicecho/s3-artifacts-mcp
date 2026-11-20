import type { DB } from '@cubicecho/s3-artifacts-mcp-db';
import { documents, documentTags, tags } from '@cubicecho/s3-artifacts-mcp-db/schema';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { TAG_DEFAULTS } from '../core/defaults.ts';
import { badInput, notFound } from '../core/errors.ts';
import { DOCUMENT_NOT_FOUND } from '../documents/rows.ts';

// Putting tags on documents and taking them off, for the app's mutations and MCP's tools alike. Every id is checked
// against the owner first: a tag or a document that is missing, someone else's or not a UUID answers NOT_FOUND, and
// nothing changes. A link carries the owner's id, as every row does.

/** The message for a tag that does not exist or is not the caller's, which the caller may not tell apart. */
export const TAG_NOT_FOUND = 'Tag not found.';

const { maxTagsPerCall, bulkMaxDocuments } = TAG_DEFAULTS;

const idSchema = z.uuid();

/**
 * The distinct ids of a list, or null when one is not a UUID and so names no row.
 *
 * @param ids - The ids as sent.
 * @returns The ids, each once.
 */
function distinctIds(ids: readonly unknown[]): string[] | null {
  const parsed = ids.map((id) => idSchema.safeParse(id));
  const isMalformed = parsed.some((result) => result.success === false);
  if (isMalformed) {
    return null;
  }
  return [...new Set(parsed.flatMap((result) => (result.success ? [result.data] : [])))];
}

/**
 * Checks that every id names one of the owner's tags.
 *
 * @param db - The database.
 * @param userId - The owner.
 * @param ids - The tag ids as sent.
 * @returns The ids, each once.
 * @throws BAD_USER_INPUT for more than `TAG_DEFAULTS.maxTagsPerCall`; NOT_FOUND when any is malformed, missing or not the owner's.
 */
export async function ownTagIds(db: DB, userId: string, ids: readonly unknown[]): Promise<string[]> {
  const distinct = distinctIds(ids);
  if (distinct === null) {
    throw notFound(TAG_NOT_FOUND);
  }
  if (distinct.length > maxTagsPerCall) {
    throw badInput(`Name at most ${maxTagsPerCall} tags at a time.`);
  }
  if (distinct.length === 0) {
    return [];
  }
  const found = await db
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.userId, userId), inArray(tags.id, distinct)));
  if (found.length !== distinct.length) {
    throw notFound(TAG_NOT_FOUND);
  }
  return distinct;
}

/**
 * Checks that every id names one of the owner's documents.
 *
 * @param db - The database.
 * @param userId - The owner.
 * @param ids - The document ids as sent.
 * @returns The ids, each once.
 * @throws BAD_USER_INPUT for none, or more than `TAG_DEFAULTS.bulkMaxDocuments`; NOT_FOUND when any is malformed,
 *   missing or not the owner's.
 */
export async function ownDocumentIds(db: DB, userId: string, ids: readonly unknown[]): Promise<string[]> {
  const distinct = distinctIds(ids);
  if (distinct === null) {
    throw notFound(DOCUMENT_NOT_FOUND);
  }
  if (distinct.length === 0) {
    throw badInput('Choose at least one document.');
  }
  if (distinct.length > bulkMaxDocuments) {
    throw badInput(`Tag at most ${bulkMaxDocuments} documents at a time.`);
  }
  const found = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.userId, userId), inArray(documents.id, distinct)));
  if (found.length !== distinct.length) {
    throw notFound(DOCUMENT_NOT_FOUND);
  }
  return distinct;
}

/**
 * Puts tags on documents. A tag a document already has stays as it is.
 *
 * @param db - The database, or a transaction.
 * @param userId - The owner of both, already checked.
 * @param documentIds - The documents.
 * @param tagIds - The tags.
 */
export async function addTags(
  db: DB,
  userId: string,
  documentIds: readonly string[],
  tagIds: readonly string[],
): Promise<void> {
  if (documentIds.length === 0 || tagIds.length === 0) {
    return;
  }
  const links = documentIds.flatMap((documentId) => tagIds.map((tagId) => ({ documentId, tagId, userId })));
  await db.insert(documentTags).values(links).onConflictDoNothing();
}

/**
 * Takes tags off documents. A tag a document does not have is no matter.
 *
 * @param db - The database, or a transaction.
 * @param userId - The owner of both.
 * @param documentIds - The documents.
 * @param tagIds - The tags.
 */
export async function removeTags(
  db: DB,
  userId: string,
  documentIds: readonly string[],
  tagIds: readonly string[],
): Promise<void> {
  if (documentIds.length === 0 || tagIds.length === 0) {
    return;
  }
  await db
    .delete(documentTags)
    .where(
      and(
        eq(documentTags.userId, userId),
        inArray(documentTags.documentId, [...documentIds]),
        inArray(documentTags.tagId, [...tagIds]),
      ),
    );
}

/**
 * Makes a document's tags exactly these.
 *
 * @param db - The database, or a transaction.
 * @param userId - The owner of both, already checked.
 * @param documentId - The document.
 * @param tagIds - Its tags from now on. None takes every tag off.
 */
export async function replaceTags(
  db: DB,
  userId: string,
  documentId: string,
  tagIds: readonly string[],
): Promise<void> {
  const ofDocument = and(eq(documentTags.userId, userId), eq(documentTags.documentId, documentId));
  await db
    .delete(documentTags)
    .where(tagIds.length === 0 ? ofDocument : and(ofDocument, notInArray(documentTags.tagId, [...tagIds])));
  await addTags(db, userId, [documentId], tagIds);
}

