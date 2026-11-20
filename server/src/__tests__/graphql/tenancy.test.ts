import * as dbSchema from '@cubicecho/s3-artifacts-mcp-db/schema';
import { getTableName, is, Table } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErrorCode } from '../../core/errors.ts';
import { contextValues, scope } from '../../graphql/tenancy.ts';
import { closeTestDb, createClient, createTestDb, createUser, type TestDb } from '../helpers.ts';

// The test that fails when someone adds a table and forgets tenancy. `scope` is
// what confines every generated read to the caller; a table missing from it is
// readable across tenants, and nothing else in the codebase would say so.

/** better-auth's tables and the server's own, which are not exposed through GraphQL. */
const UNSERVED_TABLES = new Set<string>([...dbSchema.AUTH_TABLES, ...dbSchema.SERVER_TABLES]);

const isServedTable = (key: string, value: unknown): boolean => is(value, Table) && UNSERVED_TABLES.has(key) === false;

const tableKeys = Object.entries(dbSchema)
  .filter(([key, value]) => isServedTable(key, value))
  .map(([key]) => key);

describe('tenancy configuration', () => {
  it('finds the tables', () => {
    expect(tableKeys.sort()).toEqual([
      'appSettings',
      'buckets',
      'documentTags',
      'documents',
      'shareLinks',
      'tags',
      'users',
    ]);
  });

  it.each(tableKeys)('scopes %s to the caller', (key) => {
    expect(scope[key]).toBeTypeOf('function');
  });

  it.each(tableKeys.filter((key) => key !== 'users'))('stamps userId on %s rather than accepting it', (key) => {
    expect(contextValues[key]?.userId).toBeTypeOf('function');
  });

  it('names every table by its Drizzle key, not its SQL name', () => {
    for (const [key, value] of Object.entries(dbSchema)) {
      const isOtherExport = is(value, Table) === false;
      if (isOtherExport || UNSERVED_TABLES.has(key)) {
        continue;
      }
      expect(Object.keys(scope)).toContain(key);
      expect(getTableName(value)).toBeTypeOf('string');
    }
  });
});

describe('tenancy at runtime', () => {
  let db: TestDb;
  let alice: string;
  let bob: string;

  let bobBucket: string;
  let bobDocument: string;
  let bobLink: string;
  let bobTag: string;

  beforeAll(async () => {
    db = await createTestDb();
    // Two rows, inserted past better-auth's owner gate, so the scope has someone to hide.
    alice = await createUser(db, 'alice@example.com');
    bob = await createUser(db, 'bob@example.com');
    const [row] = await db
      .insert(dbSchema.buckets)
      .values({
        userId: bob,
        slug: 'bobs',
        name: 'Bob’s',
        provider: 'rustfs',
        endpoint: 'http://rustfs.lan:9000',
        region: 'us-east-1',
        bucket: 'bobs',
        accessKeyId: 'bob',
        secretAccessKeyEnc: 'v1.sealed',
      })
      .returning({ id: dbSchema.buckets.id });
    bobBucket = row.id;
    const [document] = await db
      .insert(dbSchema.documents)
      .values({
        userId: bob,
        bucketId: bobBucket,
        title: 'Bob’s notes',
        filename: 'notes.txt',
        objectKey: 'notes',
        contentType: 'text/plain',
        size: 5,
      })
      .returning({ id: dbSchema.documents.id });
    bobDocument = document.id;
    const [link] = await db
      .insert(dbSchema.shareLinks)
      .values({
        userId: bob,
        documentId: bobDocument,
        permission: 'download',
        urlEnc: 'v1.sealed',
        objectKey: 'notes',
        expiresAt: new Date(Date.now() + 3_600_000),
        createdBy: 'owner',
      })
      .returning({ id: dbSchema.shareLinks.id });
    bobLink = link.id;
    const [tag] = await db
      .insert(dbSchema.tags)
      .values({ userId: bob, name: 'Bob’s', color: '#22c55e' })
      .returning({ id: dbSchema.tags.id });
    bobTag = tag.id;
    await db.insert(dbSchema.documentTags).values({ documentId: bobDocument, tagId: bobTag, userId: bob });
  });

  afterAll(() => closeTestDb(db));

  it('lists only the caller’s own user row', async () => {
    const asAlice = await createClient(db, alice).expectOk('{ users { id } }');
    expect(asAlice.users).toEqual([{ id: alice }]);
  });

  it('cannot be widened by a client filter', async () => {
    const data = await createClient(db, alice).expectOk(
      'query ($id: UUID!) { users(where: { id: { eq: $id } }) { id } }',
      { id: bob },
    );
    expect(data.users).toEqual([]);
  });

  it('hides another user’s buckets, even through a filter on their id', async () => {
    expect((await createClient(db, alice).expectOk('{ buckets { id } }')).buckets).toEqual([]);
    const filtered = await createClient(db, alice).expectOk(
      'query ($id: UUID!) { buckets(where: { id: { eq: $id } }) { id } }',
      { id: bobBucket },
    );
    expect(filtered.buckets).toEqual([]);
    expect((await createClient(db, bob).expectOk('{ buckets { id } }')).buckets).toEqual([{ id: bobBucket }]);
  });

  it('hides another user’s documents, even through a filter on their id or their bucket', async () => {
    const alicesView = createClient(db, alice);
    expect((await alicesView.expectOk('{ documents { id } }')).documents).toEqual([]);
    const byId = await alicesView.expectOk('query ($id: UUID!) { document(where: { id: { eq: $id } }) { id } }', {
      id: bobDocument,
    });
    expect(byId.document).toBeNull();
    const byBucket = await alicesView.expectOk(
      'query ($id: UUID!) { documents(where: { bucketId: { eq: $id } }) { id } }',
      { id: bobBucket },
    );
    expect(byBucket.documents).toEqual([]);
    const asBob = await createClient(db, bob).expectOk('{ documents { id bucket { id } } }');
    expect(asBob.documents).toEqual([{ id: bobDocument, bucket: { id: bobBucket } }]);
  });

  it('hides another user’s share links, through a filter and through their document alike', async () => {
    const alicesView = createClient(db, alice);
    expect((await alicesView.expectOk('{ shareLinks { id } }')).shareLinks).toEqual([]);
    const byId = await alicesView.expectOk('query ($id: UUID!) { shareLink(where: { id: { eq: $id } }) { id } }', {
      id: bobLink,
    });
    expect(byId.shareLink).toBeNull();
    const byDocument = await alicesView.expectOk(
      'query ($id: UUID!) { shareLinks(where: { documentId: { eq: $id } }) { id } }',
      { id: bobDocument },
    );
    expect(byDocument.shareLinks).toEqual([]);
    const asBob = await createClient(db, bob).expectOk('{ documents { shareLinks { id } } }');
    expect(asBob.documents).toEqual([{ shareLinks: [{ id: bobLink }] }]);
  });

  it('hides another user’s tags and their links, through a filter, a document and a count alike', async () => {
    const alicesView = createClient(db, alice);
    expect(await alicesView.expectOk('{ tags { id } documentTags { tagId } }')).toEqual({ tags: [], documentTags: [] });
    const byId = await alicesView.expectOk('query ($id: UUID!) { tag(where: { id: { eq: $id } }) { id } }', {
      id: bobTag,
    });
    expect(byId.tag).toBeNull();
    const asBob = await createClient(db, bob).expectOk(
      '{ documents { tags { id } } tags { documentsAggregate { count } } }',
    );
    expect(asBob).toEqual({ documents: [{ tags: [{ id: bobTag }] }], tags: [{ documentsAggregate: { count: 1 } }] });
  });

  it('keeps a share link’s sealed URL out of the schema', async () => {
    const result = await createClient(db, bob).run('{ shareLinks { urlEnc } }');
    expect(result.errors?.[0]?.message).toMatch(/Cannot query field "urlEnc"/);
  });

  it('answers each user their own settings row, and never another’s', async () => {
    await db
      .insert(dbSchema.appSettings)
      .values({ userId: bob, maxUploadBytes: 2_097_152 })
      .onConflictDoUpdate({
        target: dbSchema.appSettings.userId,
        set: { maxUploadBytes: 2_097_152 },
      });
    await db.insert(dbSchema.appSettings).values({ userId: alice }).onConflictDoNothing();
    const asAlice = await createClient(db, alice).expectOk(
      '{ appSettings { userId maxUploadBytes } appSettingsRows { userId } }',
    );
    expect(asAlice.appSettings.userId).toBe(alice);
    expect(asAlice.appSettingsRows).toEqual([{ userId: alice }]);
    const filtered = await createClient(db, alice).expectOk(
      'query ($id: UUID!) { appSettings(where: { userId: { eq: $id } }) { userId } }',
      { id: bob },
    );
    expect(filtered.appSettings).toBeNull();
  });

  it('refuses the unauthenticated', async () => {
    const error = await createClient(db, null).expectError('{ users { id } }');
    expect(error.code).toBe(ErrorCode.Unauthenticated);
  });

  it.each(['sessions', 'accounts', 'verifications', 'apikeys', 'oidcSettings'])(
    'keeps %s out of the schema',
    async (table) => {
      const result = await createClient(db, alice).run(`{ ${table} { id } }`);
      expect(result.errors?.[0]?.message).toMatch(new RegExp(`Cannot query field "${table}"`));
    },
  );

  it('generates no writes for any table', async () => {
    const result = await createClient(db, alice).run('mutation { updateUser(set: {}) { id } }');
    expect(result.errors?.[0]?.message).toMatch(/Cannot query field "updateUser"/);
  });
});
