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
// - The old object last. Deleting it is what makes the old URLs answer 404. If the bucket refuses that delete, the
//   old links still work, so the re-key is undone: the row goes back to the old key and the copy is deleted, and the
//   owner is told nothing was revoked. A link the app shows as revoked must really be dead. Deleting first would
//   risk a document whose row names an object that is gone.

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
 *   when the bucket refuses the copy or the old object's delete, with nothing changed.
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

  try {
    await storage.delete([oldKey]);
  } catch (error) {
    const { code } = describeStorageError(error);
    console.error(`[documents] re-key of ${document.id}: the old object's delete failed: ${errorMessage(error)}`);
    await undoMove(ctx, storage, document, newKey);
    throw withCode(
      `The bucket refused to delete the old file${code === null ? '' : ` (${code})`}, so its links could not be ` +
        'revoked. Nothing was changed.',
      ErrorCode.StorageError,
      { errorCode: code },
    );
  }
  return row;
}

/**
 * Puts a document back at its old key after the old object would not be deleted, and drops the copy, so the links
 * signed for the old key read as active again, which they are.
 *
 * @param ctx - The request.
 * @param storage - The document's bucket.
 * @param document - The document as it was, at its old key.
 * @param newKey - The key it was moved to.
 */
async function undoMove(ctx: Context, storage: Storage, document: Document, newKey: string): Promise<void> {
  try {
    const restored = await ctx.db
      .update(documents)
      .set({ objectKey: document.objectKey })
      .where(and(eq(documents.id, document.id), eq(documents.objectKey, newKey)))
      .returning({ id: documents.id });
    if (restored.length === 0) {
      // Changed again meanwhile (deleted, or re-keyed by another request): the copy may be what it names now.
      return;
    }
  } catch (error) {
    console.error(`[documents] re-key of ${document.id}: could not move the row back: ${errorMessage(error)}`);
    return;
  }
  await deleteQuietly(storage, document, newKey, 'the copy');
}
