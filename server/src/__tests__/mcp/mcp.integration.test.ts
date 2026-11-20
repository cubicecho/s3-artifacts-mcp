import { createHash, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { documents } from '@cubicecho/s3-artifacts-mcp-db/schema';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedAuthHost } from '../../auth/auth-host.ts';
import { createRateLimiter } from '../../auth/rate-limit.ts';
import { SecretPurpose } from '../../core/secrets.ts';
import { HttpStatus } from '../../core/wire.ts';
import { createApp } from '../../http/app.ts';
import { mcpPath } from '../../mcp/endpoint.ts';
import { createStorageRegistry } from '../../storage/registry.ts';
import { createS3Storage } from '../../storage/s3.ts';
import {
  closeTestDb,
  createClient,
  createTestAuth,
  createTestDb,
  createTestSecrets,
  createUser,
  insertBucket,
  type TestDb,
} from '../helpers.ts';

// The goal, end to end, against a real S3-compatible service: an agent connected to one bucket over MCP uploads an
// artifact, makes a share link and hands it on, and the link opens with no credentials. A presigned PUT, a share
// link's host and a re-key's 404 are what an in-memory storage cannot prove. Skipped unless S3AM_IT_ENDPOINT is set,
// e.g. for the dev RustFS:
//
//   S3AM_IT_ENDPOINT=http://localhost:9010 S3AM_IT_BUCKET=artifacts \
//   S3AM_IT_ACCESS_KEY=s3am S3AM_IT_SECRET_KEY=s3am-dev-secret npx vitest run --project node mcp.integration

const { S3AM_IT_ENDPOINT, S3AM_IT_BUCKET, S3AM_IT_ACCESS_KEY, S3AM_IT_SECRET_KEY, S3AM_IT_REGION } = process.env;
const isConfigured = (S3AM_IT_ENDPOINT ?? '') !== '';

/** A bucket on a NAS's disks can be slow to answer. */
const TIMEOUT_MS = 60_000;
/** The binary file's length: a few hundred KiB, an image's worth. */
const FILE_BYTES = 300_000;

/** A share link as the tools answer it. */
interface ShareLinkResult {
  url: string;
  expiresAt: string;
}

describe.skipIf(isConfigured === false)('an agent shares an artifact over MCP', { timeout: TIMEOUT_MS }, () => {
  const connection = {
    endpoint: S3AM_IT_ENDPOINT ?? null,
    publicEndpoint: null,
    region: S3AM_IT_REGION ?? 'us-east-1',
    bucket: S3AM_IT_BUCKET ?? 'artifacts',
    accessKeyId: S3AM_IT_ACCESS_KEY ?? '',
    forcePathStyle: true,
  };
  const storage = createS3Storage(connection, S3AM_IT_SECRET_KEY ?? '');
  const slug = `it-mcp-${Date.now()}`;
  let db: TestDb;
  let server: Server;
  let client: Client;
  let owner: string;
  let owners: () => ReturnType<typeof createClient>;
  /** Every key an object may have been put at, deleted at the end whatever happened. */
  const keys = new Set<string>();

  /**
   * Calls a tool that must succeed.
   *
   * @param name - The tool.
   * @param args - Its arguments.
   * @returns Its JSON result.
   */
  async function ok(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    const [first] = result.content as Array<{ text: string }>;
    if (result.isError === true) {
      throw new Error(`${name} failed: ${first?.text}`);
    }
    return JSON.parse(first.text);
  }

  /** Notes the key every document in the test database has now, so the end deletes it. */
  async function rememberKeys(): Promise<void> {
    for (const row of await db.select({ objectKey: documents.objectKey }).from(documents)) {
      keys.add(row.objectKey);
    }
  }

  beforeAll(async () => {
    db = await createTestDb();
    const auth = createTestAuth(db).auth;
    const secrets = createTestSecrets();
    owner = await createUser(db, 'owner@example.com');
    const registry = createStorageRegistry({ db, secrets });
    await insertBucket(db, secrets, owner, {
      slug,
      endpoint: connection.endpoint,
      region: connection.region,
      bucket: connection.bucket,
      accessKeyId: connection.accessKeyId,
      secretAccessKeyEnc: secrets.seal(S3AM_IT_SECRET_KEY ?? '', SecretPurpose.BucketSecret),
      mcpEnabled: true,
      mcpWritable: true,
    });
    owners = () => createClient(db, owner, { secrets, storage: registry });
    const { key } = await auth.api.createApiKey({ body: { userId: owner, name: 'agent', rateLimitEnabled: false } });
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
    const url = new URL(mcpPath(slug), `http://127.0.0.1:${address.port}`);
    client = new Client({ name: 'acceptance', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { 'x-api-key': key } } }));
  }, TIMEOUT_MS);

  afterAll(async () => {
    await rememberKeys().catch(() => undefined);
    await storage.delete([...keys]).catch(() => undefined);
    await client?.close();
    await new Promise((resolve) => server.close(resolve));
    await closeTestDb(db);
  });

  it('uploads text with tags and a share, and the link opens with no credentials, as asked', async () => {
    const text = '# Quarterly report\n\nEverything is fine. Café.\n';
    const result = await ok('upload_document', {
      filename: 'Quarterly report.md',
      contentType: 'text/markdown',
      text,
      tags: ['Reports', 'q4'],
      share: { permission: 'download', expiresInHours: 1 },
    });
    await rememberKeys();
    expect(result.document.tags).toEqual(['q4', 'Reports']);
    const listed = await ok('list_documents', { tags: ['REPORTS', 'Q4'], match: 'all' });
    expect(listed.documents.map((document: { id: string }) => document.id)).toEqual([result.document.id]);
    const link: ShareLinkResult = result.shareLink;
    expect(new URL(link.url).origin).toBe(new URL(S3AM_IT_ENDPOINT ?? '').origin);

    const opened = await fetch(link.url);
    expect(opened.status).toBe(HttpStatus.Ok);
    expect(Buffer.from(await opened.arrayBuffer()).equals(Buffer.from(text, 'utf8'))).toBe(true);
    expect(opened.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(opened.headers.get('content-disposition')).toBe(
      `attachment; filename="Quarterly report.md"; filename*=UTF-8''Quarterly%20report.md`,
    );
  });

  describe('a binary file through create_upload', () => {
    const bytes = randomBytes(FILE_BYTES);
    let documentId: string;
    let link: ShareLinkResult;

    it('takes the PUT the agent sends with plain fetch, and the link it shares serves the same bytes', async () => {
      const started = await ok('create_upload', {
        filename: 'chart.png',
        contentType: 'image/png',
        size: bytes.length,
      });
      documentId = started.documentId;
      await rememberKeys();
      const signed = new URL(started.uploadUrl).searchParams.get('X-Amz-SignedHeaders') ?? '';
      expect(signed.split(';')).toEqual(expect.arrayContaining(['content-length', 'content-type', 'host']));

      // A PUT that sends another type than the one signed is refused by the bucket itself.
      const refused = await fetch(started.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        body: new Uint8Array(bytes),
      });
      expect(refused.ok).toBe(false);

      const put = await fetch(started.uploadUrl, {
        method: 'PUT',
        headers: started.headers,
        body: new Uint8Array(bytes),
      });
      expect(put.status).toBe(HttpStatus.Ok);

      const done = await ok('complete_upload', { documentId, share: { permission: 'view', expiresInHours: 1 } });
      expect(done.document.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      link = done.shareLink;
      const opened = await fetch(link.url);
      expect(opened.status).toBe(HttpStatus.Ok);
      expect(Buffer.from(await opened.arrayBuffer()).equals(bytes)).toBe(true);
      expect(opened.headers.get('content-type')).toBe('image/png');
      expect(opened.headers.get('content-disposition')).toMatch(/^inline; filename="chart.png"/);
    });

    it('answers 404 for that link once the document is re-keyed', async () => {
      const { rekeyDocument } = await owners().expectOk(
        'mutation ($id: UUID!) { rekeyDocument(id: $id) { objectKey } }',
        { id: documentId },
      );
      keys.add(rekeyDocument.objectKey);
      expect((await fetch(link.url)).status).toBe(HttpStatus.NotFound);
    });
  });
});
