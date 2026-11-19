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
    expect(tableKeys.sort()).toEqual(['users']);
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

  beforeAll(async () => {
    db = await createTestDb();
    // Two rows, inserted past better-auth's owner gate, so the scope has someone to hide.
    alice = await createUser(db, 'alice@example.com');
    bob = await createUser(db, 'bob@example.com');
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
