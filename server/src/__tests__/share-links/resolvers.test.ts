import { APP_SETTINGS_DEFAULTS } from '@cubicecho/s3-artifacts-mcp-db/defaults';
import {
  appSettings,
  type Document,
  DocumentStatus,
  documents,
  shareLinks,
} from '@cubicecho/s3-artifacts-mcp-db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHARE_LINK_DEFAULTS } from '../../core/defaults.ts';
import { ErrorCode } from '../../core/errors.ts';
import { HttpStatus, MS_PER_SECOND, SECONDS_PER_HOUR } from '../../core/wire.ts';
import { objectKeyFor } from '../../documents/keys.ts';
import { expiryHoursSchema } from '../../share-links/expiry.ts';
import { ShareLinkState, shareLinkState } from '../../share-links/state.ts';
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

// Share links over in-memory storage: what each is signed with, its URL and state, removing one, and revoking them
// all by re-keying the document. The fetch is the backend's, which answers a presigned URL as a bucket would.

const LINK_FIELDS = 'id documentId label permission objectKey expiresAt createdBy url state';
const CREATE = `
  mutation ($documentId: UUID!, $permission: ShareLinkPermission, $expiresInHours: Int, $label: String) {
    createShareLink(documentId: $documentId, permission: $permission, expiresInHours: $expiresInHours, label: $label) {
      ${LINK_FIELDS}
    }
  }
`;
const DELETE = 'mutation ($id: UUID!) { deleteShareLink(id: $id) }';
const REKEY = 'mutation ($id: UUID!) { rekeyDocument(id: $id) { id objectKey } }';
const LINKS = `query ($id: UUID!) { document(where: { id: { eq: $id } }) { shareLinks { ${LINK_FIELDS} } } }`;
const ALL_LINKS = '{ shareLinks { id state } }';
const MISSING_ID = '00000000-0000-4000-8000-000000000000';
const BODY = Buffer.from('%PDF-1.4 the quarterly numbers');
/** A `BETTER_AUTH_SECRET` other than the one everything was sealed with. */
const ROTATED_SECRET = 'rotated-0123456789abcdef0123456789';
/** When the tests pretend it is, so expiries are exact. */
const NOW = new Date('2026-11-19T12:00:00.000Z');

describe('share links', () => {
  let db: TestDb;
  let owner: string;
  let stranger: string;
  let bucketId: string;
  let backend: MemoryBackend;
  let bucket: MemoryStorage;
  let storage: StorageRegistry;
  let document: Document;
  const secrets = createTestSecrets();

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(() => closeTestDb(db));

  beforeEach(async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    await resetTestDb(db);
    owner = await createUser(db, 'owner@example.com');
    stranger = await createUser(db, 'stranger@example.com');
    bucketId = await insertBucket(db, secrets, owner);
    backend = createMemoryBackend();
    bucket = backend.bucket('artifacts');
    storage = createStorageRegistry({ db, secrets, factory: backend.factory });
    document = await insertDocument();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const options = (): ClientOptions => ({ backend, secrets, storage });
  const client = () => createClient(db, owner, options());
  const other = () => createClient(db, stranger, options());

  /**
   * Inserts a ready document whose bytes are in the bucket.
   *
   * @param overrides - Columns to change.
   * @returns The row.
   */
  async function insertDocument(overrides: Partial<Document> = {}): Promise<Document> {
    const id = crypto.randomUUID();
    const filename = overrides.filename ?? 'Quarterly report.pdf';
    const [row] = await db
      .insert(documents)
      .values({
        id,
        userId: owner,
        bucketId,
        title: 'Quarterly report',
        filename,
        objectKey: objectKeyFor(id, filename),
        contentType: 'application/pdf',
        size: BODY.length,
        status: DocumentStatus.Ready,
        ...overrides,
      })
      .returning();
    bucket.objects.set(row.objectKey, { body: BODY, contentType: 'binary/octet-stream' });
    return row;
  }

  /** Makes a link as the owner and returns it. */
  async function share(variables: Record<string, unknown> = {}) {
    const { createShareLink } = await client().expectOk(CREATE, { documentId: document.id, ...variables });
    return createShareLink;
  }

  /** Reads the document's object key again. */
  async function currentKey(): Promise<string> {
    const [row] = await db.select().from(documents).where(eq(documents.id, document.id));
    return row.objectKey;
  }

  describe('createShareLink', () => {
    it('takes the owner’s defaults for what it is not told', async () => {
      const link = await share();
      expect(link).toMatchObject({
        documentId: document.id,
        label: null,
        permission: APP_SETTINGS_DEFAULTS.defaultLinkPermission,
        objectKey: document.objectKey,
        createdBy: 'owner',
        state: ShareLinkState.Active,
      });
      const lifetimeMs = new Date(link.expiresAt).getTime() - NOW.getTime();
      expect(lifetimeMs).toBe(APP_SETTINGS_DEFAULTS.defaultLinkExpiryHours * SECONDS_PER_HOUR * MS_PER_SECOND);
      const signedFor = new URL(link.url).searchParams.get('expires');
      expect(Number(signedFor)).toBe(APP_SETTINGS_DEFAULTS.defaultLinkExpiryHours * SECONDS_PER_HOUR);
    });

    it('takes the defaults as the owner changed them', async () => {
      await db
        .update(appSettings)
        .set({ defaultLinkExpiryHours: 72, defaultLinkPermission: 'view' })
        .where(eq(appSettings.userId, owner));
      const link = await share();
      expect(link.permission).toBe('view');
      expect(new URL(link.url).searchParams.get('expires')).toBe(String(72 * SECONDS_PER_HOUR));
    });

    it('signs a download as an attachment under the filename, with the document’s type', async () => {
      const link = await share({ permission: 'download', expiresInHours: 1 });
      const response = await backend.fetch(link.url);
      expect(Buffer.from(await response.arrayBuffer()).equals(BODY)).toBe(true);
      expect(response.headers.get('content-type')).toBe('application/pdf');
      expect(response.headers.get('content-disposition')).toBe(
        `attachment; filename="Quarterly report.pdf"; filename*=UTF-8''Quarterly%20report.pdf`,
      );
    });

    it('signs a view as inline', async () => {
      const link = await share({ permission: 'view', expiresInHours: 1 });
      const response = await backend.fetch(link.url);
      expect(response.headers.get('content-disposition')).toMatch(/^inline; filename="Quarterly report.pdf"/);
      expect(response.headers.get('content-type')).toBe('application/pdf');
    });

    it.each([SHARE_LINK_DEFAULTS.minExpiryHours, SHARE_LINK_DEFAULTS.maxExpiryHours])(
      'lasts exactly %i hours when asked',
      async (hours) => {
        const link = await share({ expiresInHours: hours });
        expect(new Date(link.expiresAt).getTime() - NOW.getTime()).toBe(hours * SECONDS_PER_HOUR * MS_PER_SECOND);
        expect(new URL(link.url).searchParams.get('expires')).toBe(String(hours * SECONDS_PER_HOUR));
      },
    );

    it.each([
      ['no time at all', 0],
      ['a negative expiry', -1],
      ['more than 7 days', SHARE_LINK_DEFAULTS.maxExpiryHours + 1],
    ])('refuses %s', async (_case, expiresInHours) => {
      const { code, message } = await client().expectError(CREATE, { documentId: document.id, expiresInHours });
      expect(code).toBe(ErrorCode.BadUserInput);
      expect(message).toMatch(/A share link lasts at/);
      expect(await db.select().from(shareLinks)).toEqual([]);
    });

    it('refuses an expiry that is not a whole number of hours', () => {
      // GraphQL's Int refuses 1.5 before the resolver runs; the schema refuses it for any other caller.
      const parsed = expiryHoursSchema.safeParse(1.5);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toBe('A share link lasts a whole number of hours.');
    });

    it('trims a label, and keeps a blank one as none', async () => {
      expect((await share({ label: '  For Dana ' })).label).toBe('For Dana');
      expect((await share({ label: '   ' })).label).toBeNull();
    });

    it('refuses a label that is too long', async () => {
      const label = 'x'.repeat(SHARE_LINK_DEFAULTS.labelMaxLength + 1);
      expect((await client().expectError(CREATE, { documentId: document.id, label })).code).toBe(
        ErrorCode.BadUserInput,
      );
    });

    it('stores the URL sealed, never in the clear', async () => {
      const link = await share();
      const [row] = await db.select().from(shareLinks).where(eq(shareLinks.id, link.id));
      expect(row.urlEnc).not.toContain('memory.test');
      expect(row.urlEnc.startsWith('v1.')).toBe(true);
    });

    it('refuses a document still uploading', async () => {
      const pending = await insertDocument({ status: DocumentStatus.PendingUpload });
      const { code } = await client().expectError(CREATE, { documentId: pending.id });
      expect(code).toBe(ErrorCode.Conflict);
    });

    it('answers NOT_FOUND for someone else’s document and a missing one alike', async () => {
      for (const documentId of [document.id, MISSING_ID]) {
        expect((await other().expectError(CREATE, { documentId })).code).toBe(ErrorCode.NotFound);
      }
    });

    it('refuses a bucket whose secret can no longer be decrypted', async () => {
      const rotatedSecrets = createTestSecrets(ROTATED_SECRET);
      const rotated = createClient(db, owner, {
        backend,
        secrets: rotatedSecrets,
        storage: createStorageRegistry({ db, secrets: rotatedSecrets, factory: backend.factory }),
      });
      const { code, message } = await rotated.expectError(CREATE, { documentId: document.id });
      expect(code).toBe(ErrorCode.BadUserInput);
      expect(message).toMatch(/Enter it again/);
    });
  });

  describe('ShareLink.url and state', () => {
    it('opens the URL for the owner, the same one the mutation answered', async () => {
      const link = await share();
      const { document: read } = await client().expectOk(LINKS, { id: document.id });
      expect(read.shareLinks).toEqual([link]);
    });

    it('answers null for a URL sealed under a secret that has since changed', async () => {
      await share();
      const rotated = createClient(db, owner, { ...options(), secrets: createTestSecrets(ROTATED_SECRET) });
      const { document: read } = await rotated.expectOk(LINKS, { id: document.id });
      expect(read.shareLinks[0].url).toBeNull();
      expect(read.shareLinks[0].state).toBe(ShareLinkState.Active);
    });

    it('is expired once its time is up', async () => {
      const link = await share({ expiresInHours: 1 });
      vi.setSystemTime(new Date(NOW.getTime() + SECONDS_PER_HOUR * MS_PER_SECOND));
      expect((await client().expectOk(ALL_LINKS)).shareLinks).toEqual([{ id: link.id, state: ShareLinkState.Expired }]);
    });

    it('asks for the id, not NOT_FOUND, when it is left out of the selection', async () => {
      await share();
      const error = await client().expectError('{ shareLinks { label url } }');
      expect(error.code).toBe(ErrorCode.BadUserInput);
      expect(error.message).toMatch(/Select `id` alongside ShareLink\.url/);
    });

    it('decides revoked over expired', () => {
      const past = new Date(NOW.getTime() - 1);
      expect(shareLinkState({ objectKey: 'old', expiresAt: past }, 'new', NOW)).toBe(ShareLinkState.Revoked);
      expect(shareLinkState({ objectKey: 'same', expiresAt: past }, 'same', NOW)).toBe(ShareLinkState.Expired);
      expect(shareLinkState({ objectKey: 'same', expiresAt: NOW }, 'same', NOW)).toBe(ShareLinkState.Expired);
    });
  });

  describe('deleteShareLink', () => {
    it('removes the link from the list, and the URL still opens', async () => {
      const link = await share();
      expect(await client().expectOk(DELETE, { id: link.id })).toEqual({ deleteShareLink: true });
      expect((await client().expectOk(ALL_LINKS)).shareLinks).toEqual([]);
      expect((await backend.fetch(link.url)).status).toBe(HttpStatus.Ok);
    });

    it('answers NOT_FOUND for someone else’s link, and keeps it', async () => {
      const link = await share();
      for (const id of [link.id, MISSING_ID]) {
        expect((await other().expectError(DELETE, { id })).code).toBe(ErrorCode.NotFound);
      }
      expect((await client().expectOk(ALL_LINKS)).shareLinks).toHaveLength(1);
    });

    it('goes with its document', async () => {
      await share();
      await db.delete(documents).where(eq(documents.id, document.id));
      expect(await db.select().from(shareLinks)).toEqual([]);
    });
  });

  describe('rekeyDocument', () => {
    it('moves the object to a new key, so every old link is revoked and answers 404', async () => {
      const first = await share();
      const second = await share({ permission: 'view' });
      const { rekeyDocument } = await client().expectOk(REKEY, { id: document.id });

      expect(rekeyDocument.objectKey).not.toBe(document.objectKey);
      expect(rekeyDocument.objectKey).toMatch(/^[0-9a-f-]{36}-Quarterly-report\.pdf$/);
      expect(bucket.objects.has(document.objectKey)).toBe(false);
      expect(bucket.objects.get(rekeyDocument.objectKey)?.body.equals(BODY)).toBe(true);
      for (const link of [first, second]) {
        expect((await backend.fetch(link.url)).status).toBe(HttpStatus.NotFound);
      }
      const states = (await client().expectOk(ALL_LINKS)).shareLinks.map((link: { state: string }) => link.state);
      expect(states).toEqual([ShareLinkState.Revoked, ShareLinkState.Revoked]);

      const fresh = await share();
      expect(fresh.state).toBe(ShareLinkState.Active);
      expect((await backend.fetch(fresh.url)).status).toBe(HttpStatus.Ok);
    });

    it('moves a scanned file from the owner’s key to one the app makes', async () => {
      const scanned = await insertDocument({ objectKey: 'reports/2026/q3.pdf', filename: 'q3.pdf', sha256: null });
      const { rekeyDocument } = await client().expectOk(REKEY, { id: scanned.id });
      expect(rekeyDocument.objectKey).toMatch(/^[0-9a-f-]{36}-q3\.pdf$/);
      expect(bucket.objects.has('reports/2026/q3.pdf')).toBe(false);
    });

    it('changes nothing when the bucket refuses the copy', async () => {
      const link = await share();
      bucket.failures.copy = 'AccessDenied';
      const { code } = await client().expectError(REKEY, { id: document.id });
      expect(code).toBe(ErrorCode.StorageError);
      expect(await currentKey()).toBe(document.objectKey);
      expect((await backend.fetch(link.url)).status).toBe(HttpStatus.Ok);
    });

    it('stands when the old object cannot be deleted, logging what is left behind', async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await share();
      bucket.failures.delete = 'AccessDenied';
      const { rekeyDocument } = await client().expectOk(REKEY, { id: document.id });
      expect(await currentKey()).toBe(rekeyDocument.objectKey);
      expect(bucket.objects.has(document.objectKey)).toBe(true);
      expect(errors).toHaveBeenCalledWith(expect.stringContaining(`could not delete the old object`));
      expect((await client().expectOk(ALL_LINKS)).shareLinks[0].state).toBe(ShareLinkState.Revoked);
      errors.mockRestore();
    });

    it('refuses a document still uploading', async () => {
      const pending = await insertDocument({ status: DocumentStatus.PendingUpload });
      expect((await client().expectError(REKEY, { id: pending.id })).code).toBe(ErrorCode.Conflict);
    });

    it('answers NOT_FOUND for someone else’s document, and leaves it where it is', async () => {
      expect((await other().expectError(REKEY, { id: document.id })).code).toBe(ErrorCode.NotFound);
      expect(await currentKey()).toBe(document.objectKey);
    });
  });
});
