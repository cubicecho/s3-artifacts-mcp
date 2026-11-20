import { createHash } from 'node:crypto';
import { type Bucket, type Document, DocumentStatus } from '@cubicecho/s3-artifacts-mcp-db/schema';
import { describeBytes } from '../app-settings/app-settings.ts';
import type { Context } from '../core/context.ts';
import { MCP_DEFAULTS } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import { MS_PER_SECOND, SECONDS_PER_MINUTE } from '../core/wire.ts';
import { bucketStorageFor } from '../documents/bucket-storage.ts';
import { createPendingDocument } from '../documents/create.ts';
import { claimPending, deletePendingRow, markReady } from '../documents/rows.ts';
import { describeStorageError, type Storage } from '../storage/storage.ts';
import { bucketDocument, NO_SUCH_DOCUMENT } from './access.ts';
import { utf8ContentType } from './content-types.ts';

// The two ways an agent puts a file in its bucket. Text it wrote itself comes inline (`upload_document`), and is
// stored in one PUT by the server. A file on its disk goes straight to the bucket: `create_upload` makes the pending
// row and hands out a presigned PUT, the agent's shell sends the file, and `complete_upload` checks what arrived,
// hashes it and makes the document ready. A `create_upload` that is never completed is a pending row like any other,
// so the sweeper drops it, and any object that reached its key, after `UPLOAD_DEFAULTS.pendingTtlMinutes`.

const SHA256 = 'sha256';
const HEX = 'hex';
/** What a shell's single quotes cannot hold, which a quoted word closes, escapes and reopens around. */
const SINGLE_QUOTE = /'/g;
/** Stands for the file in the `curl` command, for the agent to replace. */
export const FILE_PLACEHOLDER = 'PATH_TO_FILE';

const { inlineUploadBytes, uploadUrlTtlMinutes, maxPresignedPutBytes } = MCP_DEFAULTS;

/** What `upload_document` stores. */
export interface TextUpload {
  filename: string;
  contentType: string;
  text: string;
}

/** What `create_upload` is told about the file to come. */
export interface FileUpload {
  filename: string;
  contentType: string;
  /** Its length in bytes, which the PUT must send exactly. */
  size: number;
}

/** A presigned PUT handed to an agent, and how to use it. */
export interface StartedUpload {
  document: Document;
  uploadUrl: string;
  expiresAt: Date;
  /** The headers the PUT must send. Its length is the size declared, which curl and fetch send by themselves. */
  headers: Record<string, string>;
  /** The whole command, with `FILE_PLACEHOLDER` for the file's path. */
  curl: string;
}

/**
 * Quotes a word for a POSIX shell.
 *
 * @param word - Anything.
 * @returns It in single quotes, with any single quote in it escaped.
 */
function shellQuote(word: string): string {
  return `'${word.replace(SINGLE_QUOTE, `'\\''`)}'`;
}

/**
 * An error saying what the bucket refused, with its code when it gave one.
 *
 * @param what - What could not be done.
 * @param error - What the storage call threw.
 * @returns The error to throw.
 */
function storageFailure(what: string, error: unknown): Error {
  const { code } = describeStorageError(error);
  return new Error(`${what}${code === null ? '' : ` (${code})`}. Try again.`);
}

/**
 * Removes what an upload that failed left: any object at its key, and its row while it is still pending.
 *
 * @param ctx - The call.
 * @param document - The pending document.
 * @param storage - Its bucket.
 */
async function discard(ctx: Context, document: Document, storage: Storage): Promise<void> {
  try {
    await storage.delete([document.objectKey]);
  } catch (error) {
    console.error(`[mcp] could not delete the object of ${document.id}: ${errorMessage(error)}`);
  }
  await deletePendingRow(ctx.db, document.id);
}

/**
 * Stores text the agent wrote as a new document, ready at once.
 *
 * @param ctx - The call, as the key's owner.
 * @param bucket - The endpoint's bucket, already found writable.
 * @param upload - The filename, type and text.
 * @returns The ready document.
 * @throws When the text is empty or past `MCP_DEFAULTS.inlineUploadBytes`, the filename or type is refused, or the
 *   bucket refuses the PUT.
 */
export async function uploadText(ctx: Context, bucket: Bucket, upload: TextUpload): Promise<Document> {
  const body = Buffer.from(upload.text, 'utf8');
  if (body.length > inlineUploadBytes) {
    throw new Error(
      `The text is ${body.length} bytes of UTF-8; upload_document takes at most ${inlineUploadBytes} (${describeBytes(inlineUploadBytes)}). ` +
        'Write it to a file and send it with create_upload instead.',
    );
  }
  const document = await createPendingDocument(ctx, {
    bucketId: bucket.id,
    filename: upload.filename,
    contentType: utf8ContentType(upload.contentType.trim()),
    size: body.length,
  });
  const storage = await bucketStorageFor(ctx, bucket.id);
  try {
    await storage.upload(document.objectKey, body, { contentType: document.contentType, size: body.length });
  } catch (error) {
    console.error(`[mcp] upload of ${document.id} failed: ${errorMessage(error)}`);
    await discard(ctx, document, storage);
    throw storageFailure('The bucket refused the upload', error);
  }
  const sha256 = createHash(SHA256).update(body).digest(HEX);
  return finish(ctx, bucket, document, storage, sha256);
}

/**
 * What became of an upload that is no longer pending: finished by a call that ran alongside, or removed.
 *
 * @param ctx - The call.
 * @param bucket - The endpoint's bucket.
 * @param id - The document.
 * @returns The document, when another call made it ready.
 * @throws When it is gone: deleted by the owner, or dropped by the sweeper.
 */
async function readyOrGone(ctx: Context, bucket: Bucket, id: string): Promise<Document> {
  const now = await bucketDocument(ctx.db, bucket, id);
  if (now?.status === DocumentStatus.Ready) {
    return now;
  }
  throw new Error('The upload was removed before it finished. Start it again.');
}

/**
 * Makes an uploaded document ready, or cleans up when it went away meanwhile.
 *
 * @param ctx - The call.
 * @param bucket - The endpoint's bucket.
 * @param document - The pending document, whose bytes are in the bucket.
 * @param storage - Its bucket's storage.
 * @param sha256 - The bytes' hash, in hex.
 * @returns The ready document.
 * @throws When the row was deleted while the bytes were on their way, whose object is then deleted too.
 */
async function finish(
  ctx: Context,
  bucket: Bucket,
  document: Document,
  storage: Storage,
  sha256: string,
): Promise<Document> {
  const isReady = await markReady(ctx.db, document.id, sha256);
  if (isReady) {
    return { ...document, sha256, status: DocumentStatus.Ready };
  }
  try {
    return await readyOrGone(ctx, bucket, document.id);
  } catch (error) {
    await storage.delete([document.objectKey]).catch(() => undefined);
    throw error;
  }
}

/**
 * Starts an upload the agent's shell sends straight to the bucket: a pending row and a presigned PUT for it.
 *
 * @param ctx - The call, as the key's owner.
 * @param bucket - The endpoint's bucket, already found writable.
 * @param upload - The filename, type and size of the file to come.
 * @param [now] - The moment the URL is signed, from which it expires.
 * @returns The document and the URL, with the headers and the curl command that send to it.
 * @throws When the size is past the owner's upload limit or a single PUT's, the filename or type is refused, or the
 *   URL cannot be signed.
 */
export async function startUpload(
  ctx: Context,
  bucket: Bucket,
  upload: FileUpload,
  now: Date = new Date(),
): Promise<StartedUpload> {
  if (upload.size > maxPresignedPutBytes) {
    throw new Error(
      `create_upload sends one PUT, which carries at most ${describeBytes(maxPresignedPutBytes)}. ` +
        'Ask the owner to upload a larger file in the app.',
    );
  }
  const document = await createPendingDocument(ctx, { bucketId: bucket.id, ...upload });
  const storage = await bucketStorageFor(ctx, bucket.id);
  const expiresInSeconds = uploadUrlTtlMinutes * SECONDS_PER_MINUTE;
  let uploadUrl: string;
  try {
    uploadUrl = await storage.presignPut(document.objectKey, {
      contentType: document.contentType,
      size: document.size,
      expiresInSeconds,
    });
  } catch (error) {
    console.error(`[mcp] could not sign an upload for ${document.id}: ${errorMessage(error)}`);
    await deletePendingRow(ctx.db, document.id);
    throw storageFailure('The upload URL could not be signed', error);
  }
  const headers = { 'Content-Type': document.contentType };
  const curl = `curl --fail-with-body -T ${FILE_PLACEHOLDER} -H ${shellQuote(`Content-Type: ${document.contentType}`)} ${shellQuote(uploadUrl)}`;
  return {
    document,
    uploadUrl,
    expiresAt: new Date(now.getTime() + expiresInSeconds * MS_PER_SECOND),
    headers,
    curl,
  };
}

/**
 * Hashes and counts an object's bytes, reading it once.
 *
 * @param storage - Its bucket.
 * @param key - Its key.
 * @returns How many bytes it has and their SHA-256, in hex.
 */
async function measure(storage: Storage, key: string): Promise<{ size: number; sha256: string }> {
  const hash = createHash(SHA256);
  let size = 0;
  for await (const chunk of await storage.getStream(key)) {
    const bytes: Buffer = chunk;
    size += bytes.length;
    hash.update(bytes);
  }
  return { size, sha256: hash.digest(HEX) };
}

/**
 * Finishes an upload started with `startUpload`, once the agent has sent the file. Calling it again on a document
 * that is ready already answers it again.
 *
 * @param ctx - The call, as the key's owner.
 * @param bucket - The endpoint's bucket, already found writable.
 * @param documentId - The id `startUpload` gave, as the agent sent it.
 * @returns The ready document.
 * @throws When no such upload is in the bucket, nothing has arrived at its key yet, or what arrived is not the size
 *   declared, in which case the object and the row are removed and the upload starts again.
 */
export async function completeUpload(ctx: Context, bucket: Bucket, documentId: unknown): Promise<Document> {
  const document = await bucketDocument(ctx.db, bucket, documentId);
  if (document === null) {
    throw new Error(NO_SUCH_DOCUMENT);
  }
  if (document.status === DocumentStatus.Ready) {
    return document;
  }
  const storage = await bucketStorageFor(ctx, bucket.id);
  const head = await storage.head(document.objectKey).catch((error: unknown) => {
    throw storageFailure('The bucket could not be asked for the file', error);
  });
  if (head === null) {
    throw new Error(
      'Nothing has arrived at the upload URL yet. Send the file with the curl command create_upload gave, then call ' +
        'complete_upload again. If the URL has expired, start again with create_upload.',
    );
  }
  const mismatch = (size: number): Error =>
    new Error(
      `The bucket holds ${size} bytes, but the upload was started for ${document.size}. It has been removed; ` +
        'start again with create_upload and the file’s exact size.',
    );
  if (head.size !== document.size) {
    await discard(ctx, document, storage);
    throw mismatch(head.size);
  }
  // Reading a large file takes a while; the sweeper's clock restarts so it does not drop the row meanwhile.
  const isClaimed = await claimPending(ctx.db, document.id);
  if (isClaimed === false) {
    return readyOrGone(ctx, bucket, document.id);
  }
  const measured = await measure(storage, document.objectKey).catch((error: unknown) => {
    throw storageFailure('The file could not be read back from the bucket', error);
  });
  if (measured.size !== document.size) {
    await discard(ctx, document, storage);
    throw mismatch(measured.size);
  }
  return finish(ctx, bucket, document, storage, measured.sha256);
}
