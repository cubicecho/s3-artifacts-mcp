import { createHash } from 'node:crypto';
import { request as httpRequest, type Server } from 'node:http';
import { type Document, DocumentStatus, documents } from '@cubicecho/s3-artifacts-mcp-db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedAuthHost } from '../../auth/auth-host.ts';
import type { Auth } from '../../auth/better-auth.ts';
import { createRateLimiter } from '../../auth/rate-limit.ts';
import { CONTENT_DEFAULTS } from '../../core/defaults.ts';
import { ErrorCode } from '../../core/errors.ts';
import { HttpStatus, MS_PER_SECOND, SECONDS_PER_MINUTE } from '../../core/wire.ts';
import { signedContentUrl } from '../../documents/content-url.ts';
import { SANDBOX_POLICY } from '../../documents/download.ts';
import { objectKeyFor } from '../../documents/keys.ts';
import { createApp } from '../../http/app.ts';
import {
  closeTestDb,
  createSessionToken,
  createTestAuth,
  createTestDb,
  createTestStorageDeps,
  createUser,
  insertBucket,
  resetTestDb,
  type TestDb,
  type TestStorageDeps,
} from '../helpers.ts';
import type { MemoryStorage } from '../memory-storage.ts';

// The two content routes over a real socket, against in-memory storage: the upload's length and
// lifecycle rules, the download's ranges and headers, and who may reach either.

/** Every byte value, twice, so a text-only path would mangle it. */
const BINARY = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, index) => index)), Buffer.alloc(256, 7)]);
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

/**
 * The SHA-256 of some bytes, in hex.
 *
 * @param bytes - The bytes.
 * @returns The digest.
 */
function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * A body that arrives in several chunks with no declared length, as a chunked upload does.
 *
 * @param bytes - What it carries.
 * @param [chunkBytes] - How much each chunk holds.
 * @returns The stream.
 */
function chunked(bytes: Buffer, chunkBytes = 100): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(bytes.subarray(offset, offset + chunkBytes)));
      offset += chunkBytes;
    },
  });
}

describe('document content routes', () => {
  let db: TestDb;
  let auth: Auth;
  let server: Server;
  let origin: string;
  let deps: TestStorageDeps;
  let bucket: MemoryStorage;
  let owner: string;
  let ownerToken: string;
  let strangerToken: string;
  let bucketId: string;

  beforeAll(async () => {
    db = await createTestDb();
    auth = createTestAuth(db).auth;
    deps = createTestStorageDeps(db);
    const app = createApp({ db, authHost: fixedAuthHost(auth), limiter: createRateLimiter(), ...deps });
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected the test server to listen on a TCP port');
    }
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeTestDb(db);
  });

  beforeEach(async () => {
    await resetTestDb(db);
    bucket = deps.backend.bucket('artifacts');
    bucket.objects.clear();
    for (const operation of Object.keys(bucket.failures)) {
      delete bucket.failures[operation as keyof typeof bucket.failures];
    }
    owner = await createUser(db, 'owner@example.com');
    const stranger = await createUser(db, 'stranger@example.com');
    ownerToken = await createSessionToken(auth, owner);
    strangerToken = await createSessionToken(auth, stranger);
    // The registry caches a bucket's storage by id; ids are new after every reset.
    bucketId = await insertBucket(db, deps.secrets, owner);
  });

  /**
   * Inserts a document as `createDocumentUpload` would.
   *
   * @param overrides - Columns to change.
   * @returns The row.
   */
  async function pending(overrides: Partial<Document> = {}): Promise<Document> {
    const id = crypto.randomUUID();
    const filename = overrides.filename ?? 'Résumé 2026.bin';
    const [row] = await db
      .insert(documents)
      .values({
        id,
        userId: owner,
        bucketId,
        title: 'Résumé 2026',
        filename,
        objectKey: objectKeyFor(id, filename),
        contentType: 'application/octet-stream',
        size: BINARY.length,
        status: DocumentStatus.PendingUpload,
        ...overrides,
      })
      .returning();
    return row;
  }

  /**
   * Inserts a document whose bytes are already in the bucket.
   *
   * @param bytes - Its bytes.
   * @param overrides - Columns to change.
   * @returns The row.
   */
  async function ready(bytes: Buffer, overrides: Partial<Document> = {}): Promise<Document> {
    const row = await pending({
      size: bytes.length,
      status: DocumentStatus.Ready,
      sha256: sha256(bytes),
      ...overrides,
    });
    bucket.objects.set(row.objectKey, { body: bytes, contentType: row.contentType });
    return row;
  }

  /**
   * Reads a document's row again.
   *
   * @param id - The document.
   * @returns The row, or undefined once it is gone.
   */
  async function reread(id: string): Promise<Document | undefined> {
    const [row] = await db.select().from(documents).where(eq(documents.id, id));
    return row;
  }

  const url = (id: string, query = ''): string => `${origin}/api/documents/${id}/content${query}`;
  const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

  /**
   * Sends a body to a document's upload path.
   *
   * @param id - The document.
   * @param body - What to send.
   * @param [headers] - The request's headers; the owner's session unless given.
   * @returns The response.
   */
  function put(id: string, body: BodyInit, headers: Record<string, string> = bearer(ownerToken)): Promise<Response> {
    // `duplex` is required for a stream body, and harmless for the rest.
    return fetch(url(id), { method: 'PUT', headers, body, duplex: 'half' } as RequestInit);
  }

  describe('PUT', () => {
    it('stores exactly the declared bytes and makes the document ready with their SHA-256', async () => {
      const document = await pending();
      const response = await put(document.id, chunked(BINARY));
      expect(response.status).toBe(HttpStatus.Ok);
      expect(await response.json()).toEqual({
        id: document.id,
        status: DocumentStatus.Ready,
        size: BINARY.length,
        sha256: sha256(BINARY),
      });
      expect(bucket.objects.get(document.objectKey)).toEqual({ body: BINARY, contentType: document.contentType });
      expect(await reread(document.id)).toMatchObject({ status: DocumentStatus.Ready, sha256: sha256(BINARY) });
    });

    it('takes a body with its length declared', async () => {
      const document = await pending();
      const response = await put(document.id, new Uint8Array(BINARY));
      expect(response.status).toBe(HttpStatus.Ok);
    });

    it.each([
      ['shorter', BINARY.subarray(0, 100), HttpStatus.BadRequest],
      ['longer', Buffer.concat([BINARY, Buffer.from('extra')]), HttpStatus.PayloadTooLarge],
    ])('refuses a %s body and leaves neither row nor object', async (_case, body, status) => {
      const document = await pending();
      const response = await put(document.id, chunked(body));
      expect(response.status).toBe(status);
      expect((await response.json()).error.code).toBe(ErrorCode.BadUserInput);
      expect(await reread(document.id)).toBeUndefined();
      expect(bucket.objects.has(document.objectKey)).toBe(false);
    });

    it('refuses a request whose Content-Length is not the declared size, before reading it', async () => {
      const document = await pending();
      const response = await put(document.id, new Uint8Array(BINARY.subarray(0, 10)));
      expect(response.status).toBe(HttpStatus.BadRequest);
      expect(await reread(document.id)).toBeUndefined();
    });

    it('cleans up after a client that goes away mid-body', async () => {
      const document = await pending();
      const { port } = new URL(origin);
      const request = httpRequest({
        host: '127.0.0.1',
        port,
        method: 'PUT',
        path: `/api/documents/${document.id}/content`,
        headers: { ...bearer(ownerToken), 'content-length': String(document.size) },
      });
      request.on('error', () => {});
      request.write(BINARY.subarray(0, 50));
      await vi.waitFor(() => expect(bucket.inFlight.has(document.objectKey)).toBe(true));
      request.destroy();
      await vi.waitFor(async () => expect(await reread(document.id)).toBeUndefined());
      expect(bucket.inFlight.size).toBe(0);
      expect(bucket.objects.has(document.objectKey)).toBe(false);
    });

    it('removes the document when the bucket refuses the upload', async () => {
      const document = await pending();
      bucket.failures.uploadStream = 'AccessDenied';
      const response = await put(document.id, new Uint8Array(BINARY));
      expect(response.status).toBe(HttpStatus.BadGateway);
      const { error } = await response.json();
      expect(error.code).toBe(ErrorCode.StorageError);
      expect(error.message).toContain('AccessDenied');
      expect(await reread(document.id)).toBeUndefined();
    });

    it('answers 409 to a second upload of a ready document, and keeps it', async () => {
      const document = await pending();
      expect((await put(document.id, new Uint8Array(BINARY))).status).toBe(HttpStatus.Ok);
      const again = await put(document.id, new Uint8Array(BINARY));
      expect(again.status).toBe(HttpStatus.Conflict);
      expect((await again.json()).error.code).toBe(ErrorCode.Conflict);
      expect(await reread(document.id)).toMatchObject({ status: DocumentStatus.Ready });
      expect(bucket.objects.has(document.objectKey)).toBe(true);
    });

    it.each([
      ['no session', {}],
      ['a token that is no session', { authorization: 'Bearer not-a-session' }],
      ['an API key', { authorization: 'Bearer s3a_notasession', 'x-api-key': 's3a_notasession' }],
    ])('answers 401 to %s, and keeps the document', async (_case, headers) => {
      const document = await pending();
      const response = await put(document.id, new Uint8Array(BINARY), headers);
      expect(response.status).toBe(HttpStatus.Unauthorized);
      expect((await response.json()).error.code).toBe(ErrorCode.Unauthenticated);
      expect(await reread(document.id)).toMatchObject({ status: DocumentStatus.PendingUpload });
    });

    it('answers 404 for someone else’s document, a missing one and a malformed id, and keeps the first', async () => {
      const document = await pending();
      for (const [id, token] of [
        [document.id, strangerToken],
        [MISSING_ID, ownerToken],
        ['not-a-uuid', ownerToken],
      ]) {
        const response = await put(id, new Uint8Array(BINARY), bearer(token));
        expect(response.status).toBe(HttpStatus.NotFound);
        expect((await response.json()).error.code).toBe(ErrorCode.NotFound);
      }
      expect(await reread(document.id)).toMatchObject({ status: DocumentStatus.PendingUpload });
    });

    it('sends no CORS headers', async () => {
      const document = await pending();
      const response = await put(document.id, new Uint8Array(BINARY), {
        ...bearer(ownerToken),
        origin: 'https://elsewhere.example',
      });
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  describe('GET', () => {
    it('streams the whole file with its type, length and an inline disposition', async () => {
      const document = await ready(BINARY);
      const response = await fetch(url(document.id), { headers: bearer(ownerToken) });
      expect(response.status).toBe(HttpStatus.Ok);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(BINARY);
      expect(response.headers.get('content-type')).toBe('application/octet-stream');
      expect(response.headers.get('content-length')).toBe(String(BINARY.length));
      expect(response.headers.get('accept-ranges')).toBe('bytes');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('content-disposition')).toBe(
        `inline; filename="R_sum_ 2026.bin"; filename*=UTF-8''R%C3%A9sum%C3%A9%202026.bin`,
      );
    });

    it('answers HEAD with the headers alone', async () => {
      const document = await ready(BINARY);
      const response = await fetch(url(document.id), { method: 'HEAD', headers: bearer(ownerToken) });
      expect(response.status).toBe(HttpStatus.Ok);
      expect(response.headers.get('content-length')).toBe(String(BINARY.length));
      expect(await response.text()).toBe('');
    });

    it.each([
      ['the first bytes', 'bytes=0-9', 0, 9],
      ['a suffix', 'bytes=-16', BINARY.length - 16, BINARY.length - 1],
      ['an open end', 'bytes=500-', 500, BINARY.length - 1],
      ['a range past the end, clipped', 'bytes=500-100000', 500, BINARY.length - 1],
    ])('answers %s with 206 and that part', async (_case, range, first, last) => {
      const document = await ready(BINARY);
      const response = await fetch(url(document.id), { headers: { ...bearer(ownerToken), range } });
      expect(response.status).toBe(HttpStatus.PartialContent);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(BINARY.subarray(first, last + 1));
      expect(response.headers.get('content-range')).toBe(`bytes ${first}-${last}/${BINARY.length}`);
      expect(response.headers.get('content-length')).toBe(String(last - first + 1));
    });

    it.each(['bytes=600-', 'bytes=-0'])('answers %s with 416 and the size', async (range) => {
      const document = await ready(BINARY);
      const response = await fetch(url(document.id), { headers: { ...bearer(ownerToken), range } });
      expect(response.status).toBe(HttpStatus.RangeNotSatisfiable);
      expect(response.headers.get('content-range')).toBe(`bytes */${BINARY.length}`);
    });

    it.each(['bytes=0-1,4-5', 'items=0-1', 'bytes=9-2'])('ignores a range it does not serve (%s)', async (range) => {
      const document = await ready(BINARY);
      const response = await fetch(url(document.id), { headers: { ...bearer(ownerToken), range } });
      expect(response.status).toBe(HttpStatus.Ok);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(BINARY);
    });

    it('sends an attachment when asked', async () => {
      const document = await ready(BINARY, { filename: 'notes.txt' });
      const response = await fetch(url(document.id, '?download=1'), { headers: bearer(ownerToken) });
      expect(response.headers.get('content-disposition')).toBe(
        `attachment; filename="notes.txt"; filename*=UTF-8''notes.txt`,
      );
      expect(response.headers.get('content-security-policy')).toBe(SANDBOX_POLICY);
    });

    it.each(['text/html; charset=utf-8', 'image/svg+xml', 'application/xhtml+xml', 'text/markdown'])(
      'sandboxes %s shown inline, so it cannot script the app’s origin',
      async (contentType) => {
        const document = await ready(Buffer.from('<script>alert(1)</script>'), { contentType });
        const response = await fetch(url(document.id), { headers: bearer(ownerToken) });
        expect(response.headers.get('content-type')).toBe(contentType);
        expect(response.headers.get('content-security-policy')).toBe(SANDBOX_POLICY);
        expect(response.headers.get('content-security-policy')).toMatch(/^sandbox;/);
      },
    );

    it.each(['application/pdf', 'image/png', 'video/mp4', 'text/plain'])(
      'shows %s inline without a sandbox, which would stop the browser’s viewer',
      async (contentType) => {
        const document = await ready(BINARY, { contentType });
        const response = await fetch(url(document.id), { headers: bearer(ownerToken) });
        expect(response.headers.get('content-security-policy')).toBeNull();
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      },
    );

    it('answers 404 for a document still waiting for its bytes', async () => {
      const document = await pending();
      expect((await fetch(url(document.id), { headers: bearer(ownerToken) })).status).toBe(HttpStatus.NotFound);
    });

    it('answers 404 when the object has gone from the bucket', async () => {
      const document = await ready(BINARY);
      bucket.objects.delete(document.objectKey);
      expect((await fetch(url(document.id), { headers: bearer(ownerToken) })).status).toBe(HttpStatus.NotFound);
    });

    it('answers 401 with no session, and 404 for someone else’s document', async () => {
      const document = await ready(BINARY);
      expect((await fetch(url(document.id))).status).toBe(HttpStatus.Unauthorized);
      expect((await fetch(url(document.id), { headers: bearer(strangerToken) })).status).toBe(HttpStatus.NotFound);
    });
  });

  describe('signed URLs', () => {
    /** The time a URL made this long ago is made at. */
    const ago = (minutes: number): Date => new Date(Date.now() - minutes * SECONDS_PER_MINUTE * MS_PER_SECOND);

    it('reads a document with no session while the URL is fresh', async () => {
      const document = await ready(BINARY);
      const response = await fetch(`${origin}${signedContentUrl(deps.secrets, document, false)}`);
      expect(response.status).toBe(HttpStatus.Ok);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(BINARY);
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    });

    it('honours a range and the download flag it was signed with', async () => {
      const document = await ready(BINARY);
      const response = await fetch(`${origin}${signedContentUrl(deps.secrets, document, true)}`, {
        headers: { range: 'bytes=0-3' },
      });
      expect(response.status).toBe(HttpStatus.PartialContent);
      expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
    });

    it('answers 404, not 401, once it has expired', async () => {
      const document = await ready(BINARY);
      const stale = signedContentUrl(deps.secrets, document, false, ago(CONTENT_DEFAULTS.urlTtlMinutes + 1));
      expect((await fetch(`${origin}${stale}`)).status).toBe(HttpStatus.NotFound);
      const fresh = signedContentUrl(deps.secrets, document, false, ago(CONTENT_DEFAULTS.urlTtlMinutes - 1));
      expect((await fetch(`${origin}${fresh}`)).status).toBe(HttpStatus.Ok);
    });

    it('answers 404 for another document’s token', async () => {
      const mine = await ready(BINARY);
      const other = await ready(Buffer.from('other'));
      const token = new URL(signedContentUrl(deps.secrets, other, false), origin).searchParams.get('t') ?? '';
      expect((await fetch(url(mine.id, `?t=${encodeURIComponent(token)}`))).status).toBe(HttpStatus.NotFound);
    });

    it('answers 404 once the object key has changed', async () => {
      const document = await ready(BINARY);
      const signed = signedContentUrl(deps.secrets, document, false);
      const rekeyed = objectKeyFor(crypto.randomUUID(), document.filename);
      await db.update(documents).set({ objectKey: rekeyed }).where(eq(documents.id, document.id));
      bucket.objects.set(rekeyed, { body: BINARY, contentType: document.contentType });
      expect((await fetch(`${origin}${signed}`)).status).toBe(HttpStatus.NotFound);
    });

    it('answers 404 to an inline URL turned into a download, and to a forged token', async () => {
      const document = await ready(BINARY);
      const inline = signedContentUrl(deps.secrets, document, false);
      expect((await fetch(`${origin}${inline}&download=1`)).status).toBe(HttpStatus.NotFound);
      expect((await fetch(url(document.id, '?t=9999999999.forged'))).status).toBe(HttpStatus.NotFound);
      expect((await fetch(url(document.id, '?t='))).status).toBe(HttpStatus.NotFound);
    });

    it('is not accepted for an upload', async () => {
      const document = await pending();
      const signed = signedContentUrl(deps.secrets, document, false);
      const response = await fetch(`${origin}${signed}`, { method: 'PUT', body: new Uint8Array(BINARY) });
      expect(response.status).toBe(HttpStatus.Unauthorized);
    });
  });

  it('answers an unknown /api path with JSON, not the app', async () => {
    const response = await fetch(`${origin}/api/nothing-here`);
    expect(response.status).toBe(HttpStatus.NotFound);
    expect((await response.json()).error.code).toBe(ErrorCode.NotFound);
  });
});
