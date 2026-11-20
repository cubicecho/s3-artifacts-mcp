import { randomUUID } from 'node:crypto';
import { type Document, DocumentStatus, documents } from '@cubicecho/s3-artifacts-mcp-db/schema';
import { and, eq } from 'drizzle-orm';
import type { Context } from '../core/context.ts';
import { conflict, ErrorCode, errorMessage, withCode } from '../core/errors.ts';
import { describeStorageError, type Storage } from '../storage/storage.ts';
import { bucketStorageFor } from './bucket-storage.ts';
import { objectKeyFor } from './keys.ts';
import { ownDocument } from './rows.ts';

// "Revoke all links" (D5): a share link is a signature over the object's key, which the bucket checks and this
// database cannot take back, so the only way to stop every link at once is to move the object. The order is copy,
// then point the row at the copy, then delete the old object:
//
// - Copy first, so the row never names a key with nothing at it. A failed copy changes nothing.
// - The row next. Until it moves, the old key is still the document; once it has, every link signed for the old key
//   reads as revoked, because its `object_key` no longer matches.
// - The old object last. Deleting it is what makes the old URLs answer 404. If that delete fails, the document is
//   whole at its new key and the re-key stands; the old object is logged, and its links keep working until they
//   expire. Deleting first would risk a document whose row names an object that is gone.

/**
 * Deletes an object a re-key no longer needs, logging rather than throwing when the bucket refuses.
 *
 * @param storage - The document's bucket.
 * @param document - The document, for the log.
 * @param key - The key to delete.
 * @param why - What the object was, for the log.
 */
async function deleteQuietly(storage: Storage, document: Document, key: string, why: string): Promise<void> {
  try {
    await storage.delete([key]);
  } catch (error) {
    console.error(`[documents] re-key of ${document.id}: could not delete ${why} at ${key}: ${errorMessage(error)}`);
  }
}

/**
 * Moves one of the caller's documents to a new key in its bucket, so every share link made for it stops working.
 *
 * @param ctx - The request.
 * @param id - The document's id, as sent.
 * @returns The document at its new key.
 * @throws NOT_FOUND for a document that is missing or someone else's; CONFLICT for one still uploading, or one
 *   re-keyed or deleted while this ran; BAD_USER_INPUT when the bucket's secret no longer decrypts; STORAGE_ERROR
 *   when the bucket refuses the copy, with nothing changed.
 */
export async function rekeyDocument(ctx: Context, id: string): Promise<Document> {
  const document = await ownDocument(ctx, id);
  if (document.status !== DocumentStatus.Ready) {
    throw conflict('The upload has not finished, so the document has no links to revoke yet.');
  }
  const storage = await bucketStorageFor(ctx, document.bucketId);
  const oldKey = document.objectKey;
  // A scanned file's key is wherever the owner put it; the new one is the app's own, at the bucket's top level.
  const newKey = objectKeyFor(randomUUID(), document.filename);

  try {
    await storage.copy(oldKey, newKey);
  } catch (error) {
    const { code } = describeStorageError(error);
    console.error(`[documents] re-key of ${document.id}: the copy failed: ${errorMessage(error)}`);
    throw withCode(
      `The bucket refused to copy the file${code === null ? '' : ` (${code})`}. Nothing was changed.`,
      ErrorCode.StorageError,
      { errorCode: code },
    );
  }

  const isStillAtOldKey = and(
    eq(documents.id, document.id),
    eq(documents.userId, document.userId),
    eq(documents.objectKey, oldKey),
  );
  let moved: Document[];
  try {
    moved = await ctx.db.update(documents).set({ objectKey: newKey }).where(isStillAtOldKey).returning();
  } catch (error) {
    await deleteQuietly(storage, document, newKey, 'the copy');
    throw error;
  }
  const [row] = moved;
  if (row === undefined) {
    await deleteQuietly(storage, document, newKey, 'the copy');
    throw conflict('The document changed while its links were being revoked. Try again.');
  }

  await deleteQuietly(storage, document, oldKey, 'the old object, whose links keep working until they expire,');
  return row;
}
