import { createHash, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { Readable } from 'node:stream';
import { buffer, text } from 'node:stream/consumers';
import { ListMultipartUploadsCommand, S3Client } from '@aws-sdk/client-s3';
import { DocumentStatus, documents } from '@cubicecho/s3-artifacts-mcp-db/schema';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedAuthHost } from '../../auth/auth-host.ts';
import { createRateLimiter } from '../../auth/rate-limit.ts';
import { runBucketTest } from '../../buckets/test.ts';
import type { Context } from '../../core/context.ts';
import { UPLOAD_DEFAULTS } from '../../core/defaults.ts';
import { SecretPurpose } from '../../core/secrets.ts';
import { HttpStatus } from '../../core/wire.ts';
import { objectKeyFor } from '../../documents/keys.ts';
import { scanBucket } from '../../documents/scan.ts';
import { createApp } from '../../http/app.ts';
import { createStorageRegistry } from '../../storage/registry.ts';
import { createS3Storage } from '../../storage/s3.ts';
import { Disposition } from '../../storage/storage.ts';
import {
  closeTestDb,
  createClient,
  createSessionToken,
  createTestAuth,
  createTestDb,
  createTestSecrets,
  createUser,
  insertBucket,
  type TestDb,
} from '../helpers.ts';

// Against a real S3-compatible service, which an in-memory storage cannot stand in for: signing,
// path style, the checksum settings and the share link's host. Skipped unless S3AM_IT_ENDPOINT is
// set, e.g. for the dev RustFS:
//
//   S3AM_IT_ENDPOINT=http://localhost:9010 S3AM_IT_BUCKET=artifacts \
//   S3AM_IT_ACCESS_KEY=s3am S3AM_IT_SECRET_KEY=s3am-dev-secret npx vitest run --project node s3.integration
//
// The streamed uploads are bigger than one part (`UPLOAD_DEFAULTS.partSizeBytes`), so they take
// lib-storage's multipart path, with the clients' WHEN_REQUIRED checksum setting.

const { S3AM_IT_ENDPOINT, S3AM_IT_BUCKET, S3AM_IT_ACCESS_KEY, S3AM_IT_SECRET_KEY, S3AM_IT_REGION } = process.env;
const isConfigured = (S3AM_IT_ENDPOINT ?? '') !== '';

describe.skipIf(isConfigured === false)('S3 storage against a real service', () => {
  const connection = {
    endpoint: S3AM_IT_ENDPOINT ?? null,
    publicEndpoint: null,
    region: S3AM_IT_REGION ?? 'us-east-1',
    bucket: S3AM_IT_BUCKET ?? 'artifacts',
    accessKeyId: S3AM_IT_ACCESS_KEY ?? '',
    forcePathStyle: true,
  };
  const storage = createS3Storage(connection, S3AM_IT_SECRET_KEY ?? '');

  it('passes the bucket test', async () => {
    const result = await runBucketTest(storage);
    expect(result.steps.filter((step) => step.ok === false)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('fails HeadBucket with a wrong secret, naming the status', async () => {
    const result = await runBucketTest(createS3Storage(connection, 'not-the-secret'));
    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({ step: 'HEAD_BUCKET', ok: false });
    expect(result.steps[0].errorCode).toMatch(/^(HTTP_403|Forbidden|AccessDenied|SignatureDoesNotMatch)$/);
  });

  it('uploads, heads, ranges, copies, shares and deletes', async () => {
    const key = `.s3am-it-${Date.now()}`;
    const copy = `${key}-copy`;
    await storage.upload(key, 'hello, bucket', { contentType: 'text/plain', size: 13 });
    expect(await storage.head(key)).toEqual({ size: 13, contentType: 'text/plain' });
    expect(await text(await storage.getStream(key, { first: 7, last: 12 }))).toBe('bucket');
    await storage.copy(key, copy);
    const url = await storage.presignGet(copy, {
      filename: 'hello.txt',
      contentType: 'text/plain',
      disposition: Disposition.Attachment,
      expiresInSeconds: 60,
    });
    const response = await fetch(url);
    expect(await response.text()).toBe('hello, bucket');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="hello.txt"/);
    await storage.delete([key, copy]);
    expect(await storage.head(key)).toBeNull();
    expect(await storage.head(copy)).toBeNull();
  });

  it('lists objects, nested keys included, with their sizes', async () => {
    const prefix = `.s3am-it-list-${Date.now()}`;
    const keys = [`${prefix}/a.txt`, `${prefix}/deeper/b.txt`, `${prefix}-c.txt`];
    for (const key of keys) {
      await storage.upload(key, key, { contentType: 'text/plain', size: Buffer.byteLength(key) });
    }
    try {
      const found = new Map<string, number>();
      for await (const page of storage.listObjects()) {
        for (const object of page) {
          found.set(object.key, object.size);
        }
      }
      for (const key of keys) {
        expect(found.get(key)).toBe(Buffer.byteLength(key));
      }
    } finally {
      await storage.delete(keys);
    }
  });
});

/** Past one part, so a streamed upload is multipart: one full part and a short last one. */
const MULTIPART_BYTES = UPLOAD_DEFAULTS.partSizeBytes + 1_048_576;

/**
 * A body that arrives in 64 KiB chunks, as a request body does, and optionally fails part way.
 *
 * @param bytes - What it carries.
 * @param [failAfter] - Fails once this many bytes have passed.
 * @returns The stream.
 */
function streamed(bytes: Buffer, failAfter: number | null = null): Readable {
  const chunkBytes = 65_536;
  let offset = 0;
  return new Readable({
    read() {
      const isFailing = failAfter !== null && offset >= failAfter;
      if (isFailing) {
        this.destroy(new Error('The client went away.'));
        return;
      }
      if (offset >= bytes.length) {
        this.push(null);
        return;
      }
      this.push(bytes.subarray(offset, offset + chunkBytes));
      offset += chunkBytes;
    },
  });
}

/** Several megabytes each way, to a service that may sit on a NAS's disks. */
const STREAM_TIMEOUT_MS = 120_000;

describe.skipIf(isConfigured === false)(
  'streamed uploads against a real service',
  { timeout: STREAM_TIMEOUT_MS },
  () => {
    const connection = {
      endpoint: S3AM_IT_ENDPOINT ?? null,
      publicEndpoint: null,
      region: S3AM_IT_REGION ?? 'us-east-1',
      bucket: S3AM_IT_BUCKET ?? 'artifacts',
      accessKeyId: S3AM_IT_ACCESS_KEY ?? '',
      forcePathStyle: true,
    };
    const storage = createS3Storage(connection, S3AM_IT_SECRET_KEY ?? '');
    const bytes = randomBytes(MULTIPART_BYTES);

    it('streams a multipart body, then reads a range of it back', async () => {
      const key = `.s3am-it-stream-${Date.now()}`;
      await storage.uploadStream(key, streamed(bytes), { contentType: 'application/octet-stream', size: bytes.length });
      try {
        expect(await storage.head(key)).toEqual({ size: bytes.length, contentType: 'application/octet-stream' });
        const last = bytes.length - 1;
        const tail = await buffer(await storage.getStream(key, { first: last - 99, last }));
        expect(tail.equals(bytes.subarray(last - 99))).toBe(true);
      } finally {
        await storage.delete([key]);
      }
    });

    it('copies an object past the single-copy limit in parts, its bytes and type kept', async () => {
      const key = `.s3am-it-copy-${Date.now()}`;
      const copy = `${key}-copy`;
      // Five MiB is S3's smallest part, so the 9 MiB body goes as two.
      const inParts = createS3Storage(connection, S3AM_IT_SECRET_KEY ?? '', {
        maxSingleCopyBytes: 5_242_880,
        copyPartSizeBytes: 5_242_880,
      });
      await inParts.uploadStream(key, streamed(bytes), { contentType: 'application/x-it', size: bytes.length });
      try {
        await inParts.copy(key, copy);
        expect(await inParts.head(copy)).toEqual({ size: bytes.length, contentType: 'application/x-it' });
        expect((await buffer(await inParts.getStream(copy))).equals(bytes)).toBe(true);
      } finally {
        await inParts.delete([key, copy]);
      }
    });

    it('aborts the multipart upload when the body fails, leaving no object and no parts', async () => {
      const key = `.s3am-it-abort-${Date.now()}`;
      const failing = streamed(bytes, UPLOAD_DEFAULTS.partSizeBytes + 65_536);
      await expect(
        storage.uploadStream(key, failing, { contentType: 'application/octet-stream', size: bytes.length }),
      ).rejects.toThrow('The client went away.');
      expect(await storage.head(key)).toBeNull();
      const client = new S3Client({
        endpoint: connection.endpoint ?? undefined,
        region: connection.region,
        credentials: { accessKeyId: connection.accessKeyId, secretAccessKey: S3AM_IT_SECRET_KEY ?? '' },
        forcePathStyle: true,
      });
      const { Uploads = [] } = await client.send(
        new ListMultipartUploadsCommand({ Bucket: connection.bucket, Prefix: key }),
      );
      expect(Uploads).toEqual([]);
    });

    describe('through the app’s content routes', () => {
      let db: TestDb;
      let server: Server;
      let origin: string;
      let token: string;
      let bucketId: string;
      let owner: string;
      let scanContext: Context;

      beforeAll(async () => {
        db = await createTestDb();
        const auth = createTestAuth(db).auth;
        const secrets = createTestSecrets();
        owner = await createUser(db, 'owner@example.com');
        token = await createSessionToken(auth, owner);
        const registry = createStorageRegistry({ db, secrets });
        scanContext = { db, userId: owner, secrets, storage: registry } as unknown as Context;
        bucketId = await insertBucket(db, secrets, owner, {
          endpoint: connection.endpoint,
          region: connection.region,
          bucket: connection.bucket,
          accessKeyId: connection.accessKeyId,
          secretAccessKeyEnc: secrets.seal(S3AM_IT_SECRET_KEY ?? '', SecretPurpose.BucketSecret),
        });
        const app = createApp({
          db,
          authHost: fixedAuthHost(auth),
          limiter: createRateLimiter(),
          storage: registry,
          secrets,
        });
        server = await new Promise<Server>((resolve) => {
          const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
        });
        const address = server.address();
        if (address === null || typeof address === 'string') {
          throw new Error('expected the test server to listen on a TCP port');
        }
        origin = `http://127.0.0.1:${address.port}`;
      }, STREAM_TIMEOUT_MS);

      afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
        await closeTestDb(db);
      });

      it('PUTs a file into the bucket, then serves a range of it', async () => {
        const id = crypto.randomUUID();
        const objectKey = objectKeyFor(id, 'it-upload.bin');
        await db.insert(documents).values({
          id,
          userId: owner,
          bucketId,
          title: 'it-upload',
          filename: 'it-upload.bin',
          objectKey,
          contentType: 'application/octet-stream',
          size: bytes.length,
          status: DocumentStatus.PendingUpload,
        });
        const path = `${origin}/api/documents/${id}/content`;
        const authorization = `Bearer ${token}`;
        try {
          const put = await fetch(path, { method: 'PUT', headers: { authorization }, body: new Uint8Array(bytes) });
          expect(put.status).toBe(HttpStatus.Ok);
          const uploaded = await put.json();
          expect(uploaded.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));

          const range = await fetch(path, { headers: { authorization, range: 'bytes=1000-1999' } });
          expect(range.status).toBe(HttpStatus.PartialContent);
          expect(range.headers.get('content-range')).toBe(`bytes 1000-1999/${bytes.length}`);
          expect(Buffer.from(await range.arrayBuffer()).equals(bytes.subarray(1000, 2000))).toBe(true);
        } finally {
          await storage.delete([objectKey]);
        }
      });

      describe('share links', () => {
        const SHARE = `
          mutation ($documentId: UUID!, $permission: ShareLinkPermission) {
            createShareLink(documentId: $documentId, permission: $permission, expiresInHours: 1) { id url state }
          }
        `;
        const body = 'shared straight from the bucket';
        let documentId: string;
        let objectKey: string;

        /** The owner's GraphQL client, over the real bucket. */
        const owners = () => createClient(db, owner, { secrets: scanContext.secrets, storage: scanContext.storage });

        beforeAll(async () => {
          documentId = crypto.randomUUID();
          objectKey = objectKeyFor(documentId, 'Shared notes.txt');
          await storage.upload(objectKey, body, { contentType: 'binary/octet-stream', size: Buffer.byteLength(body) });
          await db.insert(documents).values({
            id: documentId,
            userId: owner,
            bucketId,
            title: 'Shared notes',
            filename: 'Shared notes.txt',
            objectKey,
            contentType: 'text/plain',
            size: Buffer.byteLength(body),
            status: DocumentStatus.Ready,
          });
        });

        afterAll(async () => {
          const [row] = await db.select().from(documents).where(eq(documents.id, documentId));
          await storage.delete([objectKey, ...(row === undefined ? [] : [row.objectKey])]);
        });

        it('opens with no credentials, as the document’s type and the disposition asked for', async () => {
          const { createShareLink: download } = await owners().expectOk(SHARE, { documentId, permission: 'download' });
          const saved = await fetch(download.url);
          expect(saved.status).toBe(HttpStatus.Ok);
          expect(await saved.text()).toBe(body);
          expect(saved.headers.get('content-type')).toBe('text/plain');
          expect(saved.headers.get('content-disposition')).toBe(
            `attachment; filename="Shared notes.txt"; filename*=UTF-8''Shared%20notes.txt`,
          );

          const { createShareLink: view } = await owners().expectOk(SHARE, { documentId, permission: 'view' });
          const shown = await fetch(view.url);
          expect(await shown.text()).toBe(body);
          expect(shown.headers.get('content-disposition')).toMatch(/^inline; filename="Shared notes.txt"/);
        });

        it('answers 404 for every old link once the document is re-keyed, and serves the new key', async () => {
          const { createShareLink: before } = await owners().expectOk(SHARE, { documentId });
          expect((await fetch(before.url)).status).toBe(HttpStatus.Ok);

          const { rekeyDocument } = await owners().expectOk(
            'mutation ($id: UUID!) { rekeyDocument(id: $id) { objectKey } }',
            { id: documentId },
          );
          expect(rekeyDocument.objectKey).not.toBe(objectKey);
          expect((await fetch(before.url)).status).toBe(HttpStatus.NotFound);
          expect(await storage.head(objectKey)).toBeNull();
          expect(await storage.head(rekeyDocument.objectKey)).toMatchObject({ size: Buffer.byteLength(body) });

          const { createShareLink: after } = await owners().expectOk(SHARE, { documentId });
          const reopened = await fetch(after.url);
          expect(await reopened.text()).toBe(body);
          const { shareLinks } = await owners().expectOk('{ shareLinks { id state } }');
          expect(shareLinks.find((link: { id: string }) => link.id === before.id).state).toBe('revoked');
          expect(shareLinks.find((link: { id: string }) => link.id === after.id).state).toBe('active');
        });
      });

      it('adds a file another tool put in the bucket, then serves it where it already was', async () => {
        const key = `.s3am-it-scan-${Date.now()}/Field notes.md`;
        const body = '# Found by a scan';
        await storage.upload(key, body, { contentType: 'text/markdown', size: Buffer.byteLength(body) });
        try {
          // The dev bucket may hold other objects; this database is the test's own, so they come and go with it.
          const result = await scanBucket(scanContext, bucketId);
          expect(result.imported).toBeGreaterThanOrEqual(1);
          const [row] = await db
            .select()
            .from(documents)
            .where(and(eq(documents.bucketId, bucketId), eq(documents.objectKey, key)));
          expect(row).toMatchObject({ filename: 'Field notes.md', contentType: 'text/markdown', sha256: null });

          const read = await fetch(`${origin}/api/documents/${row.id}/content`, {
            headers: { authorization: `Bearer ${token}` },
          });
          expect(read.status).toBe(HttpStatus.Ok);
          expect(await read.text()).toBe(body);
          expect((await scanBucket(scanContext, bucketId)).imported).toBe(0);
        } finally {
          await storage.delete([key]);
        }
      });
    });
  },
);
