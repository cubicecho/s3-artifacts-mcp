import { buckets, DocumentStatus, documents } from '@cubicecho/s3-artifacts-mcp-db/schema';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TEST_FAILED_REASON } from '../../buckets/resolvers.ts';
import { BUCKET_DEFAULTS } from '../../core/defaults.ts';
import { ErrorCode } from '../../core/errors.ts';
import { SecretPurpose } from '../../core/secrets.ts';
import type { StorageRegistry } from '../../storage/registry.ts';
import { createStorageRegistry } from '../../storage/registry.ts';
import {
  type ClientOptions,
  closeTestDb,
  createClient,
  createTestDb,
  createTestSecrets,
  createUser,
  type TestDb,
} from '../helpers.ts';
import { createMemoryBackend, type MemoryBackend } from '../memory-storage.ts';

const FIELDS = `id slug name provider endpoint publicEndpoint region bucket accessKeyId forcePathStyle mcpEnabled mcpWritable secretReadable`;
const CREATE = `mutation ($input: BucketInput!) { createBucket(input: $input) { ${FIELDS} } }`;
const UPDATE = `mutation ($id: UUID!, $input: BucketUpdateInput!) { updateBucket(id: $id, input: $input) { ${FIELDS} } }`;
const TEST = `
  mutation ($input: BucketInput!, $id: UUID) {
    testBucket(input: $input, id: $id) { ok shareLinkWarning steps { step ok skipped errorCode message } }
  }
`;
const SET_SECRET = `mutation ($id: UUID!, $secret: String!) { setBucketSecret(id: $id, secretAccessKey: $secret) { ${FIELDS} } }`;
const SET_MCP = `
  mutation ($id: UUID!, $enabled: Boolean!, $writable: Boolean!) {
    setBucketMcp(id: $id, enabled: $enabled, writable: $writable) { id mcpEnabled mcpWritable }
  }
`;
const DELETE = 'mutation ($id: UUID!) { deleteBucket(id: $id) }';
const FORGET = 'mutation ($id: UUID!) { deleteBucket(id: $id, forgetDocuments: true) }';
const LIST = '{ buckets(orderBy: { createdAt: { direction: asc, priority: 1 } }) { id slug } }';
const PRESETS =
  '{ bucketPresets { provider label forcePathStyle defaultRegion endpointRequired regionRequired endpointExample } }';

const SECRET = 's3am-dev-secret';
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

/** A RustFS bucket as the form sends it. */
function rustfs(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Dev artifacts',
    provider: 'rustfs',
    endpoint: 'http://docker.lan:9010',
    bucket: 'artifacts',
    accessKeyId: 's3am',
    secretAccessKey: SECRET,
    ...overrides,
  };
}

describe('bucket resolvers', () => {
  let db: TestDb;
  let owner: string;
  let stranger: string;
  let backend: MemoryBackend;
  let storage: StorageRegistry;
  let invalidated: string[];
  const secrets = createTestSecrets();

  beforeEach(async () => {
    db = await createTestDb();
    owner = await createUser(db, 'owner@example.com');
    stranger = await createUser(db, 'stranger@example.com');
    backend = createMemoryBackend();
    invalidated = [];
    const registry = createStorageRegistry({ db, secrets, factory: backend.factory });
    storage = {
      ...registry,
      invalidate: (id) => {
        invalidated.push(id);
        registry.invalidate(id);
      },
    };
  });

  afterEach(() => closeTestDb(db));

  const options = (): ClientOptions => ({ backend, secrets, storage });
  const client = () => createClient(db, owner, options());
  const other = () => createClient(db, stranger, options());

  /** Adds a bucket as the owner and returns it. */
  async function create(overrides: Record<string, unknown> = {}) {
    const { createBucket } = await client().expectOk(CREATE, { input: rustfs(overrides) });
    return createBucket;
  }

  it('lists the presets, B2 included', async () => {
    const { bucketPresets } = await client().expectOk(PRESETS);
    expect(bucketPresets.map((preset: { provider: string }) => preset.provider)).toEqual([
      's3',
      'minio',
      'rustfs',
      'b2',
    ]);
    expect(bucketPresets[3]).toEqual({
      provider: 'b2',
      label: 'Backblaze B2',
      forcePathStyle: false,
      defaultRegion: null,
      endpointRequired: true,
      regionRequired: true,
      endpointExample: 'https://s3.us-west-004.backblazeb2.com',
    });
  });

  it('refuses the unauthenticated', async () => {
    expect((await createClient(db, null, options()).expectError(PRESETS)).code).toBe(ErrorCode.Unauthenticated);
    expect((await createClient(db, null, options()).expectError(CREATE, { input: rustfs() })).code).toBe(
      ErrorCode.Unauthenticated,
    );
  });

  it('creates a bucket filled in from its preset, with its secret sealed', async () => {
    const bucket = await create();
    expect(bucket).toMatchObject({
      slug: 'dev-artifacts',
      provider: 'rustfs',
      endpoint: 'http://docker.lan:9010',
      publicEndpoint: null,
      region: 'us-east-1',
      forcePathStyle: true,
      mcpEnabled: false,
      mcpWritable: false,
      secretReadable: true,
    });
    const [row] = await db.select().from(buckets).where(eq(buckets.id, bucket.id));
    expect(row.userId).toBe(owner);
    expect(row.secretAccessKeyEnc).not.toContain(SECRET);
    expect(secrets.open(row.secretAccessKeyEnc, SecretPurpose.BucketSecret)).toBe(SECRET);
    expect(invalidated).toContain(bucket.id);
  });

  it('keeps buckets on different providers and accounts side by side', async () => {
    await create();
    const b2 = await create({
      name: 'Backblaze',
      provider: 'b2',
      endpoint: 'https://s3.us-west-004.backblazeb2.com',
      bucket: 'b2-bucket',
      accessKeyId: 'b2-key',
      secretAccessKey: 'b2-secret',
    });
    const aws = await create({
      name: 'AWS',
      provider: 's3',
      endpoint: null,
      region: 'eu-west-2',
      bucket: 'aws-bucket',
      accessKeyId: 'AKIA',
      secretAccessKey: 'aws-secret',
    });
    expect(b2).toMatchObject({ region: 'us-west-004', forcePathStyle: false });
    expect(aws).toMatchObject({ endpoint: null, region: 'eu-west-2', forcePathStyle: false });
    const tested = backend.connections.map((connection) => [connection.bucket.bucket, connection.secretAccessKey]);
    expect(tested).toEqual([
      ['artifacts', SECRET],
      ['b2-bucket', 'b2-secret'],
      ['aws-bucket', 'aws-secret'],
    ]);
  });

  it('refuses a save whose test fails before the share link, naming the step and the code', async () => {
    backend.bucket('artifacts').failures.headBucket = 'NoSuchBucket';
    const result = await client().run(CREATE, { input: rustfs() });
    expect(result.errors?.[0]?.extensions).toMatchObject({
      code: ErrorCode.BadUserInput,
      reason: TEST_FAILED_REASON,
      step: 'HEAD_BUCKET',
      errorCode: 'NoSuchBucket',
    });
    expect(result.errors?.[0]?.message).toMatch(/HEAD_BUCKET.*NoSuchBucket/);
    expect(await db.select().from(buckets)).toEqual([]);
  });

  it('saves a bucket whose share link fails, since that is only a warning', async () => {
    backend.bucket('artifacts').publicOrigin = 'https://public.unreachable.test';
    const { testBucket } = await client().expectOk(TEST, { input: rustfs() });
    expect(testBucket.ok).toBe(true);
    expect(testBucket.shareLinkWarning).toMatch(/Share links may not open/);
    expect((await create()).id).toBeTypeOf('string');
  });

  it('reports a failing test in the result rather than as an error', async () => {
    backend.bucket('artifacts').failures.upload = 'AccessDenied';
    const { testBucket } = await client().expectOk(TEST, { input: rustfs() });
    expect(testBucket.ok).toBe(false);
    expect(testBucket.steps[1]).toEqual({
      step: 'PUT_OBJECT',
      ok: false,
      skipped: false,
      errorCode: 'AccessDenied',
      message: 'upload refused: AccessDenied.',
    });
  });

  it('tests a saved bucket with its stored secret when none is sent', async () => {
    const bucket = await create();
    const { testBucket } = await client().expectOk(TEST, { input: rustfs({ secretAccessKey: null }), id: bucket.id });
    expect(testBucket.ok).toBe(true);
    expect(backend.connections.at(-1)?.secretAccessKey).toBe(SECRET);

    expect((await client().expectError(TEST, { input: rustfs({ secretAccessKey: null }) })).message).toMatch(
      /secret access key/,
    );
    const otherError = await other().expectError(TEST, { input: rustfs({ secretAccessKey: null }), id: bucket.id });
    expect(otherError.code).toBe(ErrorCode.NotFound);
  });

  it('derives a slug from the name, takes a given one, and refuses a taken one with CONFLICT', async () => {
    await create({ name: 'Team Reports' });
    expect((await create({ name: 'Other', slug: 'reports' })).slug).toBe('reports');
    const taken = await client().expectError(CREATE, { input: rustfs({ name: 'Team reports' }) });
    expect(taken.code).toBe(ErrorCode.Conflict);
    expect(taken.message).toMatch(/team-reports/);
    // Slugs name MCP endpoints, so they are unique across the instance, not per owner.
    expect((await other().expectError(CREATE, { input: rustfs({ slug: 'reports' }) })).code).toBe(ErrorCode.Conflict);
    expect((await client().expectError(CREATE, { input: rustfs({ slug: 'Not A Slug' }) })).code).toBe(
      ErrorCode.BadUserInput,
    );
  });

  it('gives CONFLICT, not an internal error, when two saves race for one slug', async () => {
    // Both pass the slug check before either inserts; the unique index decides, and the loser
    // must hear the same CONFLICT the check would have given.
    const results = await Promise.allSettled([
      client().expectOk(CREATE, { input: rustfs({ slug: 'raced' }) }),
      client().expectOk(CREATE, { input: rustfs({ name: 'Second', slug: 'raced' }) }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const [lost] = results.filter((result) => result.status === 'rejected');
    expect((lost.reason as { extensions?: { code?: unknown } }).extensions?.code).toBe(ErrorCode.Conflict);
  });

  it('refuses a bucket that misses what its provider needs', async () => {
    const noSecret = await client().expectError(CREATE, { input: rustfs({ secretAccessKey: null }) });
    expect(noSecret.code).toBe(ErrorCode.BadUserInput);
    const noEndpoint = await client().expectError(CREATE, { input: rustfs({ endpoint: null }) });
    expect(noEndpoint.message).toMatch(/RustFS needs an endpoint/);
    const noRegion = await client().expectError(CREATE, { input: rustfs({ provider: 's3', endpoint: null }) });
    expect(noRegion.message).toMatch(/AWS S3 needs a region/);
  });

  it('updates the name without retesting, and retests when the connection changes', async () => {
    const bucket = await create();
    const tests = backend.connections.length;
    const { updateBucket } = await client().expectOk(UPDATE, { id: bucket.id, input: { name: 'Renamed' } });
    expect(updateBucket).toMatchObject({ name: 'Renamed', slug: 'dev-artifacts', endpoint: 'http://docker.lan:9010' });
    expect(backend.connections).toHaveLength(tests);

    const moved = await client().expectOk(UPDATE, {
      id: bucket.id,
      input: { endpoint: 'http://rustfs.lan:9000', publicEndpoint: 'https://files.example.com' },
    });
    expect(moved.updateBucket).toMatchObject({
      endpoint: 'http://rustfs.lan:9000',
      publicEndpoint: 'https://files.example.com',
    });
    expect(backend.connections).toHaveLength(tests + 1);
    expect(backend.connections.at(-1)?.secretAccessKey).toBe(SECRET);

    const cleared = await client().expectOk(UPDATE, { id: bucket.id, input: { publicEndpoint: null } });
    expect(cleared.updateBucket.publicEndpoint).toBeNull();
    expect(invalidated.filter((id) => id === bucket.id)).toHaveLength(4);
  });

  it('refuses an update whose retest fails, and keeps the stored settings', async () => {
    const bucket = await create();
    backend.bucket('elsewhere').failures.headBucket = 'AccessDenied';
    const error = await client().expectError(UPDATE, { id: bucket.id, input: { bucket: 'elsewhere' } });
    expect(error.code).toBe(ErrorCode.BadUserInput);
    const [row] = await db.select().from(buckets).where(eq(buckets.id, bucket.id));
    expect(row.bucket).toBe('artifacts');
  });

  it('replaces the secret on update when one is sent', async () => {
    const bucket = await create();
    await client().expectOk(UPDATE, { id: bucket.id, input: { secretAccessKey: 'new-secret' } });
    const [row] = await db.select().from(buckets).where(eq(buckets.id, bucket.id));
    expect(secrets.open(row.secretAccessKeyEnc, SecretPurpose.BucketSecret)).toBe('new-secret');
  });

  it('lets a slug be renamed, but not to another bucket’s', async () => {
    const first = await create();
    await create({ name: 'Second', bucket: 'second' });
    expect((await client().expectOk(UPDATE, { id: first.id, input: { slug: 'renamed' } })).updateBucket.slug).toBe(
      'renamed',
    );
    expect((await client().expectError(UPDATE, { id: first.id, input: { slug: 'second' } })).code).toBe(
      ErrorCode.Conflict,
    );
    expect((await client().expectOk(UPDATE, { id: first.id, input: { slug: 'renamed' } })).updateBucket.slug).toBe(
      'renamed',
    );
  });

  it('marks a bucket whose secret no longer decrypts, and setBucketSecret makes it readable again', async () => {
    const bucket = await create();
    const rotated = createTestSecrets('rotated-secret-0123456789abcdef01234567');
    const afterRotation = () =>
      createClient(db, owner, {
        backend,
        secrets: rotated,
        storage: createStorageRegistry({ db, secrets: rotated, factory: backend.factory }),
      });
    const { buckets: listed } = await afterRotation().expectOk('{ buckets { id secretReadable } }');
    expect(listed).toEqual([{ id: bucket.id, secretReadable: false }]);

    const retest = await afterRotation().expectError(TEST, { input: rustfs({ secretAccessKey: null }), id: bucket.id });
    expect(retest.message).toMatch(/Enter it again/);

    const { setBucketSecret } = await afterRotation().expectOk(SET_SECRET, { id: bucket.id, secret: SECRET });
    expect(setBucketSecret.secretReadable).toBe(true);
  });

  it('refuses a new secret that fails the test', async () => {
    const bucket = await create();
    backend.bucket('artifacts').failures.headBucket = 'SignatureDoesNotMatch';
    const error = await client().run(SET_SECRET, { id: bucket.id, secret: 'wrong' });
    expect(error.errors?.[0]?.extensions).toMatchObject({ step: 'HEAD_BUCKET', errorCode: 'SignatureDoesNotMatch' });
  });

  it('answers secretReadable when the query does not select the id', async () => {
    await create();
    expect((await client().expectOk('{ buckets { secretReadable } }')).buckets).toEqual([{ secretReadable: true }]);
  });

  it('asks for the id, not NOT_FOUND, when other columns are selected without it', async () => {
    // drizzle-graphql adds the primary key only when a query names no column at all.
    await create();
    const error = await client().expectError('{ buckets { name secretReadable } }');
    expect(error.code).toBe(ErrorCode.BadUserInput);
    expect(error.message).toMatch(/Select `id` alongside Bucket\.secretReadable/);
  });

  it('switches MCP on and writable, and refuses writable while off', async () => {
    const bucket = await create();
    const { setBucketMcp } = await client().expectOk(SET_MCP, { id: bucket.id, enabled: true, writable: true });
    expect(setBucketMcp).toEqual({ id: bucket.id, mcpEnabled: true, mcpWritable: true });
    const refused = await client().expectError(SET_MCP, { id: bucket.id, enabled: false, writable: true });
    expect(refused.code).toBe(ErrorCode.BadUserInput);
  });

  it('deletes a bucket and leaves the others', async () => {
    const first = await create();
    const second = await create({ name: 'Second', bucket: 'second' });
    const third = await create({ name: 'Third', bucket: 'third' });
    expect((await client().expectOk(DELETE, { id: first.id })).deleteBucket).toBe(true);
    const { buckets: listed } = await client().expectOk(LIST);
    expect(listed).toEqual([
      { id: second.id, slug: 'second' },
      { id: third.id, slug: 'third' },
    ]);
    await client().expectOk(DELETE, { id: third.id });
    expect((await client().expectOk(LIST)).buckets).toEqual([{ id: second.id, slug: 'second' }]);
    await client().expectOk(DELETE, { id: second.id });
    expect((await client().expectOk(LIST)).buckets).toEqual([]);
    expect(invalidated).toEqual(expect.arrayContaining([first.id, second.id, third.id]));
  });

  describe('a bucket that documents point at', () => {
    /** Inserts a document in the bucket, its object stored too. */
    async function documentIn(bucketId: string, key: string) {
      await db.insert(documents).values({
        userId: owner,
        bucketId,
        title: key,
        filename: `${key}.txt`,
        objectKey: key,
        contentType: 'text/plain',
        size: 2,
        status: DocumentStatus.Ready,
      });
      backend.bucket('artifacts').objects.set(key, { body: Buffer.from('hi'), contentType: 'text/plain' });
    }

    it('is refused with CONFLICT, and kept with its documents', async () => {
      const bucket = await create();
      await documentIn(bucket.id, 'one');
      await documentIn(bucket.id, 'two');
      const { code, message } = await client().expectError(DELETE, { id: bucket.id });
      expect(code).toBe(ErrorCode.Conflict);
      expect(message).toMatch(/2 documents/);
      expect((await client().expectOk(LIST)).buckets).toHaveLength(1);
      expect(await db.select().from(documents)).toHaveLength(2);
    });

    it('forgets the documents’ rows and leaves their objects in the bucket', async () => {
      const bucket = await create();
      const kept = await create({ name: 'Kept', bucket: 'kept' });
      await documentIn(bucket.id, 'one');
      await documentIn(kept.id, 'elsewhere');
      expect((await client().expectOk(FORGET, { id: bucket.id })).deleteBucket).toBe(true);
      expect((await client().expectOk(LIST)).buckets).toEqual([{ id: kept.id, slug: 'kept' }]);
      const left = await db.select({ objectKey: documents.objectKey }).from(documents);
      expect(left).toEqual([{ objectKey: 'elsewhere' }]);
      expect(backend.bucket('artifacts').objects.has('one')).toBe(true);
    });
  });

  it('frees the slug of a deleted bucket', async () => {
    const bucket = await create();
    await client().expectOk(DELETE, { id: bucket.id });
    expect((await create()).slug).toBe('dev-artifacts');
  });

  describe('a bucket that is missing or someone else’s', () => {
    let bucketId: string;

    beforeEach(async () => {
      bucketId = (await create()).id;
    });

    it.each([
      ['updateBucket', UPDATE, { input: { name: 'Mine now' } }],
      ['setBucketSecret', SET_SECRET, { secret: 'x' }],
      ['setBucketMcp', SET_MCP, { enabled: true, writable: false }],
      ['deleteBucket', DELETE, {}],
    ])('%s answers NOT_FOUND', async (_name, mutation, variables) => {
      expect((await other().expectError(mutation, { id: bucketId, ...variables })).code).toBe(ErrorCode.NotFound);
      expect((await client().expectError(mutation, { id: MISSING_ID, ...variables })).code).toBe(ErrorCode.NotFound);
    });

    it('is not listed for the other user', async () => {
      expect((await other().expectOk('{ buckets { id } }')).buckets).toEqual([]);
      const single = await other().expectOk('query ($id: UUID!) { bucket(where: { id: { eq: $id } }) { id } }', {
        id: bucketId,
      });
      expect(single.bucket).toBeNull();
    });
  });

  it('never returns the secret, in any response', async () => {
    const bucket = await create();
    const responses = [
      await client().run(`{ buckets { ${FIELDS} } }`),
      await client().run(UPDATE, { id: bucket.id, input: { name: 'x', secretAccessKey: 'rotated-secret' } }),
      await client().run(SET_SECRET, { id: bucket.id, secret: 'another-secret' }),
      await client().run(TEST, { input: rustfs({ secretAccessKey: 'probe-secret' }) }),
    ];
    const [row] = await db.select().from(buckets).where(eq(buckets.id, bucket.id));
    for (const response of responses) {
      const body = JSON.stringify(response);
      for (const secret of [SECRET, 'rotated-secret', 'another-secret', 'probe-secret', row.secretAccessKeyEnc]) {
        expect(body).not.toContain(secret);
      }
    }
    const selectSecret = await client().run('{ buckets { secretAccessKeyEnc } }');
    expect(selectSecret.errors?.[0]?.message).toMatch(/Cannot query field "secretAccessKeyEnc"/);
  });

  it('bounds the whole test by the configured budget', () => {
    expect(BUCKET_DEFAULTS.shareLinkTimeoutMs).toBeLessThan(BUCKET_DEFAULTS.testTimeoutMs);
  });
});
