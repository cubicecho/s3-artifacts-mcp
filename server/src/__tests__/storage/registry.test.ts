import { buckets } from '@cubicecho/s3-artifacts-mcp-db/schema';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SecretPurpose, SecretUnreadableError } from '../../core/secrets.ts';
import { createStorageRegistry } from '../../storage/registry.ts';
import { closeTestDb, createTestDb, createTestSecrets, createUser, type TestDb } from '../helpers.ts';
import { createMemoryBackend } from '../memory-storage.ts';

// Buckets on different accounts and providers sit side by side. The registry keys its cache by
// bucket id alone, so each bucket gets clients built from its own row and nothing is shared by
// provider or endpoint.

describe('storage registry', () => {
  let db: TestDb;
  let userId: string;
  const secrets = createTestSecrets();

  beforeEach(async () => {
    db = await createTestDb();
    userId = await createUser(db, 'owner@example.com');
  });

  afterEach(() => closeTestDb(db));

  /** Saves a bucket row straight through Drizzle, as the resolvers would after a passing test. */
  async function saveBucket(values: {
    slug: string;
    provider: 's3' | 'minio' | 'rustfs' | 'b2';
    endpoint: string | null;
    region: string;
    bucket: string;
    accessKeyId: string;
    secret: string;
  }): Promise<string> {
    const { secret, ...fields } = values;
    const [row] = await db
      .insert(buckets)
      .values({
        ...fields,
        userId,
        name: fields.slug,
        secretAccessKeyEnc: secrets.seal(secret, SecretPurpose.BucketSecret),
      })
      .returning({ id: buckets.id });
    return row.id;
  }

  it('builds each bucket from its own row and credentials, and invalidating one leaves the other alone', async () => {
    const backend = createMemoryBackend();
    const registry = createStorageRegistry({ db, secrets, factory: backend.factory });
    const minio = await saveBucket({
      slug: 'minio',
      provider: 'minio',
      endpoint: 'http://minio.lan:9000',
      region: 'us-east-1',
      bucket: 'shared-name',
      accessKeyId: 'minio-key',
      secret: 'minio-secret',
    });
    const b2 = await saveBucket({
      slug: 'b2',
      provider: 'b2',
      endpoint: 'https://s3.us-west-004.backblazeb2.com',
      region: 'us-west-004',
      bucket: 'b2-bucket',
      accessKeyId: 'b2-key',
      secret: 'b2-secret',
    });

    const minioStorage = await registry.get(minio);
    const b2Storage = await registry.get(b2);
    expect(minioStorage).not.toBe(b2Storage);
    expect(backend.connections).toEqual([
      {
        bucket: expect.objectContaining({ endpoint: 'http://minio.lan:9000', accessKeyId: 'minio-key' }),
        secretAccessKey: 'minio-secret',
      },
      {
        bucket: expect.objectContaining({ endpoint: 'https://s3.us-west-004.backblazeb2.com', region: 'us-west-004' }),
        secretAccessKey: 'b2-secret',
      },
    ]);

    // Cached: a second ask builds nothing.
    expect(await registry.get(minio)).toBe(minioStorage);
    expect(backend.connections).toHaveLength(2);

    registry.invalidate(minio);
    await registry.get(minio);
    expect(await registry.get(b2)).toBe(b2Storage);
    expect(backend.connections).toHaveLength(3);
    expect(backend.connections[2]).toMatchObject({ bucket: { accessKeyId: 'minio-key' } });
  });

  it('keeps two buckets on one endpoint with different keys apart', async () => {
    const built: { accessKeyId: string; secret: string }[] = [];
    const backend = createMemoryBackend();
    const registry = createStorageRegistry({
      db,
      secrets,
      factory: (bucket, secret) => {
        built.push({ accessKeyId: bucket.accessKeyId, secret });
        return backend.factory(bucket, secret);
      },
    });
    const common = {
      provider: 'rustfs',
      endpoint: 'http://rustfs.lan:9000',
      region: 'us-east-1',
      bucket: 'b',
    } as const;
    const first = await saveBucket({ ...common, slug: 'first', accessKeyId: 'key-1', secret: 'secret-1' });
    const second = await saveBucket({ ...common, slug: 'second', accessKeyId: 'key-2', secret: 'secret-2' });
    await registry.get(first);
    await registry.get(second);
    expect(built).toEqual([
      { accessKeyId: 'key-1', secret: 'secret-1' },
      { accessKeyId: 'key-2', secret: 'secret-2' },
    ]);
  });

  it('reads the row again after it changed', async () => {
    const backend = createMemoryBackend();
    const registry = createStorageRegistry({ db, secrets, factory: backend.factory });
    const id = await saveBucket({
      slug: 'x',
      provider: 'rustfs',
      endpoint: 'http://old.lan:9000',
      region: 'us-east-1',
      bucket: 'b',
      accessKeyId: 'k',
      secret: 's',
    });
    await registry.get(id);
    await db.update(buckets).set({ endpoint: 'http://new.lan:9000' }).where(eq(buckets.id, id));
    registry.invalidate(id);
    await registry.get(id);
    expect(backend.connections.map((connection) => connection.bucket.endpoint)).toEqual([
      'http://old.lan:9000',
      'http://new.lan:9000',
    ]);
  });

  it('drops the least recently used bucket past its cache size', async () => {
    const backend = createMemoryBackend();
    const registry = createStorageRegistry({ db, secrets, factory: backend.factory, cacheSize: 1 });
    const common = {
      provider: 'rustfs',
      endpoint: 'http://r.lan',
      region: 'us-east-1',
      bucket: 'b',
      accessKeyId: 'k',
      secret: 's',
    } as const;
    const first = await saveBucket({ ...common, slug: 'one' });
    const second = await saveBucket({ ...common, slug: 'two' });
    await registry.get(first);
    await registry.get(second);
    await registry.get(first);
    expect(backend.connections).toHaveLength(3);
  });

  it('refuses a bucket whose secret no longer decrypts', async () => {
    const id = await saveBucket({
      slug: 'old',
      provider: 'rustfs',
      endpoint: 'http://r.lan',
      region: 'us-east-1',
      bucket: 'b',
      accessKeyId: 'k',
      secret: 's',
    });
    const rotated = createStorageRegistry({ db, secrets: createTestSecrets('rotated-secret-0123456789abcdef0123') });
    await expect(rotated.get(id)).rejects.toBeInstanceOf(SecretUnreadableError);
  });
});
