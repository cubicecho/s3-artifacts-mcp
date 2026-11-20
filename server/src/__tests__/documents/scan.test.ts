import { DocumentStatus, documents } from '@cubicecho/s3-artifacts-mcp-db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '../../core/context.ts';
import { BUCKET_DEFAULTS, DOCUMENT_DEFAULTS } from '../../core/defaults.ts';
import { ErrorCode } from '../../core/errors.ts';
import { DEFAULT_CONTENT_TYPE } from '../../documents/create.ts';
import { scanBucket } from '../../documents/scan.ts';
import { createStorageRegistry, type StorageRegistry } from '../../storage/registry.ts';
import {
  type ClientOptions,
  closeTestDb,
  createClient,
  createTestDb,
  createTestSecrets,
  createUser,
  insertBucket,
  resetTestDb,
  type TestDb,
} from '../helpers.ts';
import { createMemoryBackend, type MemoryBackend, type MemoryStorage } from '../memory-storage.ts';

const SCAN = `
  mutation ($id: UUID!) {
    scanBucket(id: $id) { imported alreadyListed skippedCount skipped { key reason } truncated }
  }
`;
const CREATE = `
  mutation ($bucketId: UUID!) {
    createDocumentUpload(bucketId: $bucketId, filename: "Mine.pdf", contentType: "application/pdf", size: 5) {
      document { id objectKey }
    }
  }
`;
const DOCUMENT_FIELDS = 'title filename objectKey contentType size sha256 status';
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

describe('scanBucket', () => {
  let db: TestDb;
  let owner: string;
  let stranger: string;
  let bucketId: string;
  let backend: MemoryBackend;
  let bucket: MemoryStorage;
  let storage: StorageRegistry;
  const secrets = createTestSecrets();

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(() => closeTestDb(db));

  beforeEach(async () => {
    await resetTestDb(db);
    owner = await createUser(db, 'owner@example.com');
    stranger = await createUser(db, 'stranger@example.com');
    bucketId = await insertBucket(db, secrets, owner);
    backend = createMemoryBackend();
    bucket = backend.bucket('artifacts');
    storage = createStorageRegistry({ db, secrets, factory: backend.factory });
  });

  const options = (): ClientOptions => ({ backend, secrets, storage });
  const client = () => createClient(db, owner, options());

  /** Puts objects in the bucket, as another tool would have. */
  function put(...keys: string[]): void {
    for (const key of keys) {
      bucket.objects.set(key, { body: Buffer.from(`bytes of ${key}`), contentType: 'application/x-anything' });
    }
  }

  async function listed(): Promise<Record<string, unknown>[]> {
    const { documents: rows } = await client().expectOk(`{ documents { ${DOCUMENT_FIELDS} } }`);
    return [...rows].sort((a, b) => String(a.objectKey).localeCompare(String(b.objectKey)));
  }

  it('adds each file as a ready document, where it already is, with its type guessed from the name', async () => {
    put('notes.md', '2024/01/Report.final.PDF', 'no-extension');
    const { scanBucket: result } = await client().expectOk(SCAN, { id: bucketId });
    expect(result).toEqual({ imported: 3, alreadyListed: 0, skippedCount: 0, skipped: [], truncated: false });
    const status = DocumentStatus.Ready;
    expect(await listed()).toEqual([
      {
        title: '2024/01/Report.final',
        filename: 'Report.final.PDF',
        objectKey: '2024/01/Report.final.PDF',
        contentType: 'application/pdf',
        size: Buffer.byteLength('bytes of 2024/01/Report.final.PDF'),
        sha256: null,
        status,
      },
      {
        title: 'no-extension',
        filename: 'no-extension',
        objectKey: 'no-extension',
        contentType: DEFAULT_CONTENT_TYPE,
        size: Buffer.byteLength('bytes of no-extension'),
        sha256: null,
        status,
      },
      {
        title: 'notes',
        filename: 'notes.md',
        objectKey: 'notes.md',
        contentType: 'text/markdown',
        size: Buffer.byteLength('bytes of notes.md'),
        sha256: null,
        status,
      },
    ]);
  });

  it('adds only what is new when run again, and leaves the objects as they were', async () => {
    put('a.txt', 'b.txt');
    await client().expectOk(SCAN, { id: bucketId });
    put('c.txt');
    const { scanBucket: again } = await client().expectOk(SCAN, { id: bucketId });
    expect(again).toMatchObject({ imported: 1, alreadyListed: 2 });
    expect((await listed()).map((row) => row.objectKey)).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect([...bucket.objects.keys()].sort()).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  it('counts the app’s own uploads, pending or ready, as already listed', async () => {
    const { createDocumentUpload } = await client().expectOk(CREATE, { bucketId });
    put(createDocumentUpload.document.objectKey);
    const { scanBucket: result } = await client().expectOk(SCAN, { id: bucketId });
    expect(result).toMatchObject({ imported: 0, alreadyListed: 1 });
    expect(await listed()).toHaveLength(1);
  });

  it('passes over folder markers and the connection test’s probe without counting them', async () => {
    put('reports/', BUCKET_DEFAULTS.probeKey, 'reports/q1.csv');
    const { scanBucket: result } = await client().expectOk(SCAN, { id: bucketId });
    expect(result).toEqual({ imported: 1, alreadyListed: 0, skippedCount: 0, skipped: [], truncated: false });
  });

  it('reads every page of the listing', async () => {
    bucket.pageSize = 2;
    put('1.txt', '2.txt', '3.txt', '4.txt', '5.txt');
    const { scanBucket: result } = await client().expectOk(SCAN, { id: bucketId });
    expect(result.imported).toBe(5);
  });

  it('skips a key no download could be named after, and says why', async () => {
    const tooLong = `${'x'.repeat(DOCUMENT_DEFAULTS.filenameMaxLength)}.txt`;
    put('fine.txt', 'bad\nname.txt', tooLong);
    const { scanBucket: result } = await client().expectOk(SCAN, { id: bucketId });
    expect(result.imported).toBe(1);
    expect(result.skippedCount).toBe(2);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { key: 'bad\nname.txt', reason: expect.stringMatching(/control characters/) },
        { key: tooLong, reason: expect.stringMatching(/at most/) },
      ]),
    );
  });

  it('names only the first few skipped files, and counts the rest', async () => {
    put('a\n1', 'a\n2', 'a\n3');
    const ctx = { db, userId: owner, secrets, storage } as unknown as Context;
    const result = await scanBucket(ctx, bucketId, { skippedReported: 2 });
    expect(result.skippedCount).toBe(3);
    expect(result.skipped).toHaveLength(2);
  });

  it('stops at its limit and says so, and the next scan carries on', async () => {
    bucket.pageSize = 2;
    put('1.txt', '2.txt', '3.txt', '4.txt', '5.txt');
    // The limit is not reachable through the API without thousands of objects, so the function is called itself.
    const ctx = { db, userId: owner, secrets, storage } as unknown as Context;
    expect(await scanBucket(ctx, bucketId, { maxImports: 3 })).toMatchObject({ imported: 3, truncated: true });
    expect(await scanBucket(ctx, bucketId, { maxImports: 3 })).toMatchObject({
      imported: 2,
      alreadyListed: 3,
      truncated: false,
    });
  });

  it('is not truncated when the limit is met by the last file', async () => {
    put('1.txt', '2.txt');
    const ctx = { db, userId: owner, secrets, storage } as unknown as Context;
    expect(await scanBucket(ctx, bucketId, { maxImports: 2 })).toMatchObject({ imported: 2, truncated: false });
  });

  it('adds each file once when two scans race', async () => {
    put('a.txt', 'b.txt', 'c.txt');
    const results = await Promise.all([
      client().expectOk(SCAN, { id: bucketId }),
      client().expectOk(SCAN, { id: bucketId }),
    ]);
    const imported = results.reduce((sum, { scanBucket: result }) => sum + result.imported, 0);
    expect(imported).toBe(3);
    expect(await listed()).toHaveLength(3);
  });

  it('reports a bucket that refuses to be listed, with the service’s code', async () => {
    put('a.txt');
    bucket.failures.listObjects = 'AccessDenied';
    const { errors } = await client().run(SCAN, { id: bucketId });
    const [error] = errors ?? [];
    expect(error.message).toMatch(/AccessDenied.*permission to list/);
    expect(error.extensions).toMatchObject({ code: ErrorCode.StorageError, errorCode: 'AccessDenied', imported: 0 });
    expect(await listed()).toEqual([]);
  });

  it('answers NOT_FOUND for someone else’s bucket and a missing one alike', async () => {
    const strangersBucket = await insertBucket(db, secrets, stranger);
    put('a.txt');
    for (const id of [strangersBucket, MISSING_ID]) {
      expect((await client().expectError(SCAN, { id })).code).toBe(ErrorCode.NotFound);
    }
    const rows = await db.select().from(documents).where(eq(documents.bucketId, strangersBucket));
    expect(rows).toEqual([]);
  });

  it('refuses a bucket whose secret can no longer be decrypted, saying what to do', async () => {
    const rotated = await insertBucket(db, createTestSecrets('another-secret-0123456789abcdef0123'), owner, {
      name: 'Rotated',
    });
    const { code, message } = await client().expectError(SCAN, { id: rotated });
    expect(code).toBe(ErrorCode.BadUserInput);
    expect(message).toMatch(/Rotated.*cannot be scanned.*Enter it again/);
  });

  it('refuses the unauthenticated', async () => {
    const { code } = await createClient(db, null, options()).expectError(SCAN, { id: bucketId });
    expect(code).toBe(ErrorCode.Unauthenticated);
  });
});
