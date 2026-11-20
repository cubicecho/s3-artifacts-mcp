import type { Readable } from 'node:stream';
import type { Bucket } from '@cubicecho/s3-artifacts-mcp-db/schema';

/** Part of an object, by byte offsets from its start, both inclusive, as an HTTP `Range` counts them. */
export interface ByteRange {
  first: number;
  last: number;
}

/** What a stored object is, without its bytes. */
export interface ObjectHead {
  size: number;
  contentType: string | null;
}

/** One object a listing found. */
export interface ListedObject {
  key: string;
  size: number;
}

/** How a browser should treat the object a presigned GET opens. */
export const Disposition = {
  Inline: 'inline',
  Attachment: 'attachment',
} as const;
/** One of the dispositions in `Disposition`. */
export type Disposition = (typeof Disposition)[keyof typeof Disposition];

/** What a presigned GET is signed with. */
export interface PresignGetOptions {
  /** The name the browser saves the object as. */
  filename: string;
  /** The type the bucket answers with, whatever the object was stored as. */
  contentType: string;
  disposition: Disposition;
  /** How long the URL works. */
  expiresInSeconds: number;
}

/** What a presigned PUT is signed with. The uploader must send exactly this type and length. */
export interface PresignPutOptions {
  /** The `Content-Type` the PUT must send, which the object is stored as. */
  contentType: string;
  /** The `Content-Length` the PUT must send, in bytes. */
  size: number;
  /** How long the URL works. */
  expiresInSeconds: number;
}

/** What an upload is told about its body up front. */
export interface UploadOptions {
  contentType: string;
  /** The body's length in bytes, which the request declares. */
  size: number;
}

/** What a streamed upload is told up front. */
export interface StreamUploadOptions extends UploadOptions {
  /** Aborts the upload: what was sent so far is thrown away, and nothing is left at the key. */
  signal?: AbortSignal;
}

/**
 * Characters RFC 5987 lets through unencoded in an `ext-value` (`attr-char`). `encodeURIComponent`
 * also leaves `'`, `(`, `)` and `*` alone, which this does not allow.
 */
const RFC5987_UNENCODED = /['()*]/g;
/** Percent-encoding writes a byte in hexadecimal. */
const HEX_RADIX = 16;
/** What the plain `filename=` fallback cannot hold: anything outside printable ASCII, quotes and backslashes. */
const UNQUOTABLE = /[^\x20-\x7e]|["\\]/g;

/**
 * Content-Disposition with the filename quoted safely, and a UTF-8 form (RFC 5987 / 6266) for non-ASCII names.
 *
 * @param filename - The name to save as.
 * @param disposition - Inline or attachment.
 * @returns The header value.
 */
export function contentDisposition(filename: string, disposition: Disposition): string {
  const fallback = filename.replace(UNQUOTABLE, '_');
  const encoded = encodeURIComponent(filename).replace(
    RFC5987_UNENCODED,
    (char) => `%${char.charCodeAt(0).toString(HEX_RADIX).toUpperCase()}`,
  );
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Everything the app asks of one bucket. An interface rather than the S3 client itself, so tests
 * hand in a map and nothing outside storage/ knows which SDK is behind it.
 */
export interface Storage {
  /** Resolves when the bucket exists and the credentials may reach it; throws the service's error otherwise. */
  headBucket(): Promise<void>;
  /** The stored object's size and type, or null when nothing is at the key. */
  head(key: string): Promise<ObjectHead | null>;
  /** The object's bytes, or only those in `range`. */
  getStream(key: string, range?: ByteRange): Promise<Readable>;
  /** Stores a body at the key, replacing whatever was there, in one PUT. For small bodies, such as the bucket test's probe. */
  upload(key: string, body: Readable | Uint8Array | string, options: UploadOptions): Promise<void>;
  /**
   * Streams a body of any size to the key, in parts once it is past one part's size.
   *
   * @remarks
   * A body that errors (a client that went away, a length check that failed) or an abort makes it reject, after
   * the multipart upload has been aborted, so no parts are left behind. A single-part body that never completed
   * was never written.
   */
  uploadStream(key: string, body: Readable, options: StreamUploadOptions): Promise<void>;
  /**
   * Every object in the bucket, a page at a time, in key order. Multipart uploads still in flight are not
   * objects yet, so they are not listed.
   */
  listObjects(): AsyncIterable<ListedObject[]>;
  /** Copies an object to another key in the same bucket, its type kept, in parts when it is past CopyObject's 5 GiB. */
  copy(fromKey: string, toKey: string): Promise<void>;
  /** Deletes the objects at the keys. A key with nothing at it is not an error. */
  delete(keys: string[]): Promise<void>;
  /** A URL for the object, signed for the bucket's public endpoint, that works with no other credential. */
  presignGet(key: string, options: PresignGetOptions): Promise<string>;
  /**
   * A URL that stores one body at the key with a single PUT, signed for the bucket's public endpoint, that works
   * with no other credential. The type and length are in the signature, so a PUT that sends others is refused.
   */
  presignPut(key: string, options: PresignPutOptions): Promise<string>;
}

/** The columns of a bucket that say how to reach it. A saved row has them, and so does a form being tested. */
export type BucketConnection = Pick<
  Bucket,
  'endpoint' | 'publicEndpoint' | 'region' | 'bucket' | 'accessKeyId' | 'forcePathStyle'
>;

/**
 * Builds the storage for one bucket.
 *
 * @param bucket - Where the bucket is and which access key reaches it.
 * @param secretAccessKey - The access key's secret, already decrypted.
 * @returns The bucket's storage.
 */
export type StorageFactory = (bucket: BucketConnection, secretAccessKey: string) => Storage;

/** The `Code` an S3 error document carries, which a service sends as XML. */
const XML_ERROR_CODE = /<Code>([^<]+)<\/Code>/;
/** Error names that say nothing about the failure, so the cause is read instead. */
const GENERIC_ERROR_NAMES = new Set(['Error', 'TypeError']);
/** What the AWS SDK calls an answer it could not read a code from, as for a HEAD refused with no body. */
const UNKNOWN_SDK_ERROR = 'Unknown';

/** What a HEAD's bare status means, since the service sends no error document with it. */
const STATUS_MEANINGS: Readonly<Record<number, string>> = Object.freeze({
  400: 'The service refused the request. Check the region and the path style.',
  401: 'Access denied. Check the access key, its secret, and its permissions on the bucket.',
  403: 'Access denied. Check the access key, its secret, and its permissions on the bucket.',
  404: 'There is no bucket of that name at this endpoint.',
  301: 'The bucket is in another region, or needs another endpoint.',
});

/** A storage failure, as the bucket test reports it. */
export interface StorageFailure {
  /** The S3 error code, an `HTTP_<status>` when the service gave none, a Node system error code, or null. */
  code: string | null;
  /** What went wrong, in words. */
  message: string;
}

/**
 * The HTTP status an AWS SDK error carries.
 *
 * @param error - What a call threw.
 * @returns The status, or null when it is not a service answer.
 */
export function httpStatus(error: Error): number | null {
  const metadata: unknown = '$metadata' in error ? error.$metadata : null;
  const isMetadata = typeof metadata === 'object' && metadata !== null && 'httpStatusCode' in metadata;
  if (isMetadata === false) {
    return null;
  }
  const status = metadata.httpStatusCode;
  return typeof status === 'number' ? status : null;
}

/**
 * Names the failure a storage call threw, as the service or the network said it.
 *
 * @param error - What the call threw.
 * @returns The code, and the most telling message down the error's cause chain.
 *
 * @remarks
 * The AWS SDK names its exceptions after the S3 code. A HEAD has no body, so a refusal comes back
 * as the status's name (`NotFound`) or, from some services, as `Unknown`; that is reported as
 * `HTTP_<status>` with what the status usually means. A network failure is a generic Error whose
 * `code`, or its cause's, is the system error (`ECONNREFUSED`, `ENOTFOUND`).
 */
export function describeStorageError(error: unknown): StorageFailure {
  let current: unknown = error;
  let message = error instanceof Error ? error.message : String(error);
  const seen = new Set<unknown>();
  while (current instanceof Error && seen.has(current) === false) {
    seen.add(current);
    const status = httpStatus(current);
    if (current.name === UNKNOWN_SDK_ERROR && status !== null) {
      return { code: `HTTP_${status}`, message: STATUS_MEANINGS[status] ?? `The service answered HTTP ${status}.` };
    }
    if ('code' in current && typeof current.code === 'string') {
      return { code: current.code, message: current.message };
    }
    if (GENERIC_ERROR_NAMES.has(current.name) === false) {
      return { code: current.name, message: current.message };
    }
    // "fetch failed" says less than what it wraps.
    message = current.message;
    current = current.cause;
  }
  return { code: null, message };
}

/**
 * Reads the code out of an S3 error document, as a presigned URL answers with.
 *
 * @param body - The response body.
 * @returns The `<Code>`, or null when the body is not an error document.
 */
export function xmlErrorCode(body: string): string | null {
  return XML_ERROR_CODE.exec(body)?.[1] ?? null;
}
