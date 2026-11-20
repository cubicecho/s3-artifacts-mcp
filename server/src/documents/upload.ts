import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import type { DB } from '@cubicecho/s3-artifacts-mcp-db';
import { type Document, DocumentStatus } from '@cubicecho/s3-artifacts-mcp-db/schema';
import type { Request, Response } from 'express';
import { describeBytes, readAppSettings, uploadLimitOf } from '../app-settings/app-settings.ts';
import { ErrorCode, errorMessage } from '../core/errors.ts';
import { HttpStatus } from '../core/wire.ts';
import { RouteError, sendRouteError } from '../http/route-error.ts';
import type { StorageRegistry } from '../storage/registry.ts';
import { describeStorageError, type Storage } from '../storage/storage.ts';
import { openBucketStorage } from './bucket-storage.ts';
import { claimPending, DOCUMENT_NOT_FOUND, deletePendingRow, findOwnedDocument, markReady } from './rows.ts';

// `PUT /api/documents/:id/content`: a pending document's bytes, streamed from the browser through
// the server into its bucket (D4), hashed and counted on the way. The body must be exactly the
// size `createDocumentUpload` declared. Success makes the document `ready`; any failure, a client
// that goes away included, leaves nothing behind: the multipart upload is aborted, any object is
// deleted and the row is removed. The upload is one attempt, and a new one starts from
// `createDocumentUpload` again.

const SHA256 = 'sha256';
/**
 * Sent with every refusal: the body may still be arriving, and the connection cannot be reused until it has, so
 * it is closed after the answer instead.
 */
export const CLOSE_CONNECTION: Readonly<Record<string, string>> = Object.freeze({ connection: 'close' });
const HEX = 'hex';

/** What the upload route answers with once the document is ready. */
export interface UploadedDocument {
  id: string;
  status: DocumentStatus;
  size: number;
  sha256: string;
}

/** What the upload route is built from. */
export interface UploadRouteDeps {
  db: DB;
  /** Every bucket's storage. */
  storage: StorageRegistry;
}

/** Counts and hashes a body as it passes, and fails it at the first byte past its size or at a short end. */
interface Meter {
  stream: Transform;
  /** Why the body was refused, once it has been. */
  failure: () => RouteError | null;
  /** The SHA-256 of what passed, in hex. Read once, after the body ended. */
  sha256: () => string;
}

/**
 * Builds the meter a body is piped through on its way to the bucket.
 *
 * @param expected - The size declared, in bytes.
 * @returns The meter.
 */
function createMeter(expected: number): Meter {
  const hash = createHash(SHA256);
  let received = 0;
  let failure: RouteError | null = null;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > expected) {
        failure = new RouteError(
          HttpStatus.PayloadTooLarge,
          ErrorCode.BadUserInput,
          `The body is longer than the ${expected} bytes declared.`,
        );
        callback(failure);
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      if (received < expected) {
        failure = new RouteError(
          HttpStatus.BadRequest,
          ErrorCode.BadUserInput,
          `The body ended after ${received} of the ${expected} bytes declared.`,
        );
        callback(failure);
        return;
      }
      callback();
    },
  });
  return { stream, failure: () => failure, sha256: () => hash.digest(HEX) };
}

/**
 * Reads the length a request declares.
 *
 * @param req - The request.
 * @returns The `Content-Length`, or null when it sent none (a chunked body).
 */
function declaredLength(req: Request): number | null {
  const header = req.headers['content-length'];
  return header === undefined ? null : Number(header);
}

/**
 * Builds the handler for a pending document's bytes.
 *
 * @param deps - The database and the storage registry.
 * @returns A handler taking the request, the response and the caller, whom the route has already read from the
 *   session. It answers every outcome itself.
 */
export function createUploadHandler({ db, storage: registry }: UploadRouteDeps) {
  // One upload per document at a time. A second PUT while one runs would write the same key, and its
  // failure would delete the first one's row.
  const inFlight = new Set<string>();

  /**
   * Streams the body into the bucket and marks the document ready.
   *
   * @param req - The request, whose body is the file.
   * @param document - The pending document, claimed by this request.
   * @param signal - Aborts when the client goes away.
   * @param meter - What the body passes through.
   * @param storage - The document's bucket.
   * @returns The ready document.
   * @throws RouteError for a body of the wrong length, a bucket that lost the file, or a row removed meanwhile.
   */
  const store = async (
    req: Request,
    document: Document,
    signal: AbortSignal,
    meter: Meter,
    storage: Storage,
  ): Promise<UploadedDocument> => {
    const { objectKey, size, contentType } = document;
    req.pipe(meter.stream);
    await storage.uploadStream(objectKey, meter.stream, { contentType, size, signal });
    const head = await storage.head(objectKey);
    const isStoredWhole = head !== null && head.size === size;
    if (isStoredWhole === false) {
      throw new RouteError(
        HttpStatus.BadGateway,
        ErrorCode.StorageError,
        `The bucket does not hold the ${size} bytes sent. Try the upload again.`,
      );
    }
    const sha256 = meter.sha256();
    const isReady = await markReady(db, document.id, sha256);
    if (isReady === false) {
      // Deleted while it was uploading, by its owner or by the sweeper. The object goes too.
      throw new RouteError(HttpStatus.NotFound, ErrorCode.NotFound, DOCUMENT_NOT_FOUND);
    }
    return { id: document.id, status: DocumentStatus.Ready, size, sha256 };
  };

  /**
   * Removes what a failed upload left: any object at the key, and the row.
   *
   * @param document - The document.
   * @param storage - Its bucket, or null when it could not be opened.
   */
  const discard = async (document: Document, storage: Storage | null): Promise<void> => {
    if (storage !== null) {
      try {
        await storage.delete([document.objectKey]);
      } catch (error) {
        console.error(`[upload] could not delete the object of ${document.id}: ${errorMessage(error)}`);
      }
    }
    await deletePendingRow(db, document.id);
  };

  return async (req: Request, res: Response, userId: string): Promise<void> => {
    const document = await findOwnedDocument(db, userId, req.params.id);
    if (document === null) {
      sendRouteError(
        res,
        new RouteError(HttpStatus.NotFound, ErrorCode.NotFound, DOCUMENT_NOT_FOUND),
        CLOSE_CONNECTION,
      );
      return;
    }
    if (document.status === DocumentStatus.Ready) {
      const refusal = 'The document has its bytes already. Start a new upload to send another file.';
      sendRouteError(res, new RouteError(HttpStatus.Conflict, ErrorCode.Conflict, refusal), CLOSE_CONNECTION);
      return;
    }
    // The limit may have been lowered since the upload started; it is the owner's to say.
    const limit = uploadLimitOf(await readAppSettings(db, userId));
    if (document.size > limit) {
      await deletePendingRow(db, document.id);
      const refusal = `The file is larger than the ${describeBytes(limit)} upload limit.`;
      sendRouteError(
        res,
        new RouteError(HttpStatus.PayloadTooLarge, ErrorCode.BadUserInput, refusal),
        CLOSE_CONNECTION,
      );
      return;
    }
    if (inFlight.has(document.id)) {
      const refusal = 'An upload of this document is already running.';
      sendRouteError(res, new RouteError(HttpStatus.Conflict, ErrorCode.Conflict, refusal), CLOSE_CONNECTION);
      return;
    }

    inFlight.add(document.id);
    const aborter = new AbortController();
    const meter = createMeter(document.size);
    let storage: Storage | null = null;
    const onClose = (): void => {
      // `close` also follows a body that arrived whole; only an incomplete one means the client went away.
      if (req.complete === false) {
        aborter.abort(new Error('The client went away before the body ended.'));
      }
    };
    req.once('close', onClose);
    // An IncomingMessage that is torn down emits `error`, which would crash the process with no listener.
    req.on('error', (error) => aborter.abort(error));
    try {
      const length = declaredLength(req);
      const isWrongLength = length !== null && length !== document.size;
      if (isWrongLength) {
        throw new RouteError(
          HttpStatus.BadRequest,
          ErrorCode.BadUserInput,
          `The request declares ${length} bytes, but the upload was started for ${document.size}.`,
        );
      }
      const isClaimed = await claimPending(db, document.id);
      if (isClaimed === false) {
        throw new RouteError(HttpStatus.NotFound, ErrorCode.NotFound, DOCUMENT_NOT_FOUND);
      }
      storage = await openBucketStorage(registry, document.bucketId);
      res.json(await store(req, document, aborter.signal, meter, storage));
    } catch (error) {
      await discard(document, storage);
      if (aborter.signal.aborted) {
        console.warn(`[upload] ${document.id}: the client went away; the upload was discarded`);
        return;
      }
      // The rest of a body that was refused part way is read and dropped, so the answer can reach the client.
      req.unpipe(meter.stream);
      req.resume();
      const refusal = meter.failure() ?? (error instanceof RouteError ? error : null);
      if (refusal !== null) {
        sendRouteError(res, refusal, CLOSE_CONNECTION);
        return;
      }
      const { code } = describeStorageError(error);
      console.error(`[upload] ${document.id} failed: ${errorMessage(error)}`);
      const message = `The bucket refused the upload${code === null ? '' : ` (${code})`}. Try again.`;
      sendRouteError(res, new RouteError(HttpStatus.BadGateway, ErrorCode.StorageError, message), CLOSE_CONNECTION);
    } finally {
      req.off('close', onClose);
      inFlight.delete(document.id);
    }
  };
}
