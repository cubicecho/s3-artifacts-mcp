import type { DB } from '@cubicecho/s3-artifacts-mcp-db';
import { type Document, DocumentStatus, documents } from '@cubicecho/s3-artifacts-mcp-db/schema';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Context } from '../core/context.ts';
import { notFound, requireAuth } from '../core/errors.ts';

// Reading one document row, as every path that names a document by id does: the resolvers, the
// two content routes and the sweeper. An id that is not a UUID names nothing, exactly as a
// missing id does, so callers answer both with the same NOT_FOUND.

/** The message for a document that does not exist or is not the caller's, which the caller may not tell apart. */
export const DOCUMENT_NOT_FOUND = 'Document not found.';

const idSchema = z.uuid();

/**
 * Reads a document id from wherever it was sent.
 *
 * @param id - The id as sent.
 * @returns The id, or null when it is not a UUID and so cannot name a row.
 */
export function parseDocumentId(id: unknown): string | null {
  const parsed = idSchema.safeParse(id);
  return parsed.success ? parsed.data : null;
}

/**
 * Loads one of a user's documents.
 *
 * @param db - The database.
 * @param userId - Whose it must be.
 * @param id - The id as sent.
 * @returns The row, or null when the id is malformed, missing or someone else's.
 */
export async function findOwnedDocument(db: DB, userId: string, id: unknown): Promise<Document | null> {
  const documentId = parseDocumentId(id);
  if (documentId === null) {
    return null;
  }
  const [row] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.userId, userId)));
  return row ?? null;
}

/**
 * Loads one of the caller's documents, for a resolver.
 *
 * @param ctx - The request.
 * @param id - The document's id, as sent.
 * @returns The row.
 * @throws NOT_FOUND when it is malformed, missing or not the caller's.
 */
export async function ownDocument(ctx: Context, id: unknown): Promise<Document> {
  const row = await findOwnedDocument(ctx.db, requireAuth(ctx), id);
  if (row === null) {
    throw notFound(DOCUMENT_NOT_FOUND);
  }
  return row;
}

/**
 * Loads a document whose bytes are in its bucket, whoever owns it. Only for a caller that holds its own proof
 * of access to this document, as a signed content URL is.
 *
 * @param db - The database.
 * @param id - The id as sent.
 * @returns The row, or null when the id is malformed, missing or not ready.
 */
export async function findReadyDocument(db: DB, id: unknown): Promise<Document | null> {
  const documentId = parseDocumentId(id);
  if (documentId === null) {
    return null;
  }
  const [row] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.status, DocumentStatus.Ready)));
  return row ?? null;
}

/**
 * Makes a pending document `ready` once its bytes are in its bucket, in one statement guarded on `pending_upload`.
 *
 * @param db - The database.
 * @param id - The document.
 * @param sha256 - The hex SHA-256 of the bytes stored.
 * @returns Whether it was pending and is ready now. False when it was deleted meanwhile, or already ready.
 */
export async function markReady(db: DB, id: string, sha256: string): Promise<boolean> {
  const updated = await db
    .update(documents)
    .set({ sha256, status: DocumentStatus.Ready })
    .where(and(eq(documents.id, id), eq(documents.status, DocumentStatus.PendingUpload)))
    .returning({ id: documents.id });
  return updated.length > 0;
}

/**
 * Restarts the sweeper's clock on a pending document, which counts from the row's last change, before a long step.
 *
 * @param db - The database.
 * @param id - The document.
 * @returns Whether it is still pending, so the step may go on.
 */
export async function claimPending(db: DB, id: string): Promise<boolean> {
  const claimed = await db
    .update(documents)
    .set({ updatedAt: new Date() })
    .where(and(eq(documents.id, id), eq(documents.status, DocumentStatus.PendingUpload)))
    .returning({ id: documents.id });
  return claimed.length > 0;
}

/**
 * Deletes a document's row while it is still waiting for its bytes. A row that became ready in the meantime
 * is left alone.
 *
 * @param db - The database.
 * @param id - The document.
 * @returns Whether a row was deleted.
 */
export async function deletePendingRow(db: DB, id: string): Promise<boolean> {
  const deleted = await db
    .delete(documents)
    .where(and(eq(documents.id, id), eq(documents.status, DocumentStatus.PendingUpload)))
    .returning({ id: documents.id });
  return deleted.length > 0;
}
