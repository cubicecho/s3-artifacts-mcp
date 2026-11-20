import type { DB } from '@cubicecho/s3-artifacts-mcp-db';
import { buckets } from '@cubicecho/s3-artifacts-mcp-db/schema';
import { eq } from 'drizzle-orm';
import { BUCKET_DEFAULTS } from '../core/defaults.ts';
import { type SecretBox, SecretPurpose } from '../core/secrets.ts';
import { createS3Storage } from './s3.ts';
import type { BucketConnection, Storage, StorageFactory } from './storage.ts';

// Every bucket's storage, built when it is first asked for and kept until the bucket changes.
// The cache is keyed by bucket id and nothing else: two buckets on one endpoint, or on one
// provider with different keys, each get their own clients.

/** The storage of every saved bucket, and a way to reach one that is not saved yet. */
export interface StorageRegistry {
  /**
   * The storage for a saved bucket, built on first use.
   *
   * @param bucketId - A bucket the caller has already found to be theirs. The registry does not scope.
   * @returns Its storage.
   * @throws When there is no such bucket, or SecretUnreadableError when its secret no longer decrypts.
   */
  get(bucketId: string): Promise<Storage>;
  /**
   * Drops a bucket's built storage, so the next `get` reads its row again. Every bucket write calls it.
   *
   * @param bucketId - The bucket that changed or went away.
   */
  invalidate(bucketId: string): void;
  /**
   * Builds storage for settings that are not saved, as a connection test does. Nothing is cached.
   *
   * @param bucket - Where the bucket is and which access key reaches it.
   * @param secretAccessKey - The key's secret.
   * @returns Storage over those settings.
   */
  connect(bucket: BucketConnection, secretAccessKey: string): Storage;
}

/** What a registry is built from. */
export interface StorageRegistryOptions {
  db: DB;
  /** Opens each bucket's sealed secret. */
  secrets: SecretBox;
  /** Builds one bucket's storage. `createS3Storage` unless a test hands in its own. */
  factory?: StorageFactory;
  /** How many buckets' storage stay built. `BUCKET_DEFAULTS.clientCacheSize` unless a test says. */
  cacheSize?: number;
}

/**
 * Builds the registry the app reaches every bucket through.
 *
 * @param options - The database, the secret box, and optionally the storage factory and cache size.
 * @returns The registry.
 */
export function createStorageRegistry({
  db,
  secrets,
  factory = createS3Storage,
  cacheSize = BUCKET_DEFAULTS.clientCacheSize,
}: StorageRegistryOptions): StorageRegistry {
  // A Map keeps insertion order, so re-inserting on each hit makes its first key the least recently used.
  const cache = new Map<string, Storage>();
  // Bumped by `invalidate`, so a `get` that read the row before a write does not cache what it built.
  let generation = 0;

  const remember = (bucketId: string, storage: Storage): void => {
    cache.delete(bucketId);
    cache.set(bucketId, storage);
    const isFull = cache.size > cacheSize;
    if (isFull) {
      const [oldest] = cache.keys();
      cache.delete(oldest);
    }
  };

  return {
    async get(bucketId) {
      const cached = cache.get(bucketId);
      if (cached !== undefined) {
        remember(bucketId, cached);
        return cached;
      }
      const readAt = generation;
      const [row] = await db.select().from(buckets).where(eq(buckets.id, bucketId));
      if (row === undefined) {
        throw new Error(`No bucket ${bucketId}.`);
      }
      const storage = factory(row, secrets.open(row.secretAccessKeyEnc, SecretPurpose.BucketSecret));
      const isCurrent = readAt === generation;
      if (isCurrent) {
        remember(bucketId, storage);
      }
      return storage;
    },

    invalidate(bucketId) {
      generation += 1;
      cache.delete(bucketId);
    },

    connect(bucket, secretAccessKey) {
      return factory(bucket, secretAccessKey);
    },
  };
}
