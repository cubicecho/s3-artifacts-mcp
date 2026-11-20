import { DocumentStatus, documents, type NewDocument } from '@cubicecho/s3-artifacts-mcp-db/schema';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UPLOAD_DEFAULTS } from '../../core/defaults.ts';
import { MS_PER_SECOND, SECONDS_PER_MINUTE } from '../../core/wire.ts';
import { objectKeyFor } from '../../documents/keys.ts';
import { sweepPendingUploads } from '../../documents/sweep.ts';
import {
  closeTestDb,
  createTestDb,
  createTestSecrets,
  createTestStorageDeps,
  createUser,
  insertBucket,
  resetTestDb,
  type TestDb,
  type TestStorageDeps,
} from '../helpers.ts';

const NOW = new Date('2026-11-19T12:00:00Z');
const { pendingTtlMinutes } = UPLOAD_DEFAULTS;

/**
 * A time some minutes before `NOW`.
 *
 * @param minutes - How long before.
 * @returns The time.
 */
function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * SECONDS_PER_MINUTE * MS_PER_SECOND);
}

describe('sweepPendingUploads', () => {
  let db: TestDb;
  let deps: TestStorageDeps;
  let owner: string;
  let bucketId: string;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(() => closeTestDb(db));

  beforeEach(async () => {
    await resetTestDb(db);
    deps = createTestStorageDeps(db);
    owner = await createUser(db, 'owner@example.com');
    bucketId = await insertBucket(db, deps.secrets, owner);
  });

  /**
   * Inserts a document last changed some minutes ago.
   *
   * @param minutes - How long ago.
   * @param [overrides] - Columns to change.
   * @returns Its id and key.
   */
  async function documentFrom(minutes: number, overrides: Partial<NewDocument> = {}) {
    const id = crypto.randomUUID();
    const [row] = await db
      .insert(documents)
      .values({
        id,
        userId: owner,
        bucketId,
        title: 'a',
        filename: 'a.txt',
        objectKey: objectKeyFor(id, 'a.txt'),
        contentType: 'text/plain',
        size: 1,
        status: DocumentStatus.PendingUpload,
        createdAt: minutesAgo(minutes),
        updatedAt: minutesAgo(minutes),
        ...overrides,
      })
      .returning();
    return row;
  }

  const remainingIds = async (): Promise<string[]> =>
    (await db.select({ id: documents.id }).from(documents)).map((row) => row.id).sort();

  it('drops pending rows past the time limit, and any object at their key', async () => {
    const stale = await documentFrom(pendingTtlMinutes + 1);
    const fresh = await documentFrom(pendingTtlMinutes - 1);
    const old = await documentFrom(pendingTtlMinutes * 10, { status: DocumentStatus.Ready });
    const bucket = deps.backend.bucket('artifacts');
    bucket.objects.set(stale.objectKey, { body: Buffer.from('x'), contentType: 'text/plain' });

    expect(await sweepPendingUploads({ db, storage: deps.storage }, {}, NOW)).toBe(1);
    expect(await remainingIds()).toEqual([fresh.id, old.id].sort());
    expect(bucket.objects.has(stale.objectKey)).toBe(false);
  });

  it('counts from the last change, which the upload route bumps when it starts', async () => {
    const started = await documentFrom(pendingTtlMinutes * 2, { updatedAt: minutesAgo(1) });
    expect(await sweepPendingUploads({ db, storage: deps.storage }, {}, NOW)).toBe(0);
    expect(await remainingIds()).toEqual([started.id]);
  });

  it('takes a shorter limit as an override', async () => {
    await documentFrom(2);
    expect(await sweepPendingUploads({ db, storage: deps.storage }, { pendingTtlMinutes: 1 }, NOW)).toBe(1);
  });

  it('drops the row even when the bucket cannot be opened', async () => {
    const rotated = await insertBucket(db, createTestSecrets('another-secret-0123456789abcdef0123'), owner);
    await documentFrom(pendingTtlMinutes + 1, { bucketId: rotated });
    expect(await sweepPendingUploads({ db, storage: deps.storage }, {}, NOW)).toBe(1);
    expect(await remainingIds()).toEqual([]);
  });
});
