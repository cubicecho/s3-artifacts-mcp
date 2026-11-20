import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DB } from '@cubicecho/s3-artifacts-mcp-db';
import type { Document } from '@cubicecho/s3-artifacts-mcp-db/schema';
import { DocumentStatus } from '@cubicecho/s3-artifacts-mcp-db/schema';
import type { Request, Response } from 'express';
import { ErrorCode, errorMessage } from '../core/errors.ts';
import type { SecretBox } from '../core/secrets.ts';
import { HttpStatus } from '../core/wire.ts';
import { RouteError, sendRouteError } from '../http/route-error.ts';
import type { StorageRegistry } from '../storage/registry.ts';
import { type ByteRange, contentDisposition, Disposition, describeStorageError } from '../storage/storage.ts';
import { openBucketStorage } from './bucket-storage.ts';
import { DOWNLOAD_ON, DOWNLOAD_PARAM, isValidContentToken } from './content-url.ts';
import { DOCUMENT_NOT_FOUND, findOwnedDocument, findReadyDocument } from './rows.ts';

// `GET /api/documents/:id/content[?download=1]`: a ready document's bytes, streamed from its bucket
// through the server (D4). It honours a single `Range`, so PDFs and video can seek.
//
// The bytes are served from the app's own origin, so a document must never be able to act as the
// app: every answer is `nosniff`, and anything but a passive type (images, audio, video, PDF, plain
// text) is sandboxed, so an uploaded HTML or SVG file renders without script and in an opaque origin.

/** Types a browser only displays, which may be shown inline without a sandbox. SVG is not one: it can script. */
const PASSIVE_TYPE =
  /^(?:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)|audio\/[\w.+-]+|video\/[\w.+-]+|application\/pdf|text\/plain)$/;
/**
 * The policy for everything else: no script, an opaque origin, nothing fetched from anywhere, and only what an
 * HTML page needs to show itself (inline styles, data: images and fonts).
 */
export const SANDBOX_POLICY =
  "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src data:; font-src data:";
/** A single byte range, `bytes=<first>-<last>`, either end of which may be missing. */
const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;
/** The only range unit there is. */
const RANGE_UNIT = 'bytes';
/** The S3 code, and the bare status name, for a key with nothing at it. */
const MISSING_OBJECT_CODES = new Set(['NoSuchKey', 'NotFound', 'HTTP_404']);
/** What a stream that ended because the client went away fails with. */
const PREMATURE_CLOSE = 'ERR_STREAM_PREMATURE_CLOSE';
const HEAD = 'HEAD';

/** How a request's `Range` header is answered. */
export const RangeKind = {
  /** No usable range: the whole object, 200. A header that cannot be read, or several ranges, is ignored. */
  Whole: 'whole',
  /** One range inside the object: 206. */
  Part: 'part',
  /** A range that starts past the end: 416. */
  Unsatisfiable: 'unsatisfiable',
} as const;
/** One of the kinds in `RangeKind`. */
export type RangeKind = (typeof RangeKind)[keyof typeof RangeKind];

/** What `parseRange` makes of a header. */
export type RangeRequest =
  | { kind: typeof RangeKind.Whole }
  | { kind: typeof RangeKind.Part; range: ByteRange }
  | { kind: typeof RangeKind.Unsatisfiable };

/** Who may read the document: its owner's session, or a signed URL. */
export type ContentAccess = { userId: string } | { token: string };

/** What the download route is built from. */
export interface DownloadRouteDeps {
  db: DB;
  /** Every bucket's storage. */
  storage: StorageRegistry;
  /** Checks a signed URL's token. */
  secrets: SecretBox;
}

/**
 * Reads a `Range` header against an object's size (RFC 9110, section 14).
 *
 * @param header - The header as sent, or undefined.
 * @param size - The object's size in bytes.
 * @returns The whole object, one range clipped to the object, or unsatisfiable.
 */
export function parseRange(header: string | undefined, size: number): RangeRequest {
  const match = header === undefined ? null : SINGLE_RANGE.exec(header.trim());
  if (match === null) {
    return { kind: RangeKind.Whole };
  }
  const [, firstText, lastText] = match;
  const isSuffix = firstText === '';
  if (isSuffix) {
    const length = Number(lastText);
    if (lastText === '') {
      return { kind: RangeKind.Whole };
    }
    if (length === 0) {
      return { kind: RangeKind.Unsatisfiable };
    }
    return { kind: RangeKind.Part, range: { first: Math.max(size - length, 0), last: size - 1 } };
  }
  const first = Number(firstText);
  const isOpenEnded = lastText === '';
  const last = isOpenEnded ? size - 1 : Number(lastText);
  const isBackwards = isOpenEnded === false && last < first;
  if (isBackwards) {
    return { kind: RangeKind.Whole };
  }
  if (first >= size) {
    return { kind: RangeKind.Unsatisfiable };
  }
  return { kind: RangeKind.Part, range: { first, last: Math.min(last, size - 1) } };
}

/**
 * The headers every answer with a document's bytes carries.
 *
 * @param document - The document.
 * @param download - Whether it is sent as an attachment.
 * @returns The headers.
 */
export function contentHeaders(document: Document, download: boolean): Record<string, string> {
  const essence = document.contentType.split(';')[0].trim().toLowerCase();
  const isPassiveInline = download === false && PASSIVE_TYPE.test(essence);
  const disposition = download ? Disposition.Attachment : Disposition.Inline;
  return {
    'content-type': document.contentType,
    'content-disposition': contentDisposition(document.filename, disposition),
    'accept-ranges': RANGE_UNIT,
    'x-content-type-options': 'nosniff',
    // Revalidated each time: the URL may carry a token, and the bytes are the owner's alone.
    'cache-control': 'private, no-cache',
    // A signed URL is a credential until it expires; a sandboxed page's links must not carry it away.
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    ...(isPassiveInline ? {} : { 'content-security-policy': SANDBOX_POLICY }),
  };
}

/**
 * Sets a status and headers exactly as given. Express's `res.set` would add a charset to a text type the
 * document was not stored with.
 *
 * @param res - The response.
 * @param status - The status.
 * @param headers - The headers.
 */
function writeHeaders(res: Response, status: number, headers: Record<string, string>): void {
  res.status(status);
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
}

/**
 * Builds the handler for a document's bytes.
 *
 * @param deps - The database, the storage registry and the secret box.
 * @returns A handler taking the request, the response, and how the caller may read: the session's user, read by
 *   the route, or the URL's token. It answers every outcome itself.
 */
export function createDownloadHandler({ db, storage: registry, secrets }: DownloadRouteDeps) {
  /**
   * Finds the document the caller may read.
   *
   * @param id - The id in the path.
   * @param access - The session's user, or the URL's token.
   * @param download - Whether an attachment is asked for, which a token must have been signed for.
   * @returns The ready document.
   * @throws RouteError NOT_FOUND for a document that is missing, not ready, not the caller's, or whose token is
   *   wrong, stale or expired: none of these confirms that it exists.
   */
  const readable = async (id: unknown, access: ContentAccess, download: boolean): Promise<Document> => {
    const notFound = new RouteError(HttpStatus.NotFound, ErrorCode.NotFound, DOCUMENT_NOT_FOUND);
    if ('token' in access) {
      const document = await findReadyDocument(db, id);
      const isValid = document !== null && isValidContentToken(secrets, document, access.token, download);
      if (isValid) {
        return document;
      }
      throw notFound;
    }
    const document = await findOwnedDocument(db, access.userId, id);
    if (document === null || document.status !== DocumentStatus.Ready) {
      throw notFound;
    }
    return document;
  };

  /**
   * Opens the object, or the part of it asked for.
   *
   * @param document - The document.
   * @param range - The part, or undefined for all of it.
   * @returns The bytes.
   * @throws RouteError NOT_FOUND when the object is gone from the bucket, STORAGE_ERROR when the bucket fails.
   */
  const open = async (document: Document, range: ByteRange | undefined): Promise<Readable> => {
    const storage = await openBucketStorage(registry, document.bucketId);
    try {
      return await storage.getStream(document.objectKey, range);
    } catch (error) {
      const { code } = describeStorageError(error);
      if (code !== null && MISSING_OBJECT_CODES.has(code)) {
        throw new RouteError(HttpStatus.NotFound, ErrorCode.NotFound, 'The file is missing from its bucket.');
      }
      console.error(`[download] ${document.id} failed: ${errorMessage(error)}`);
      throw new RouteError(HttpStatus.BadGateway, ErrorCode.StorageError, 'The bucket could not be read.');
    }
  };

  return async (req: Request, res: Response, access: ContentAccess): Promise<void> => {
    const download = req.query[DOWNLOAD_PARAM] === DOWNLOAD_ON;
    let document: Document;
    try {
      document = await readable(req.params.id, access, download);
    } catch (error) {
      if (error instanceof RouteError) {
        sendRouteError(res, error);
        return;
      }
      throw error;
    }
    const { size } = document;
    const headers = contentHeaders(document, download);
    const requested = parseRange(req.headers.range, size);
    if (requested.kind === RangeKind.Unsatisfiable) {
      const refusal = new RouteError(
        HttpStatus.RangeNotSatisfiable,
        ErrorCode.BadUserInput,
        `The range starts past the end of the ${size}-byte file.`,
      );
      sendRouteError(res, refusal, { 'content-range': `${RANGE_UNIT} */${size}` });
      return;
    }
    const range = requested.kind === RangeKind.Part ? requested.range : undefined;
    const partHeaders: Record<string, string> =
      range === undefined
        ? { 'content-length': String(size) }
        : {
            'content-length': String(range.last - range.first + 1),
            'content-range': `${RANGE_UNIT} ${range.first}-${range.last}/${size}`,
          };
    const status = range === undefined ? HttpStatus.Ok : HttpStatus.PartialContent;
    if (req.method === HEAD) {
      writeHeaders(res, status, { ...headers, ...partHeaders });
      res.end();
      return;
    }
    let body: Readable;
    try {
      body = await open(document, range);
    } catch (error) {
      if (error instanceof RouteError) {
        sendRouteError(res, error);
        return;
      }
      throw error;
    }
    writeHeaders(res, status, { ...headers, ...partHeaders });
    try {
      await pipeline(body, res);
    } catch (error) {
      const isClientGone = error instanceof Error && 'code' in error && error.code === PREMATURE_CLOSE;
      if (isClientGone === false) {
        console.error(`[download] ${document.id} broke off: ${errorMessage(error)}`);
      }
      res.destroy();
    }
  };
}
