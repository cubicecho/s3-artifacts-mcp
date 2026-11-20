import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import type { BucketConnection, Storage, StorageFactory } from '../storage/storage.ts';

// Storage over Maps, standing in for an S3-compatible service in tests. A backend holds buckets by
// name, as a service does, so a test can make one fail before the code under test connects to it.
// Presigned URLs point at a host only the backend's `fetch` answers, so the bucket test's share-link
// step runs without a network.

/** The operations a test can make fail. */
export type MemoryOperation = Exclude<keyof Storage, 'presignGet'>;

/** One in-memory bucket. */
export interface MemoryStorage extends Storage {
  /** Every stored object's body and type, by key. */
  objects: Map<string, { body: string; contentType: string }>;
  /** Operations that throw an error named for this code, as the AWS SDK names its exceptions. */
  failures: Partial<Record<MemoryOperation, string>>;
  /** When set, `presignGet` signs for this origin instead, which the backend's `fetch` does not answer. */
  publicOrigin: string | null;
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
  const objects = new Map<string, { body: string; contentType: string }>();
  const failures: Partial<Record<MemoryOperation, string>> = {};

  const failIfAsked = (operation: MemoryOperation): void => {
    const code = failures[operation];
    if (code !== undefined) {
      throw serviceError(code, `${operation} refused: ${code}.`);
    }
  };

  const storage: MemoryStorage = {
    objects,
    failures,
    publicOrigin: null,

    async headBucket() {
      failIfAsked('headBucket');
    },
    async head(key) {
      failIfAsked('head');
      const object = objects.get(key);
      return object === undefined ? null : { size: Buffer.byteLength(object.body), contentType: object.contentType };
    },
    async getStream(key, range) {
      failIfAsked('getStream');
      const object = objects.get(key);
      if (object === undefined) {
        throw serviceError('NoSuchKey', 'The specified key does not exist.');
      }
      const bytes = Buffer.from(object.body);
      return Readable.from([range === undefined ? bytes : bytes.subarray(range.first, range.last + 1)]);
    },
    async upload(key, body, { contentType }) {
      failIfAsked('upload');
      const isText = typeof body === 'string';
      const content = isText ? body : body instanceof Readable ? await text(body) : Buffer.from(body).toString();
      objects.set(key, { body: content, contentType });
    },
    async copy(fromKey, toKey) {
      failIfAsked('copy');
      const object = objects.get(fromKey);
      if (object !== undefined) {
        objects.set(toKey, { ...object });
      }
    },
    async delete(keys) {
      failIfAsked('delete');
      for (const key of keys) {
        objects.delete(key);
      }
    },
    async presignGet(key, { expiresInSeconds }) {
      const origin = storage.publicOrigin ?? MEMORY_ORIGIN;
      return `${origin}/${name}/${encodeURIComponent(key)}?expires=${expiresInSeconds}`;
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
      return new Response(object.body, { headers: { 'content-type': object.contentType } });
    },
  };
}
