import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import {
  apikeys,
  appSettings,
  buckets,
  DocumentStatus,
  documents,
  documentTags,
  type NewDocument,
  ShareLinkCreator,
  shareLinks,
  tags,
} from '@cubicecho/s3-artifacts-mcp-db/schema';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixedAuthHost } from '../../auth/auth-host.ts';
import type { Auth } from '../../auth/better-auth.ts';
import { createRateLimiter } from '../../auth/rate-limit.ts';
import { HTTP_DEFAULTS, MCP_DEFAULTS, UPLOAD_DEFAULTS } from '../../core/defaults.ts';
import { HttpStatus, MS_PER_SECOND, SECONDS_PER_MINUTE } from '../../core/wire.ts';
import { objectKeyFor } from '../../documents/keys.ts';
import { sweepPendingUploads } from '../../documents/sweep.ts';
import { createApp } from '../../http/app.ts';
import { BUCKET_READ_ONLY, NO_SUCH_DOCUMENT } from '../../mcp/access.ts';
import { mcpPath } from '../../mcp/endpoint.ts';
import { FILE_PLACEHOLDER } from '../../mcp/uploads.ts';
import {
  closeTestDb,
  createSessionToken,
  createTestAuth,
  createTestDb,
  createTestStorageDeps,
  createUser,
  insertBucket,
  type TestDb,
  type TestStorageDeps,
} from '../helpers.ts';
import type { MemoryStorage } from '../memory-storage.ts';

// The real app over a real socket, and the SDK's own client: what an agent actually does. The buckets live in the
// in-memory backend, whose fetch answers presigned GETs and PUTs as S3 would.

/** What a tool answered, read the way an agent reads it. */
interface ToolCall {
  isError: boolean;
  /** The first text block: the JSON result, or the failure. */
  text: string;
  /** The JSON result, parsed. Empty on a failure. */
  data: Record<string, unknown>;
  /** Every content block after the first. */
  more: Array<{ type: string; text?: string; resource?: { uri: string; mimeType?: string; blob?: string } }>;
}

/** A share link as the tools answer it. */
interface ShareLinkResult {
  url: string;
  permission: string;
  expiresAt: string;
  label: string | null;
}

/** Slugs of the buckets each test uses. */
const SLUG = { writable: 'artifacts', readOnly: 'notes', off: 'archive', theirs: 'theirs' } as const;

describe('/mcp/b/:slug', () => {
  let db: TestDb;
  let auth: Auth;
  let deps: TestStorageDeps;
  let server: Server;
  let origin: string;
  let owner: string;
  let ownerKey: string;
  let otherKey: string;
  let writableId: string;
  let readOnlyId: string;
  let artifacts: MemoryStorage;
  const clients: Client[] = [];

  /**
   * Adds a document to a bucket straight through Drizzle, its bytes in the memory bucket when it is ready.
   *
   * @param bucketId - The bucket.
   * @param bucketName - The memory bucket behind it.
   * @param values - Columns to set.
   * @param [body] - Its bytes.
   * @returns The row.
   */
  async function document(
    bucketId: string,
    bucketName: string,
    values: Partial<NewDocument> & { filename: string },
    body: Buffer | string = 'hello',
  ) {
    const id = crypto.randomUUID();
    const bytes = Buffer.from(body);
    const contentType = values.contentType ?? 'text/plain';
    const [row] = await db
      .insert(documents)
      .values({
        id,
        userId: owner,
        bucketId,
        title: values.filename.replace(/\.[^.]+$/, ''),
        objectKey: objectKeyFor(id, values.filename),
        contentType,
        size: bytes.length,
        status: DocumentStatus.Ready,
        ...values,
      })
      .returning();
    deps.backend.bucket(bucketName).objects.set(row.objectKey, { body: bytes, contentType });
    return row;
  }

  /**
   * Connects the SDK's client to a bucket's endpoint.
   *
   * @param slug - The bucket.
   * @param [headers] - What every request carries: the owner's key unless a test says otherwise.
   * @returns The client.
   */
  async function connect(slug: string, headers: Record<string, string> = { 'x-api-key': ownerKey }): Promise<Client> {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcpPath(slug), origin), { requestInit: { headers } }),
    );
    clients.push(client);
    return client;
  }

  /**
   * Calls a tool.
   *
   * @param client - A connected client.
   * @param name - The tool.
   * @param [args] - Its arguments.
   * @returns What it answered.
   */
  async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolCall> {
    const result = await client.callTool({ name, arguments: args });
    const [first, ...more] = result.content as ToolCall['more'];
    const text = first?.text ?? '';
    const isError = result.isError === true;
    return { isError, text, data: isError ? {} : JSON.parse(text), more };
  }

  /**
   * Calls a tool that must succeed.
   *
   * @param client - A connected client.
   * @param name - The tool.
   * @param [args] - Its arguments.
   * @returns Its JSON result.
   */
  async function ok(client: Client, name: string, args: Record<string, unknown> = {}) {
    const result = await call(client, name, args);
    if (result.isError) {
      throw new Error(`${name} failed: ${result.text}`);
    }
    return result.data;
  }

  /**
   * Sends one raw JSON-RPC request, as a client that is not the SDK's might.
   *
   * @param slug - The bucket.
   * @param headers - The request's headers.
   * @param [body] - The body.
   * @returns The response.
   */
  function post(slug: string, headers: Record<string, string>, body = '') {
    return fetch(new URL(mcpPath(slug), origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: body === '' ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) : body,
    });
  }

  beforeAll(async () => {
    db = await createTestDb();
    auth = createTestAuth(db).auth;
    deps = createTestStorageDeps(db);
    owner = await createUser(db, 'owner@example.com');
    const other = await createUser(db, 'other@example.com');
    ownerKey = (await auth.api.createApiKey({ body: { userId: owner, name: 'agent', rateLimitEnabled: false } })).key;
    otherKey = (await auth.api.createApiKey({ body: { userId: other, name: 'agent', rateLimitEnabled: false } })).key;

    writableId = await insertBucket(db, deps.secrets, owner, {
      slug: SLUG.writable,
      bucket: 'artifacts',
      mcpEnabled: true,
      mcpWritable: true,
    });
    readOnlyId = await insertBucket(db, deps.secrets, owner, {
      slug: SLUG.readOnly,
      bucket: 'notes',
      mcpEnabled: true,
    });
    await insertBucket(db, deps.secrets, owner, { slug: SLUG.off, bucket: 'archive' });
    await insertBucket(db, deps.secrets, other, {
      slug: SLUG.theirs,
      bucket: 'theirs',
      mcpEnabled: true,
      mcpWritable: true,
    });
    artifacts = deps.backend.bucket('artifacts');

    const app = createApp({
      db,
      authHost: fixedAuthHost(auth),
      limiter: createRateLimiter(),
      storage: deps.storage,
      secrets: deps.secrets,
      fetch: deps.fetch,
    });
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected the test server to listen on a TCP port');
    }
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb(db);
  });

  it('keeps its limits in step with each other', () => {
    // The body cap sits above the largest inline upload, so the tool refuses it and says what to do instead.
    expect(HTTP_DEFAULTS.mcpBodyLimitBytes).toBeGreaterThan(MCP_DEFAULTS.inlineUploadBytes);
    // A presigned PUT stops working before the sweeper drops its row, so nothing arrives at a key after its sweep.
    expect(MCP_DEFAULTS.uploadUrlTtlMinutes).toBeLessThan(UPLOAD_DEFAULTS.pendingTtlMinutes);
  });

  describe('refuses', () => {
    it.each([
      ['no key', {}],
      ['a key nobody made', { authorization: 'Bearer s3a_notarealkeyatall' }],
      ['a key nobody made, as x-api-key', { 'x-api-key': 's3a_notarealkeyatall' }],
    ])('a request with %s', async (_name, headers) => {
      const response = await post(SLUG.writable, headers);
      expect(response.status).toBe(HttpStatus.Unauthorized);
      expect((await response.json()).error.message).toMatch(/API key/);
    });

    it('a session, as a bearer token or a cookie', async () => {
      const token = await createSessionToken(auth, owner);
      expect((await post(SLUG.writable, { authorization: `Bearer ${token}` })).status).toBe(HttpStatus.Unauthorized);
      const cookie = `better-auth.session_token=${token}`;
      expect((await post(SLUG.writable, { cookie })).status).toBe(HttpStatus.Unauthorized);
    });

    it('a request with no key on a trusted network', async () => {
      vi.stubEnv('SECURE_LOCAL_NET', 'true');
      expect((await post(SLUG.writable, {})).status).toBe(HttpStatus.Unauthorized);
    });

    it('a key once it is revoked', async () => {
      const made = await auth.api.createApiKey({ body: { userId: owner, name: 'gone', rateLimitEnabled: false } });
      expect((await post(SLUG.writable, { 'x-api-key': made.key })).status).toBe(HttpStatus.Ok);
      // What revokeApiKey does: the row is the key.
      await db.delete(apikeys).where(eq(apikeys.id, made.id));
      expect((await post(SLUG.writable, { 'x-api-key': made.key })).status).toBe(HttpStatus.Unauthorized);
    });

    it('an unknown slug, a bucket with MCP off and someone else’s bucket, all with the same 404', async () => {
      const answers = await Promise.all(
        ['no-such-bucket', SLUG.off, SLUG.theirs].map(async (slug) => {
          const response = await post(slug, { 'x-api-key': ownerKey });
          return { status: response.status, body: await response.json() };
        }),
      );
      expect(answers.map((answer) => answer.status)).toEqual([404, 404, 404]);
      expect(new Set(answers.map((answer) => JSON.stringify(answer.body))).size).toBe(1);
      // The same bucket answers its own owner's key.
      expect((await post(SLUG.theirs, { 'x-api-key': otherKey })).status).toBe(HttpStatus.Ok);
    });

    it('a body past the cap, as JSON-RPC', async () => {
      const response = await post(
        SLUG.writable,
        { 'x-api-key': ownerKey },
        'x'.repeat(HTTP_DEFAULTS.mcpBodyLimitBytes + 1),
      );
      expect(response.status).toBe(HttpStatus.PayloadTooLarge);
      expect((await response.json()).error.message).toMatch(/create_upload/);
    });
  });

  it('offers the write tools only on a writable bucket', async () => {
    const writable = await connect(SLUG.writable, { authorization: `Bearer ${ownerKey}` });
    const { tools } = await writable.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'complete_upload',
      'create_share_link',
      'create_upload',
      'get_document',
      'list_documents',
      'list_tags',
      'tag_document',
      'upload_document',
    ]);
    for (const name of ['upload_document', 'complete_upload', 'create_share_link']) {
      expect(tools.find((tool) => tool.name === name)?.description).toContain('shareLink.url');
    }
    expect(writable.getInstructions()).toContain('upload_document');

    const readOnly = await connect(SLUG.readOnly);
    expect((await readOnly.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      'get_document',
      'list_documents',
      'list_tags',
    ]);
    expect(readOnly.getInstructions()).toContain('read-only');
  });

  describe('reading', () => {
    let older: { id: string };
    let newer: { id: string };
    let elsewhere: { id: string };
    let pending: { id: string };

    beforeAll(async () => {
      older = await document(readOnlyId, 'notes', {
        filename: 'Plumbing invoice.pdf',
        contentType: 'application/pdf',
        createdAt: new Date('2026-11-01T00:00:00Z'),
      });
      newer = await document(
        readOnlyId,
        'notes',
        {
          filename: 'Field notes.md',
          contentType: 'text/markdown',
          createdAt: new Date('2026-11-02T00:00:00Z'),
        },
        '# Field notes\n\nAll well.',
      );
      pending = await document(readOnlyId, 'notes', { filename: 'Half.txt', status: DocumentStatus.PendingUpload });
      elsewhere = await document(writableId, 'artifacts', { filename: 'Elsewhere.txt' });
    });

    it('lists the bucket’s ready documents only, newest first', async () => {
      const client = await connect(SLUG.readOnly);
      const { documents: listed, nextCursor } = await ok(client, 'list_documents');
      expect((listed as { id: string }[]).map((row) => row.id)).toEqual([newer.id, older.id]);
      expect(nextCursor).toBeNull();
      expect(listed).toContainEqual(
        expect.objectContaining({ filename: 'Field notes.md', contentType: 'text/markdown' }),
      );
    });

    it('filters by title and by the start of the type, and pages with a cursor', async () => {
      const client = await connect(SLUG.readOnly);
      const byTitle = await ok(client, 'list_documents', { title: 'INVOICE' });
      expect((byTitle.documents as { id: string }[]).map((row) => row.id)).toEqual([older.id]);
      const byType = await ok(client, 'list_documents', { contentType: 'text/' });
      expect((byType.documents as { id: string }[]).map((row) => row.id)).toEqual([newer.id]);
      // A wildcard is matched as itself.
      expect((await ok(client, 'list_documents', { title: '%' })).documents).toEqual([]);

      const first = await ok(client, 'list_documents', { limit: 1 });
      expect((first.documents as { id: string }[]).map((row) => row.id)).toEqual([newer.id]);
      expect(first.nextCursor).toBe(newer.id);
      const second = await ok(client, 'list_documents', { limit: 1, cursor: first.nextCursor });
      expect((second.documents as { id: string }[]).map((row) => row.id)).toEqual([older.id]);
      expect(second.nextCursor).toBeNull();

      const foreign = await call(client, 'list_documents', { cursor: elsewhere.id });
      expect(foreign.isError).toBe(true);
    });

    it('reads text as text and a PDF as an embedded resource', async () => {
      const client = await connect(SLUG.readOnly);
      const text = await call(client, 'get_document', { id: newer.id });
      expect(text.data.document).toMatchObject({ id: newer.id, title: 'Field notes' });
      expect(text.more).toEqual([{ type: 'text', text: '# Field notes\n\nAll well.' }]);

      const pdf = await call(client, 'get_document', { id: older.id });
      expect(pdf.more).toEqual([
        {
          type: 'resource',
          resource: { uri: `s3a://${SLUG.readOnly}/${older.id}`, mimeType: 'application/pdf', blob: 'aGVsbG8=' },
        },
      ]);
    });

    it('gives the details and a note for content past the inline limits or of another type', async () => {
      const big = await document(
        readOnlyId,
        'notes',
        { filename: 'Big.txt' },
        'x'.repeat(MCP_DEFAULTS.inlineTextBytes + 1),
      );
      const zip = await document(readOnlyId, 'notes', { filename: 'Bundle.zip', contentType: 'application/zip' });
      const client = await connect(SLUG.readOnly);
      const large = await call(client, 'get_document', { id: big.id });
      expect(large.more).toEqual([]);
      expect(large.data.note).toMatch(/past the 256 KiB returned inline/);
      const binary = await call(client, 'get_document', { id: zip.id });
      expect(binary.data.note).toMatch(/not returned inline/);
      await db.delete(documents).where(inArray(documents.id, [big.id, zip.id]));
    });

    it.each([
      ['in another bucket', () => elsewhere.id],
      ['still uploading', () => pending.id],
      ['that does not exist', () => crypto.randomUUID()],
      ['that is not an id', () => 'not-a-uuid'],
    ])('answers the same for a document %s', async (_name, id) => {
      const client = await connect(SLUG.readOnly);
      expect(await call(client, 'get_document', { id: id() })).toMatchObject({ isError: true, text: NO_SUCH_DOCUMENT });
    });

    it('sees MCP switched off on the very next call', async () => {
      const client = await connect(SLUG.readOnly);
      await ok(client, 'list_documents');
      await db.update(buckets).set({ mcpEnabled: false }).where(eq(buckets.id, readOnlyId));
      try {
        await expect(client.callTool({ name: 'list_documents', arguments: {} })).rejects.toThrow(
          /No bucket is shared over MCP/,
        );
      } finally {
        await db.update(buckets).set({ mcpEnabled: true }).where(eq(buckets.id, readOnlyId));
      }
    });
  });

  describe('writing', () => {
    it('refuses every write tool on a read-only bucket', async () => {
      const client = await connect(SLUG.readOnly);
      const before = await db.select().from(documents).where(eq(documents.bucketId, readOnlyId));
      for (const name of ['upload_document', 'create_upload', 'complete_upload', 'create_share_link', 'tag_document']) {
        const result = await call(client, name, { filename: 'x.md', contentType: 'text/markdown', text: 'x' });
        expect(result).toMatchObject({ isError: true, text: expect.stringContaining('not found') });
      }
      expect(await db.select().from(documents).where(eq(documents.bucketId, readOnlyId))).toEqual(before);
    });

    it('refuses writes from the next call once the bucket is made read-only', async () => {
      const client = await connect(SLUG.writable);
      await db.update(buckets).set({ mcpWritable: false }).where(eq(buckets.id, writableId));
      try {
        const result = await call(client, 'upload_document', {
          filename: 'x.md',
          contentType: 'text/markdown',
          text: 'x',
        });
        expect(result.isError).toBe(true);
      } finally {
        await db.update(buckets).set({ mcpWritable: true }).where(eq(buckets.id, writableId));
      }
      expect(BUCKET_READ_ONLY).toMatch(/read-only/);
    });

    it('uploads text and shares it in one call, as UTF-8 and as asked', async () => {
      const client = await connect(SLUG.writable);
      const text = '# Report\n\nCafé, naïve, 😀\n';
      const result = await ok(client, 'upload_document', {
        filename: 'Report.md',
        contentType: 'text/markdown',
        text,
        share: { permission: 'view', expiresInHours: 2, label: 'for Sam' },
      });
      const document = result.document as { id: string; sha256: string; size: number; contentType: string };
      const bytes = Buffer.from(text, 'utf8');
      expect(document).toMatchObject({
        size: bytes.length,
        contentType: 'text/markdown; charset=utf-8',
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      const link = result.shareLink as ShareLinkResult;
      expect(link).toMatchObject({ permission: 'view', label: 'for Sam' });
      expect(new Date(link.expiresAt).getTime() - Date.now()).toBeGreaterThan(MS_PER_SECOND * SECONDS_PER_MINUTE * 119);

      const opened = await deps.fetch(link.url);
      expect(Buffer.from(await opened.arrayBuffer()).equals(bytes)).toBe(true);
      expect(opened.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
      expect(opened.headers.get('content-disposition')).toMatch(/^inline; filename="Report.md"/);

      const [row] = await db.select().from(shareLinks).where(eq(shareLinks.documentId, document.id));
      expect(row.createdBy).toBe(ShareLinkCreator.Mcp);
      const [stored] = await db.select().from(documents).where(eq(documents.id, document.id));
      expect(stored).toMatchObject({ status: DocumentStatus.Ready, bucketId: writableId });
    });

    it('takes what a share leaves out from the owner’s settings', async () => {
      await db
        .update(appSettings)
        .set({ defaultLinkPermission: 'download', defaultLinkExpiryHours: 5 })
        .where(eq(appSettings.userId, owner));
      const client = await connect(SLUG.writable);
      const result = await ok(client, 'upload_document', {
        filename: 'data.csv',
        contentType: 'text/csv; charset=utf-8',
        text: 'a,b\n1,2\n',
        share: {},
      });
      const link = result.shareLink as ShareLinkResult;
      expect(link.permission).toBe('download');
      const hours = (new Date(link.expiresAt).getTime() - Date.now()) / (MS_PER_SECOND * SECONDS_PER_MINUTE * 60);
      expect(Math.round(hours)).toBe(5);
      const opened = await deps.fetch(link.url);
      expect(opened.headers.get('content-type')).toBe('text/csv; charset=utf-8');
      expect(opened.headers.get('content-disposition')).toMatch(/^attachment; filename="data.csv"/);
    });

    it('uploads without a link when no share is asked for', async () => {
      const client = await connect(SLUG.writable);
      const result = await ok(client, 'upload_document', {
        filename: 'n.json',
        contentType: 'application/json',
        text: '{}',
      });
      expect(result.shareLink).toBeUndefined();
      expect((result.document as { contentType: string }).contentType).toBe('application/json; charset=utf-8');
    });

    it('refuses text past the inline limit, and an expiry past seven days, storing nothing', async () => {
      const client = await connect(SLUG.writable);
      const before = artifacts.objects.size;
      const large = await call(client, 'upload_document', {
        filename: 'big.txt',
        contentType: 'text/plain',
        text: 'x'.repeat(MCP_DEFAULTS.inlineUploadBytes + 1),
      });
      expect(large).toMatchObject({ isError: true, text: expect.stringContaining('create_upload') });
      const tooLong = await call(client, 'upload_document', {
        filename: 'a.txt',
        contentType: 'text/plain',
        text: 'a',
        share: { expiresInHours: 169 },
      });
      expect(tooLong.isError).toBe(true);
      const empty = await call(client, 'upload_document', { filename: 'e.txt', contentType: 'text/plain', text: '' });
      expect(empty).toMatchObject({ isError: true, text: 'The file is empty.' });
      expect(artifacts.objects.size).toBe(before);
    });

    it('takes a file through create_upload, a PUT and complete_upload, then shares it', async () => {
      const client = await connect(SLUG.writable);
      const bytes = Buffer.from(Array.from({ length: 3000 }, (_, index) => index % 256));
      const started = await ok(client, 'create_upload', {
        filename: 'chart.png',
        contentType: 'image/png',
        size: bytes.length,
      });
      expect(started).toMatchObject({ headers: { 'Content-Type': 'image/png' } });
      expect(started.curl).toBe(
        `curl --fail-with-body -T ${FILE_PLACEHOLDER} -H 'Content-Type: image/png' '${started.uploadUrl}'`,
      );
      const minutes =
        (new Date(String(started.expiresAt)).getTime() - Date.now()) / (MS_PER_SECOND * SECONDS_PER_MINUTE);
      expect(Math.round(minutes)).toBe(MCP_DEFAULTS.uploadUrlTtlMinutes);
      const [pendingRow] = await db
        .select()
        .from(documents)
        .where(eq(documents.id, String(started.documentId)));
      expect(pendingRow.status).toBe(DocumentStatus.PendingUpload);

      // Not before the file is there.
      const early = await call(client, 'complete_upload', { documentId: started.documentId });
      expect(early).toMatchObject({ isError: true, text: expect.stringContaining('Nothing has arrived') });

      // A PUT that does not send what was signed is refused by the bucket.
      const wrong = await deps.fetch(String(started.uploadUrl), {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        body: bytes,
      });
      expect(wrong.status).toBe(HttpStatus.Forbidden);
      const put = await deps.fetch(String(started.uploadUrl), {
        method: 'PUT',
        headers: started.headers as Record<string, string>,
        body: bytes,
      });
      expect(put.status).toBe(HttpStatus.Ok);

      const done = await ok(client, 'complete_upload', {
        documentId: started.documentId,
        share: { permission: 'download' },
      });
      expect(done.document).toMatchObject({
        id: started.documentId,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      const link = done.shareLink as ShareLinkResult;
      const opened = await deps.fetch(link.url);
      expect(Buffer.from(await opened.arrayBuffer()).equals(bytes)).toBe(true);
      expect(opened.headers.get('content-disposition')).toMatch(/^attachment; filename="chart.png"/);

      // Again: the same document, nothing changed.
      const again = await ok(client, 'complete_upload', { documentId: started.documentId });
      expect(again.document).toEqual(done.document);
      expect(again.shareLink).toBeUndefined();
    });

    it('refuses a file whose size does not match, and removes it', async () => {
      const client = await connect(SLUG.writable);
      const started = await ok(client, 'create_upload', {
        filename: 'a.bin',
        contentType: 'application/octet-stream',
        size: 10,
      });
      const [row] = await db
        .select()
        .from(documents)
        .where(eq(documents.id, String(started.documentId)));
      // As a service that does not check the signed length would store it.
      artifacts.objects.set(row.objectKey, { body: Buffer.from('eleven byte'), contentType: row.contentType });
      const result = await call(client, 'complete_upload', { documentId: started.documentId });
      expect(result).toMatchObject({ isError: true, text: expect.stringContaining('holds 11 bytes') });
      expect(artifacts.objects.has(row.objectKey)).toBe(false);
      expect(await db.select().from(documents).where(eq(documents.id, row.id))).toEqual([]);
    });

    it('refuses a file past the owner’s upload limit or a single PUT', async () => {
      const client = await connect(SLUG.writable);
      const [settings] = await db.select().from(appSettings).where(eq(appSettings.userId, owner));
      const overLimit = await call(client, 'create_upload', {
        filename: 'big.bin',
        contentType: 'application/octet-stream',
        size: settings.maxUploadBytes + 1,
      });
      expect(overLimit).toMatchObject({ isError: true, text: expect.stringContaining('upload limit') });
      await db
        .update(appSettings)
        .set({ maxUploadBytes: UPLOAD_DEFAULTS.maxUploadBytes })
        .where(eq(appSettings.userId, owner));
      const overPut = await call(client, 'create_upload', {
        filename: 'huge.bin',
        contentType: 'application/octet-stream',
        size: MCP_DEFAULTS.maxPresignedPutBytes + 1,
      });
      expect(overPut).toMatchObject({ isError: true, text: expect.stringContaining('one PUT') });
      await db
        .update(appSettings)
        .set({ maxUploadBytes: settings.maxUploadBytes })
        .where(eq(appSettings.userId, owner));
    });

    it('lets the sweeper drop an upload never completed, and the file that reached its key', async () => {
      const client = await connect(SLUG.writable);
      const started = await ok(client, 'create_upload', { filename: 'left.txt', contentType: 'text/plain', size: 4 });
      const put = await deps.fetch(String(started.uploadUrl), {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: 'left',
      });
      expect(put.status).toBe(HttpStatus.Ok);
      const [row] = await db
        .select()
        .from(documents)
        .where(eq(documents.id, String(started.documentId)));
      const later = new Date(Date.now() + (UPLOAD_DEFAULTS.pendingTtlMinutes + 1) * SECONDS_PER_MINUTE * MS_PER_SECOND);
      expect(await sweepPendingUploads({ db, storage: deps.storage }, {}, later)).toBeGreaterThanOrEqual(1);
      expect(await db.select().from(documents).where(eq(documents.id, row.id))).toEqual([]);
      expect(artifacts.objects.has(row.objectKey)).toBe(false);
      const result = await call(client, 'complete_upload', { documentId: row.id });
      expect(result).toMatchObject({ isError: true, text: NO_SUCH_DOCUMENT });
    });

    it('shares a document already there, and nothing outside the bucket', async () => {
      const client = await connect(SLUG.writable);
      const mine = await document(writableId, 'artifacts', { filename: 'Mine.txt' }, 'mine');
      const notes = await document(readOnlyId, 'notes', { filename: 'Elsewhere.txt' }, 'not here');
      const shared = await ok(client, 'create_share_link', { id: mine.id, permission: 'view', label: 'quick look' });
      const link = shared.shareLink as ShareLinkResult;
      expect(await (await deps.fetch(link.url)).text()).toBe('mine');
      expect(await call(client, 'create_share_link', { id: notes.id })).toMatchObject({
        isError: true,
        text: NO_SUCH_DOCUMENT,
      });
      expect(await call(client, 'complete_upload', { documentId: notes.id })).toMatchObject({
        isError: true,
        text: NO_SUCH_DOCUMENT,
      });
      const links = await db.select().from(shareLinks).where(eq(shareLinks.documentId, notes.id));
      expect(links).toEqual([]);
    });
  });

  describe('tags', () => {
    /**
     * Tags a document straight through Drizzle, making the owner's tags it names.
     *
     * @param documentId - The document.
     * @param names - Its tags.
     */
    async function tagDirectly(documentId: string, names: readonly string[]) {
      for (const name of names) {
        const [tag] = await db
          .insert(tags)
          .values({ userId: owner, name, color: '#22c55e' })
          .onConflictDoNothing()
          .returning();
        const [found] = tag === undefined ? await db.select().from(tags).where(eq(tags.name, name)) : [tag];
        await db.insert(documentTags).values({ documentId, tagId: found.id, userId: owner });
      }
    }

    /** The names a listed document answers with, by id. */
    const tagsOf = (listed: unknown) =>
      new Map((listed as { id: string; tags: string[] }[]).map((row) => [row.id, row.tags]));

    it('uploads text with tags, reusing a tag of the name in any case and making the rest', async () => {
      const [existing] = await db.insert(tags).values({ userId: owner, name: 'Reports', color: '#3b82f6' }).returning();
      const client = await connect(SLUG.writable);
      const result = await ok(client, 'upload_document', {
        filename: 'Weekly.md',
        contentType: 'text/markdown',
        text: '# Weekly',
        tags: ['reports', ' Q4 ', 'q4'],
      });
      const uploaded = result.document as { id: string; tags: string[] };
      expect(uploaded.tags).toEqual(['Q4', 'Reports']);
      const mine = await db.select().from(tags).where(eq(tags.userId, owner));
      expect(mine.filter((tag) => tag.name.toLowerCase() === 'reports').map((tag) => tag.id)).toEqual([existing.id]);
      expect(mine.map((tag) => tag.name)).toContain('Q4');
      const read = await ok(client, 'get_document', { id: uploaded.id });
      expect((read.document as { tags: string[] }).tags).toEqual(['Q4', 'Reports']);
    });

    it('refuses a bad tag name before storing anything', async () => {
      const client = await connect(SLUG.writable);
      const objects = artifacts.objects.size;
      const result = await call(client, 'upload_document', {
        filename: 'Untagged.md',
        contentType: 'text/markdown',
        text: 'x',
        tags: ['   '],
      });
      expect(result).toMatchObject({ isError: true, text: expect.stringContaining('needs a name') });
      expect(artifacts.objects.size).toBe(objects);
      expect(await db.select().from(documents).where(eq(documents.filename, 'Untagged.md'))).toEqual([]);
    });

    it('tags a file started with create_upload, and complete_upload answers them', async () => {
      const client = await connect(SLUG.writable);
      const body = Buffer.from('%PDF-1.4 tagged');
      const started = await ok(client, 'create_upload', {
        filename: 'tagged.pdf',
        contentType: 'application/pdf',
        size: body.length,
        tags: ['Scans'],
      });
      const put = await deps.fetch(String(started.uploadUrl), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/pdf' },
        body,
      });
      expect(put.status).toBe(HttpStatus.Ok);
      const done = await ok(client, 'complete_upload', { documentId: started.documentId });
      expect((done.document as { tags: string[] }).tags).toEqual(['Scans']);
    });

    it('lists by tag, any or all, and never a tagged document elsewhere', async () => {
      const client = await connect(SLUG.writable);
      const both = await document(writableId, 'artifacts', { filename: 'both.txt' });
      const oneOnly = await document(writableId, 'artifacts', { filename: 'one.txt' });
      const elsewhere = await document(readOnlyId, 'notes', { filename: 'elsewhere.txt' });
      await tagDirectly(both.id, ['alpha', 'beta']);
      await tagDirectly(oneOnly.id, ['alpha']);
      await tagDirectly(elsewhere.id, ['beta']);

      const any = await ok(client, 'list_documents', { tags: ['ALPHA', 'beta'] });
      const anyTags = tagsOf(any.documents);
      expect([...anyTags.keys()].sort()).toEqual([both.id, oneOnly.id].sort());
      expect(anyTags.get(both.id)).toEqual(['alpha', 'beta']);

      const all = await ok(client, 'list_documents', { tags: ['alpha', 'Beta'], match: 'all' });
      expect([...tagsOf(all.documents).keys()]).toEqual([both.id]);
      const none = await ok(client, 'list_documents', { tags: ['alpha', 'nobody'], match: 'all' });
      expect(none.documents).toEqual([]);
      // Untagged documents answer an empty list rather than leaving the field out.
      const listed = await ok(client, 'list_documents', { title: 'Mine' });
      for (const row of listed.documents as { tags: string[] }[]) {
        expect(row.tags).toEqual(expect.any(Array));
      }
    });

    it('lists every tag of the owner’s with how many documents here carry it', async () => {
      const client = await connect(SLUG.readOnly);
      const here = await document(readOnlyId, 'notes', { filename: 'counted.txt' });
      const pending = await document(readOnlyId, 'notes', {
        filename: 'pending.txt',
        status: DocumentStatus.PendingUpload,
      });
      await tagDirectly(here.id, ['counted-here']);
      await tagDirectly(pending.id, ['counted-here']);
      const away = await document(writableId, 'artifacts', { filename: 'away.txt' });
      await tagDirectly(away.id, ['only-elsewhere']);

      const { tags: listed } = await ok(client, 'list_tags');
      const byName = new Map((listed as { name: string; documents: number }[]).map((tag) => [tag.name, tag]));
      expect(byName.get('counted-here')).toMatchObject({ documents: 1, color: '#22c55e' });
      expect(byName.get('only-elsewhere')).toMatchObject({ documents: 0 });
      const otherTags = await db.select().from(tags).where(eq(tags.userId, owner));
      expect(listed).toHaveLength(otherTags.length);
    });

    it('adds and removes tags by name, and touches nothing outside the bucket', async () => {
      const client = await connect(SLUG.writable);
      const mine = await document(writableId, 'artifacts', { filename: 'retag.txt' });
      const notes = await document(readOnlyId, 'notes', { filename: 'not-here.txt' });
      await tagDirectly(mine.id, ['draft']);

      const result = await ok(client, 'tag_document', {
        id: mine.id,
        add: ['Final', 'final'],
        remove: ['DRAFT', 'never'],
      });
      expect((result.document as { tags: string[] }).tags).toEqual(['Final']);
      const both = await call(client, 'tag_document', { id: mine.id, add: ['x'], remove: ['X'] });
      expect(both).toMatchObject({ isError: true, text: expect.stringContaining('added and removed') });

      const elsewhere = await call(client, 'tag_document', { id: notes.id, add: ['Final'] });
      expect(elsewhere).toMatchObject({ isError: true, text: NO_SUCH_DOCUMENT });
      expect(await db.select().from(documentTags).where(eq(documentTags.documentId, notes.id))).toEqual([]);
    });
  });
});
