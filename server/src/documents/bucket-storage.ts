import type { Context } from '../core/context.ts';
import { badInput, ErrorCode, errorMessage } from '../core/errors.ts';
import { SecretUnreadableError } from '../core/secrets.ts';
import { HttpStatus } from '../core/wire.ts';
import { RouteError } from '../http/route-error.ts';
import type { StorageRegistry } from '../storage/registry.ts';
import type { Storage } from '../storage/storage.ts';

/** What the content routes answer when a bucket's secret no longer opens. */
export const SECRET_UNREADABLE_MESSAGE =
  "The bucket's stored secret can no longer be decrypted. Enter it again in Settings → Buckets.";

/**
 * Opens a document's bucket for one of the content routes.
 *
 * @param registry - Every bucket's storage.
 * @param bucketId - The document's bucket.
 * @returns Its storage.
 * @throws RouteError: BAD_USER_INPUT when the secret no longer decrypts, STORAGE_ERROR when the bucket cannot be
 *   built.
 */
export async function openBucketStorage(registry: StorageRegistry, bucketId: string): Promise<Storage> {
  try {
    return await registry.get(bucketId);
  } catch (error) {
    if (error instanceof SecretUnreadableError) {
      throw new RouteError(HttpStatus.BadRequest, ErrorCode.BadUserInput, SECRET_UNREADABLE_MESSAGE);
    }
    console.error(`[documents] could not open bucket ${bucketId}: ${errorMessage(error)}`);
    throw new RouteError(HttpStatus.BadGateway, ErrorCode.StorageError, 'The bucket cannot be reached.');
  }
}

/**
 * Opens a bucket for a resolver that reaches its objects: a delete, a re-key, a share link.
 *
 * @param ctx - The request, whose registry builds the storage.
 * @param bucketId - The bucket.
 * @returns Its storage.
 * @throws BAD_USER_INPUT when the bucket's secret no longer decrypts.
 */
export async function bucketStorageFor(ctx: Context, bucketId: string): Promise<Storage> {
  try {
    return await ctx.storage.get(bucketId);
  } catch (error) {
    if (error instanceof SecretUnreadableError) {
      throw badInput(SECRET_UNREADABLE_MESSAGE);
    }
    throw error;
  }
}
