import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { type BucketConnection, contentDisposition, type Storage, type StorageFactory } from '../storage/storage.ts';

// Storage over Maps, standing in for an S3-compatible service in tests. A backend holds buckets by
// name, as a service does, so a test can make one fail before the code under test connects to it.
// Presigned URLs point at a host only the backend's `fetch` answers, so the bucket test's share-link
// step and a share link run without a network. They carry the type and disposition they were signed
// with as S3's do (`response-content-type`, `response-content-disposition`), and the fetch answers
// with them.

/** The operations a test can make fail. */
export type MemoryOperation = Exclude<keyof Storage, 'presignGet'>;

/** One stored object. */
export interface MemoryObject {
  body: Buffer;
  contentType: string;
}

/** One in-memory bucket. */
export interface MemoryStorage extends Storage {
  /** Every stored object's body and type, by key. */
  objects: Map<string, MemoryObject>;
  /** Keys a streamed upload has started on and not finished or abandoned yet, as multipart uploads in flight. */
  inFlight: Set<string>;
  /** Operations that throw an error named for this code, as the AWS SDK names its exceptions. */
  failures: Partial<Record<MemoryOperation, string>>;
  /** When set, `presignGet` signs for this origin instead, which the backend's `fetch` does not answer. */
  publicOrigin: string | null;
  /** How many objects `listObjects` puts in a page, as `MaxKeys` would. */
  pageSize: number;
}

/** A pretend S3 service. */
export interface MemoryBackend {
  /** Builds a bucket's storage, as `createS3Storage` would: the registry's and the test's factory. */
  factory: StorageFactory;
  /** Answers a URL `presignGet` made, as the service would. Anything else fails as an unreachable host. */
  fetch: typeof fetch;
  /** The bucket of that name, made empty on first use. */
  bucket(name: string): MemoryStorage;
  /** Every connection the factory was asked for, oldest first. */
  connections: { bucket: BucketConnection; secretAccessKey: string }[];
}

/** The origin presigned URLs from a memory backend point at. */
export const MEMORY_ORIGIN = 'http://memory.test';
const NOT_FOUND = 404;
/** The query parameters a presigned GET carries, as S3 names them. */
const EXPIRES_PARAM = 'expires';
const CONTENT_TYPE_PARAM = 'response-content-type';
const DISPOSITION_PARAM = 'response-content-disposition';
/** A ListObjectsV2 page's size on S3. */
const DEFAULT_PAGE_SIZE = 1000;

/**
 * An error named for a service's code, as the SDK throws.
 *
 * @param code - The S3 error code.
 * @param message - What the service said.
 * @returns The error.
 */
function serviceError(code: string, message: string): Error {
  const error = new Error(message);
  error.name = code;
  return error;
}

/**
 * Builds one empty in-memory bucket.
 *
 * @param name - Its name, which its presigned URLs carry.
 * @returns The storage.
 */
function createMemoryStorage(name: string): MemoryStorage {
  const objects = new Map<string, MemoryObject>();
  const inFlight = new Set<string>();
  const failures: Partial<Record<MemoryOperation, string>> = {};

  const failIfAsked = (operation: MemoryOperation): void => {
    const code = failures[operation];
    if (code !== undefined) {
      throw serviceError(code, `${operation} refused: ${code}.`);
    }
  };

  const storage: MemoryStorage = {
    objects,
    inFlight,
    failures,
    publicOrigin: null,
    pageSize: DEFAULT_PAGE_SIZE,

    async headBucket() {
      failIfAsked('headBucket');
    },
    async head(key) {
      failIfAsked('head');
      const object = objects.get(key);
      return object === undefined ? null : { size: object.body.length, contentType: object.contentType };
    },
    async getStream(key, range) {
      failIfAsked('getStream');
      const object = objects.get(key);
      if (object === undefined) {
        throw serviceError('NoSuchKey', 'The specified key does not exist.');
      }
      const bytes = object.body;
      return Readable.from([range === undefined ? bytes : bytes.subarray(range.first, range.last + 1)]);
    },
    async upload(key, body, { contentType }) {
      failIfAsked('upload');
      const content = body instanceof Readable ? await buffer(body) : Buffer.from(body);
      objects.set(key, { body: content, contentType });
    },
    async uploadStream(key, body, { contentType, signal }) {
      failIfAsked('uploadStream');
      // As a multipart upload: nothing is at the key until the whole body has arrived, and a
      // body that errors or an abort leaves nothing behind.
      inFlight.add(key);
      const onAbort = (): void => {
        body.destroy(new Error('The upload was aborted.'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        objects.set(key, { body: await buffer(body), contentType });
      } finally {
        inFlight.delete(key);
        signal?.removeEventListener('abort', onAbort);
      }
    },
    async *listObjects() {
      failIfAsked('listObjects');
      const keys = [...objects.keys()].sort();
      for (let start = 0; start < keys.length; start += storage.pageSize) {
        yield keys.slice(start, start + storage.pageSize).map((key) => ({
          key,
          size: objects.get(key)?.body.length ?? 0,
        }));
      }
    },
    async copy(fromKey, toKey) {
      failIfAsked('copy');
      const object = objects.get(fromKey);
      if (object === undefined) {
        throw serviceError('NoSuchKey', 'The specified key does not exist.');
      }
      objects.set(toKey, { ...object });
    },
    async delete(keys) {
      failIfAsked('delete');
      for (const key of keys) {
        objects.delete(key);
      }
    },
    async presignGet(key, { filename, contentType, disposition, expiresInSeconds }) {
      const origin = storage.publicOrigin ?? MEMORY_ORIGIN;
      const params = new URLSearchParams({
        [EXPIRES_PARAM]: String(expiresInSeconds),
        [CONTENT_TYPE_PARAM]: contentType,
        [DISPOSITION_PARAM]: contentDisposition(filename, disposition),
      });
      return `${origin}/${name}/${encodeURIComponent(key)}?${params}`;
    },
  };
  return storage;
}

/**
 * Builds a pretend S3 service with no buckets in it yet.
 *
 * @returns The backend.
 */
export function createMemoryBackend(): MemoryBackend {
  const storages = new Map<string, MemoryStorage>();
  const connections: MemoryBackend['connections'] = [];

  const bucket = (name: string): MemoryStorage => {
    const existing = storages.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const created = createMemoryStorage(name);
    storages.set(name, created);
    return created;
  };

  return {
    bucket,
    connections,
    factory: (connection, secretAccessKey) => {
      connections.push({ bucket: connection, secretAccessKey });
      return bucket(connection.bucket);
    },
    fetch: async (input) => {
      const url = new URL(String(input));
      const [, name, key] = url.pathname.split('/');
      const isOurs = url.origin === MEMORY_ORIGIN && storages.has(name);
      if (isOurs === false) {
        const refused = Object.assign(new Error(`connect ECONNREFUSED ${url.host}`), { code: 'ECONNREFUSED' });
        throw new TypeError('fetch failed', { cause: refused });
      }
      const object = bucket(name).objects.get(decodeURIComponent(key));
      if (object === undefined) {
        return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: NOT_FOUND });
      }
      const disposition = url.searchParams.get(DISPOSITION_PARAM);
      const headers = new Headers({ 'content-type': url.searchParams.get(CONTENT_TYPE_PARAM) ?? object.contentType });
      if (disposition !== null) {
        headers.set('content-disposition', disposition);
      }
      return new Response(new Uint8Array(object.body), { headers });
    },
  };
}
