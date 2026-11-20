import { DocumentStatus, documents } from '@cubicecho/s3-artifacts-mcp-db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DOCUMENT_DEFAULTS, UPLOAD_DEFAULTS } from '../../core/defaults.ts';
import { ErrorCode } from '../../core/errors.ts';
import { DEFAULT_CONTENT_TYPE } from '../../documents/create.ts';
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
import { createMemoryBackend, type MemoryBackend } from '../memory-storage.ts';

const FIELDS = 'id userId bucketId title filename objectKey contentType size sha256 status';
const CREATE = `
  mutation ($bucketId: UUID!, $filename: String!, $contentType: String, $size: Float!) {
    createDocumentUpload(bucketId: $bucketId, filename: $filename, contentType: $contentType, size: $size) {
      uploadPath
      document { ${FIELDS} bucket { id name } }
    }
  }
`;
const RENAME = `mutation ($id: UUID!, $title: String!) { renameDocument(id: $id, title: $title) { id title filename objectKey } }`;
const DELETE = 'mutation ($id: UUID!) { deleteDocument(id: $id) }';
const CONTENT_URL =
  'query ($id: UUID!) { document(where: { id: { eq: $id } }) { contentUrl inline: contentUrl(download: false) download: contentUrl(download: true) } }';
const LIST = '{ documents { id } }';
const MISSING_ID = '00000000-0000-4000-8000-000000000000';
/** Bigger than a GraphQL Int can hold, which is why `size` is a Float. */
const THREE_GIB = 3 * 1024 * 1024 * 1024;

describe('document resolvers', () => {
  let db: TestDb;
  let owner: string;
  let stranger: string;
  let bucketId: string;
  let backend: MemoryBackend;
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
    storage = createStorageRegistry({ db, secrets, factory: backend.factory });
  });

  const options = (): ClientOptions => ({ backend, secrets, storage });
  const client = () => createClient(db, owner, options());
  const other = () => createClient(db, stranger, options());

  /** Starts an upload as the owner and returns the payload. */
  async function start(variables: Record<string, unknown> = {}) {
    const { createDocumentUpload } = await client().expectOk(CREATE, {
      bucketId,
      filename: 'Quarterly report.pdf',
      contentType: 'application/pdf',
      size: 1234,
      ...variables,
    });
    return createDocumentUpload;
  }

  describe('createDocumentUpload', () => {
    it('inserts a pending document in the named bucket and says where to send it', async () => {
      const upload = await start();
      const { document } = upload;
      expect(upload.uploadPath).toBe(`/api/documents/${document.id}/content`);
      expect(document).toMatchObject({
        userId: owner,
        bucketId,
        title: 'Quarterly report',
        filename: 'Quarterly report.pdf',
        objectKey: `${document.id}-Quarterly-report.pdf`,
        contentType: 'application/pdf',
        size: 1234,
        sha256: null,
        status: DocumentStatus.PendingUpload,
        bucket: { id: bucketId, name: 'Artifacts' },
      });
    });

    it('stores a file with no type as octet-stream', async () => {
      const { document } = await start({ contentType: null });
      expect(document.contentType).toBe(DEFAULT_CONTENT_TYPE);
    });

    it('carries a size past 2 GiB as far as the cap, where an Int would fail to parse', async () => {
      const { code, message } = await client().expectError(CREATE, { bucketId, filename: 'big.iso', size: THREE_GIB });
      expect(code).toBe(ErrorCode.BadUserInput);
      expect(message).toMatch(/MiB upload limit/);
    });

    it.each([
      ['an empty file', { size: 0 }],
      ['a fractional size', { size: 1.5 }],
      ['a file over the upload cap', { size: UPLOAD_DEFAULTS.maxUploadBytes + 1 }],
      ['an empty filename', { filename: '   ' }],
      ['a filename that is too long', { filename: 'x'.repeat(DOCUMENT_DEFAULTS.filenameMaxLength + 1) }],
      ['a filename with a control character', { filename: 'a\nb.txt' }],
      ['a content type that is not a MIME type', { contentType: 'pdf' }],
      ['a content type that could split a header', { contentType: 'text/plain\r\nx-evil: 1' }],
    ])('refuses %s', async (_case, variables) => {
      const { code } = await client().expectError(CREATE, {
        bucketId,
        filename: 'a.txt',
        size: 10,
        ...variables,
      });
      expect(code).toBe(ErrorCode.BadUserInput);
      expect((await client().expectOk(LIST)).documents).toEqual([]);
    });

    it('accepts exactly the cap', async () => {
      const { document } = await start({ size: UPLOAD_DEFAULTS.maxUploadBytes });
      expect(document.size).toBe(UPLOAD_DEFAULTS.maxUploadBytes);
    });

    it('answers NOT_FOUND for someone else’s bucket and a missing one alike', async () => {
      const strangersBucket = await insertBucket(db, secrets, stranger);
      for (const id of [strangersBucket, MISSING_ID]) {
        const { code } = await client().expectError(CREATE, { bucketId: id, filename: 'a.txt', size: 1 });
        expect(code).toBe(ErrorCode.NotFound);
      }
    });

    it('refuses a bucket whose secret can no longer be decrypted, saying what to do', async () => {
      const rotated = await insertBucket(db, createTestSecrets('another-secret-0123456789abcdef0123'), owner, {
        name: 'Rotated',
      });
      const { code, message } = await client().expectError(CREATE, { bucketId: rotated, filename: 'a.txt', size: 1 });
      expect(code).toBe(ErrorCode.BadUserInput);
      expect(message).toMatch(/Rotated.*Enter it again/);
    });

    it('refuses the unauthenticated', async () => {
      const anonymous = createClient(db, null, options());
      const { code } = await anonymous.expectError(CREATE, { bucketId, filename: 'a.txt', size: 1 });
      expect(code).toBe(ErrorCode.Unauthenticated);
    });
  });

  describe('reads', () => {
    it('lists the caller’s documents through the bucket, and none of another’s', async () => {
      const { document } = await start();
      const { buckets } = await client().expectOk('{ buckets { id documents { id } } }');
      expect(buckets).toEqual([{ id: bucketId, documents: [{ id: document.id }] }]);
      expect((await other().expectOk(LIST)).documents).toEqual([]);
    });
  });

  describe('renameDocument', () => {
    it('changes the title and nothing else', async () => {
      const { document } = await start();
      const { renameDocument } = await client().expectOk(RENAME, { id: document.id, title: '  Q3 numbers ' });
      expect(renameDocument).toEqual({
        id: document.id,
        title: 'Q3 numbers',
        filename: document.filename,
        objectKey: document.objectKey,
      });
    });

    it.each([
      ['an empty title', '  '],
      ['a title that is too long', 'x'.repeat(DOCUMENT_DEFAULTS.titleMaxLength + 1)],
    ])('refuses %s', async (_case, title) => {
      const { document } = await start();
      expect((await client().expectError(RENAME, { id: document.id, title })).code).toBe(ErrorCode.BadUserInput);
    });

    it('answers NOT_FOUND for someone else’s document, and leaves it alone', async () => {
      const { document } = await start();
      expect((await other().expectError(RENAME, { id: document.id, title: 'Mine' })).code).toBe(ErrorCode.NotFound);
      const [row] = await db.select().from(documents).where(eq(documents.id, document.id));
      expect(row.title).toBe('Quarterly report');
    });
  });

  describe('deleteDocument', () => {
    it('deletes the object, then the row', async () => {
      const { document } = await start();
      const bucket = backend.bucket('artifacts');
      bucket.objects.set(document.objectKey, { body: Buffer.from('bytes'), contentType: 'application/pdf' });
      expect(await client().expectOk(DELETE, { id: document.id })).toEqual({ deleteDocument: true });
      expect(bucket.objects.has(document.objectKey)).toBe(false);
      expect((await client().expectOk(LIST)).documents).toEqual([]);
    });

    it('deletes a document whose object is already gone', async () => {
      const { document } = await start();
      expect(await client().expectOk(DELETE, { id: document.id })).toEqual({ deleteDocument: true });
    });

    it('keeps the document when the bucket refuses the delete', async () => {
      const { document } = await start();
      backend.bucket('artifacts').failures.delete = 'AccessDenied';
      const { code } = await client().expectError(DELETE, { id: document.id });
      expect(code).toBe(ErrorCode.StorageError);
      expect((await client().expectOk(LIST)).documents).toEqual([{ id: document.id }]);
    });

    it('answers NOT_FOUND for someone else’s document, and keeps it', async () => {
      const { document } = await start();
      expect((await other().expectError(DELETE, { id: document.id })).code).toBe(ErrorCode.NotFound);
      expect((await client().expectOk(LIST)).documents).toEqual([{ id: document.id }]);
    });
  });

  describe('Document.contentUrl', () => {
    it('signs a relative URL, inline by default and an attachment when asked', async () => {
      const { document } = await start();
      const { document: read } = await client().expectOk(CONTENT_URL, { id: document.id });
      const path = `/api/documents/${document.id}/content?t=`;
      expect(read.contentUrl.startsWith(path)).toBe(true);
      expect(read.contentUrl).not.toContain('download=');
      expect(read.inline.startsWith(path)).toBe(true);
      expect(read.download).toMatch(new RegExp(`^${path.replace('?', '\\?')}[^&]+&download=1$`));
    });

    it('asks for the id, not NOT_FOUND, when other columns are selected without it', async () => {
      // drizzle-graphql adds the primary key only when a query names no column at all.
      const { document } = await start();
      const query = 'query ($id: UUID!) { document(where: { id: { eq: $id } }) { title contentUrl } }';
      const error = await client().expectError(query, { id: document.id });
      expect(error.code).toBe(ErrorCode.BadUserInput);
      expect(error.message).toMatch(/Select `id` alongside Document\.contentUrl/);
    });
  });
});
