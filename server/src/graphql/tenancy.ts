import type { BuildSchemaConfig } from '@vantreeseba/drizzle-graphql';
import { eq } from 'drizzle-orm';
import { requireAuth } from '../core/errors.ts';

// Multi-tenancy, expressed as drizzle-graphql configuration rather than as
// resolver wrappers. `scope` is ANDed into the SQL of every read the library
// generates — list and single queries, aggregates, relation fields — after the
// client's own `where`, so a client filter can only ever narrow it.
//
// The rule for anyone adding a table: it needs an entry here, or its rows are
// visible across tenants. __tests__/tenancy.test.ts fails when one is missing.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyTable = any;

/**
 * The tables whose rows carry the owner's id and are scoped by it. None yet: the buckets,
 * documents, tags and share links each add theirs here with their model.
 */
export const USER_OWNED_TABLES = [] as const;

/** Every table with a scope entry: the ones drizzle-graphql generates fields for. */
export const ALL_TABLES = ['users', ...USER_OWNED_TABLES] as const;

/**
 * The row filter for each table, ANDed into every generated read after the client's own `where`.
 * A table missing here is visible across tenants.
 */
export const scope: NonNullable<BuildSchemaConfig['scope']> = {
  // A user row is only ever visible to its owner. There is no directory here.
  users: (context, table) => eq((table as AnyTable).id, requireAuth(context)),
};

/**
 * Columns the server owns, stamped from the request. No table here has
 * generated writes today; this is kept so turning one on cannot forget it.
 */
export const contextValues: NonNullable<BuildSchemaConfig['contextValues']> = {};

/**
 * No generated writes at all. Every write is a hand-written mutation, and `users` belongs to the
 * auth flow.
 */
export const features: NonNullable<BuildSchemaConfig['features']> = {
  insert: false,
  update: false,
  updateMany: false,
  delete: false,
};
