import { DocumentStatus, documents, documentTags, tags } from '@cubicecho/s3-artifacts-mcp-db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TAG_DEFAULTS } from '../../core/defaults.ts';
import { ErrorCode } from '../../core/errors.ts';
import { objectKeyFor } from '../../documents/keys.ts';
import { colorForName, ensureTagsNamed, parseTagNames } from '../../tags/names.ts';
import {
  closeTestDb,
  createClient,
  createTestDb,
  createTestSecrets,
  createUser,
  insertBucket,
  resetTestDb,
  type TestDb,
} from '../helpers.ts';

// The owner's tags: the name rules, which MCP shares, the five mutations, and what deleting a tag or a document
// does to the links between them. Another user's tag or document answers NOT_FOUND, and nothing changes.

const TAG_FIELDS = 'id name color documentsAggregate(where: { status: { eq: ready } }) { count }';
const CREATE = `mutation ($name: String!, $color: String) { createTag(name: $name, color: $color) { ${TAG_FIELDS} } }`;
const UPDATE = `mutation ($id: UUID!, $name: String, $color: String) {
  updateTag(id: $id, name: $name, color: $color) { ${TAG_FIELDS} }
}`;
const DELETE = 'mutation ($id: UUID!) { deleteTag(id: $id) }';
const SET = `mutation ($documentId: UUID!, $tagIds: [UUID!]!) {
  setDocumentTags(documentId: $documentId, tagIds: $tagIds) { id tags(orderBy: { name: { direction: asc, priority: 1 } }) { name } }
}`;
const BULK = `mutation ($documentIds: [UUID!]!, $add: [UUID!], $remove: [UUID!]) {
  bulkTagDocuments(documentIds: $documentIds, add: $add, remove: $remove) {
    id tags(orderBy: { name: { direction: asc, priority: 1 } }) { name }
  }
}`;
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

describe('tags', () => {
  let db: TestDb;
  let owner: string;
  let stranger: string;
  let bucketId: string;
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
  });

  const client = () => createClient(db, owner, { secrets });
  const other = () => createClient(db, stranger, { secrets });

  /**
   * A ready document of a user's, straight through Drizzle.
   *
   * @param title - Its title.
   * @param [userId] - Whose it is: the owner unless said.
   * @param [bucket] - Its bucket: the owner's unless said.
   * @returns Its id.
   */
  async function insertDocument(title: string, userId = owner, bucket = bucketId): Promise<string> {
    const id = crypto.randomUUID();
    await db.insert(documents).values({
      id,
      userId,
      bucketId: bucket,
      title,
      filename: `${title}.txt`,
      objectKey: objectKeyFor(id, `${title}.txt`),
      contentType: 'text/plain',
      size: 5,
      status: DocumentStatus.Ready,
    });
    return id;
  }

  /**
   * Makes a tag through the API.
   *
   * @param name - Its name.
   * @param [color] - Its colour.
   * @returns Its id.
   */
  async function createTag(name: string, color?: string): Promise<string> {
    const data = await client().expectOk(CREATE, { name, color });
    return data.createTag.id;
  }

  describe('names', () => {
    it('trims a name and keeps its case, and writes a colour out in lower case', async () => {
      const data = await client().expectOk(CREATE, { name: '  Invoices  ', color: '#3B8' });
      expect(data.createTag).toMatchObject({ name: 'Invoices', color: '#33bb88', documentsAggregate: { count: 0 } });
    });

    it('gives a tag made without a colour one from the palette, the same for the same name', async () => {
      const data = await client().expectOk(CREATE, { name: 'Receipts' });
      expect(TAG_DEFAULTS.palette).toContain(data.createTag.color);
      expect(data.createTag.color).toBe(colorForName('receipts'));
    });

    it.each([
      ['an empty name', '   ', /needs a name/],
      ['a name past the cap', 'x'.repeat(TAG_DEFAULTS.nameMaxLength + 1), /at most/],
      ['a control character', 'two\nlines', /control characters/],
    ])('refuses %s', async (_case, name, message) => {
      const error = await client().expectError(CREATE, { name });
      expect(error.code).toBe(ErrorCode.BadUserInput);
      expect(error.message).toMatch(message);
    });

    it('refuses a colour that is not hex', async () => {
      const error = await client().expectError(CREATE, { name: 'Blue', color: 'blue' });
      expect(error.code).toBe(ErrorCode.BadUserInput);
    });

    it('takes a name at the cap', async () => {
      const name = 'x'.repeat(TAG_DEFAULTS.nameMaxLength);
      expect((await client().expectOk(CREATE, { name })).createTag.name).toBe(name);
    });

    it('refuses a name the owner already has, in another case', async () => {
      await createTag('Invoices');
      const error = await client().expectError(CREATE, { name: 'INVOICES' });
      expect(error.code).toBe(ErrorCode.Conflict);
      expect(error.message).toMatch(/already have a tag called “INVOICES”/);
    });

    it('lets two saves race for a name differing only in case, and answers the loser CONFLICT', async () => {
      // Both clients are built first, so both checks are asked before either insert: the unique index decides.
      const [first, second] = [client(), client()];
      const results = await Promise.all([
        first.run(CREATE, { name: 'Contracts' }),
        second.run(CREATE, { name: 'contracts' }),
      ]);
      const succeeded = results.filter((result) => result.errors === undefined);
      const refused = results.flatMap((result) => result.errors ?? []);
      expect(succeeded).toHaveLength(1);
      expect(refused.map((error) => error.extensions?.code)).toEqual([ErrorCode.Conflict]);
      expect(await db.select().from(tags).where(eq(tags.userId, owner))).toHaveLength(1);
    });

    it('lets another user have the same name', async () => {
      await createTag('Invoices');
      const data = await other().expectOk(CREATE, { name: 'invoices' });
      expect(data.createTag.name).toBe('invoices');
    });

    it('lets a tag change the case of its own name, and refuses another tag’s', async () => {
      const id = await createTag('invoices');
      await createTag('Receipts');
      expect((await client().expectOk(UPDATE, { id, name: 'Invoices' })).updateTag.name).toBe('Invoices');
      const error = await client().expectError(UPDATE, { id, name: 'receipts' });
      expect(error.code).toBe(ErrorCode.Conflict);
    });

    it('drops repeated names ignoring case, keeping the first spelling', () => {
      expect(parseTagNames([' Draft ', 'draft', 'Final', 'DRAFT'])).toEqual(['Draft', 'Final']);
    });

    it('finds tags by name in any case, and makes the missing ones only once', async () => {
      const existing = await createTag('Invoices');
      const [found, made] = await ensureTagsNamed(db, owner, ['invoices', 'Q3']);
      expect(found.id).toBe(existing);
      expect(made).toMatchObject({ name: 'Q3', color: colorForName('Q3') });
      const [again] = await ensureTagsNamed(db, owner, ['q3']);
      expect(again.id).toBe(made.id);
      expect(await db.select().from(tags).where(eq(tags.userId, owner))).toHaveLength(2);
    });

    it('finds rather than refuses a name made by a call alongside', async () => {
      const [first, second] = await Promise.all([
        ensureTagsNamed(db, owner, ['Shared']),
        ensureTagsNamed(db, owner, ['SHARED']),
      ]);
      expect(first[0].id).toBe(second[0].id);
    });
  });

  describe('editing', () => {
    it('renames and recolours a tag, together or apart', async () => {
      const id = await createTag('Old', '#ef4444');
      expect((await client().expectOk(UPDATE, { id, name: 'New' })).updateTag).toMatchObject({
        name: 'New',
        color: '#ef4444',
      });
      expect((await client().expectOk(UPDATE, { id, color: '#22c55e' })).updateTag).toMatchObject({
        name: 'New',
        color: '#22c55e',
      });
      const error = await client().expectError(UPDATE, { id });
      expect(error.code).toBe(ErrorCode.BadUserInput);
    });

    it('answers NOT_FOUND for another user’s tag and a missing one, changing nothing', async () => {
      const theirs = (await other().expectOk(CREATE, { name: 'Theirs' })).createTag.id;
      for (const id of [theirs, MISSING_ID]) {
        expect((await client().expectError(UPDATE, { id, name: 'Mine' })).code).toBe(ErrorCode.NotFound);
        expect((await client().expectError(DELETE, { id })).code).toBe(ErrorCode.NotFound);
      }
      const [row] = await db.select().from(tags).where(eq(tags.id, theirs));
      expect(row.name).toBe('Theirs');
    });

    it('takes a deleted tag off every document, and leaves the documents', async () => {
      const id = await createTag('Doomed');
      const keep = await createTag('Kept');
      const first = await insertDocument('first');
      const second = await insertDocument('second');
      await client().expectOk(BULK, { documentIds: [first, second], add: [id, keep] });
      expect(await client().expectOk(DELETE, { id })).toEqual({ deleteTag: true });
      const links = await db.select().from(documentTags);
      expect(links.map((link) => link.tagId)).toEqual([keep, keep]);
      expect(await db.select().from(documents)).toHaveLength(2);
    });

    it('takes a deleted document’s tags with it, and leaves the tags', async () => {
      const id = await createTag('Stays');
      const document = await insertDocument('goes');
      await client().expectOk(SET, { documentId: document, tagIds: [id] });
      await db.delete(documents).where(eq(documents.id, document));
      expect(await db.select().from(documentTags)).toEqual([]);
      expect(await db.select().from(tags).where(eq(tags.id, id))).toHaveLength(1);
    });
  });

  describe('setDocumentTags', () => {
    it('makes a document’s tags exactly the ones sent, and counts the tag’s documents', async () => {
      const [a, b, c] = [await createTag('a'), await createTag('b'), await createTag('c')];
      const document = await insertDocument('report');
      const first = await client().expectOk(SET, { documentId: document, tagIds: [a, b, a] });
      expect(first.setDocumentTags.tags).toEqual([{ name: 'a' }, { name: 'b' }]);
      const second = await client().expectOk(SET, { documentId: document, tagIds: [b, c] });
      expect(second.setDocumentTags.tags).toEqual([{ name: 'b' }, { name: 'c' }]);
      const counted = await client().expectOk(
        `{ tags(orderBy: { name: { direction: asc, priority: 1 } }) { ${TAG_FIELDS} } }`,
      );
      expect(
        counted.tags.map((tag: { documentsAggregate: { count: number } }) => tag.documentsAggregate.count),
      ).toEqual([0, 1, 1]);
      const cleared = await client().expectOk(SET, { documentId: document, tagIds: [] });
      expect(cleared.setDocumentTags.tags).toEqual([]);
    });

    it('answers NOT_FOUND for another user’s document or tag, changing nothing', async () => {
      const mine = await createTag('mine');
      const theirs = (await other().expectOk(CREATE, { name: 'theirs' })).createTag.id;
      const strangerBucket = await insertBucket(db, secrets, stranger);
      const theirDocument = await insertDocument('theirs', stranger, strangerBucket);
      const myDocument = await insertDocument('mine');
      await client().expectOk(SET, { documentId: myDocument, tagIds: [mine] });

      const onTheirDocument = await client().expectError(SET, { documentId: theirDocument, tagIds: [mine] });
      expect(onTheirDocument.code).toBe(ErrorCode.NotFound);
      const withTheirTag = await client().expectError(SET, { documentId: myDocument, tagIds: [theirs] });
      expect(withTheirTag.code).toBe(ErrorCode.NotFound);
      const links = await db.select().from(documentTags);
      expect(links).toEqual([expect.objectContaining({ documentId: myDocument, tagId: mine, userId: owner })]);
    });
  });

  describe('bulkTagDocuments', () => {
    it('adds and removes in one call, leaving what neither names', async () => {
      const [draft, final, kept] = [await createTag('draft'), await createTag('final'), await createTag('kept')];
      const first = await insertDocument('first');
      const second = await insertDocument('second');
      const untouched = await insertDocument('untouched');
      await client().expectOk(BULK, { documentIds: [first, second, untouched], add: [draft, kept] });

      const data = await client().expectOk(BULK, { documentIds: [first, second], add: [final], remove: [draft] });
      const byId = new Map(
        data.bulkTagDocuments.map((row: { id: string; tags: { name: string }[] }) => [row.id, row.tags]),
      );
      expect(byId.get(first)).toEqual([{ name: 'final' }, { name: 'kept' }]);
      expect(byId.get(second)).toEqual([{ name: 'final' }, { name: 'kept' }]);
      const rest = await client().expectOk(SET, {
        documentId: untouched,
        tagIds: [draft, kept],
      });
      expect(rest.setDocumentTags.tags).toEqual([{ name: 'draft' }, { name: 'kept' }]);
    });

    it('refuses a tag in both lists, and no documents', async () => {
      const tag = await createTag('both');
      const document = await insertDocument('doc');
      const both = await client().expectError(BULK, { documentIds: [document], add: [tag], remove: [tag] });
      expect(both.code).toBe(ErrorCode.BadUserInput);
      const none = await client().expectError(BULK, { documentIds: [], add: [tag] });
      expect(none.code).toBe(ErrorCode.BadUserInput);
      expect(await db.select().from(documentTags)).toEqual([]);
    });

    it('refuses more documents than the cap', async () => {
      const tag = await createTag('many');
      const documentIds = Array.from({ length: TAG_DEFAULTS.bulkMaxDocuments + 1 }, () => crypto.randomUUID());
      const error = await client().expectError(BULK, { documentIds, add: [tag] });
      expect(error.code).toBe(ErrorCode.BadUserInput);
    });

    it('answers NOT_FOUND when any document or tag is someone else’s, changing nothing', async () => {
      const mine = await createTag('mine');
      const theirs = (await other().expectOk(CREATE, { name: 'theirs' })).createTag.id;
      const strangerBucket = await insertBucket(db, secrets, stranger);
      const theirDocument = await insertDocument('theirs', stranger, strangerBucket);
      const myDocument = await insertDocument('mine');

      const mixedDocuments = await client().expectError(BULK, {
        documentIds: [myDocument, theirDocument],
        add: [mine],
      });
      expect(mixedDocuments.code).toBe(ErrorCode.NotFound);
      const mixedTags = await client().expectError(BULK, { documentIds: [myDocument], add: [mine, theirs] });
      expect(mixedTags.code).toBe(ErrorCode.NotFound);
      const removingTheirs = await client().expectError(BULK, { documentIds: [myDocument], remove: [theirs] });
      expect(removingTheirs.code).toBe(ErrorCode.NotFound);
      expect(await db.select().from(documentTags)).toEqual([]);
    });
  });

  it('shows the owner only their own tags and links, through every read', async () => {
    const mine = await createTag('mine');
    const theirs = (await other().expectOk(CREATE, { name: 'theirs' })).createTag.id;
    const document = await insertDocument('doc');
    await client().expectOk(SET, { documentId: document, tagIds: [mine] });
    // A link of the stranger's onto the owner's document, which no API path could make.
    await db.insert(documentTags).values({ documentId: document, tagId: theirs, userId: stranger });

    const data = await client().expectOk('{ tags { id } documentTags { tagId } documents { tags { id } } }');
    expect(data).toEqual({
      tags: [{ id: mine }],
      documentTags: [{ tagId: mine }],
      documents: [{ tags: [{ id: mine }] }],
    });
  });
});
