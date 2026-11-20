import type { DB } from '@cubicecho/s3-artifacts-mcp-db';
import { relations } from '@cubicecho/s3-artifacts-mcp-db/relations';
import * as dbSchema from '@cubicecho/s3-artifacts-mcp-db/schema';
import { PGlite } from '@electric-sql/pglite';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { getTableName, is, sql, Table } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { type ExecutionResult, graphql } from 'graphql';
import { ensureAppSettings } from '../app-settings/app-settings.ts';
import { type AuthHost, fixedAuthHost } from '../auth/auth-host.ts';
import { type Auth, createAuth, type MagicLink } from '../auth/better-auth.ts';
import { createRateLimiter, type RateLimiter } from '../auth/rate-limit.ts';
import { appUrl, type OidcConfig } from '../core/config.ts';
import type { Context } from '../core/context.ts';
import { createSecretBox, type SecretBox, SecretPurpose } from '../core/secrets.ts';
import { createSchema } from '../graphql/build-schema.ts';
import { createStorageRegistry, type StorageRegistry } from '../storage/registry.ts';
import { createMemoryBackend, type MemoryBackend } from './memory-storage.ts';

// A throwaway in-memory Postgres per suite. `@cubicecho/s3-artifacts-mcp-db` is
// deliberately never imported here — it opens a real connection at import time —
// so the schema is pulled from `@cubicecho/s3-artifacts-mcp-db/schema`, which is inert.

export type TestDb = DB;

/** Signing secret for test auth instances. Long enough to pass `AUTH_DEFAULTS.minSecretLength`, like production's. */
export const TEST_SECRET = 'test-secret-0123456789abcdef0123456789';
/** The address a client's requests come from unless a test says otherwise. */
export const TEST_IP = '127.0.0.1';

export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite('memory://');
  const db = drizzle({ client, relations });
  const { apply } = await pushSchema(dbSchema as never, db as never);
  await apply();
  return db;
}

/** Every table in the schema, quoted for a statement that names them all. */
const TABLE_LIST = Object.values(dbSchema)
  .flatMap((value) => (is(value, Table) ? [`"${getTableName(value)}"`] : []))
  .join(', ');

/**
 * Empties every table, so the next test starts from the db `createTestDb` returned. Cheaper than a new one.
 *
 * @param db - Test db.
 */
export async function resetTestDb(db: TestDb): Promise<void> {
  await db.execute(sql.raw(`TRUNCATE TABLE ${TABLE_LIST} RESTART IDENTITY CASCADE`));
}

/**
 * Shuts a test db down. An instance left open holds its whole Postgres in memory until the worker exits.
 *
 * @param db - Test db.
 */
export async function closeTestDb(db: TestDb): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: the PGlite client behind the postgres-js-shaped DB type
  await (db as any).$client.close();
}

/**
 * A user row created straight through Drizzle, with the settings row better-auth's `user.create.after` would
 * make: signup is not what is under test.
 */
export async function createUser(db: TestDb, email: string): Promise<string> {
  const [user] = await db.insert(dbSchema.users).values({ email }).returning();
  await ensureAppSettings(db, user.id);
  return user.id;
}

/** A test auth instance and the magic links it captured. */
export interface TestAuth {
  auth: Auth;
  /** Captured links, newest last. */
  links: MagicLink[];
}

/**
 * better-auth over the test db, with magic links captured instead of logged.
 *
 * @param db - The test database.
 * @param [oidc] - An OIDC provider to sign in with. None by default, whatever the environment says.
 */
export function createTestAuth(db: TestDb, oidc: OidcConfig | null = null): TestAuth {
  const links: MagicLink[] = [];
  const auth = createAuth(db, {
    secret: TEST_SECRET,
    oidc,
    sendMagicLink: async (link) => {
      links.push(link);
    },
  });
  return { auth, links };
}

/**
 * Opens a session for a user straight through better-auth's adapter, as a sign-in would, for a request that
 * sends it as `Authorization: Bearer`.
 *
 * @param auth - The auth instance the server under test reads sessions with.
 * @param userId - Who signs in.
 * @returns The session token.
 */
export async function createSessionToken(auth: Auth, userId: string): Promise<string> {
  const session = await (await auth.$context).internalAdapter.createSession(userId);
  return session.token;
}

/** The secret every test bucket is sealed with, as the dev RustFS's. */
export const TEST_BUCKET_SECRET = 's3am-dev-secret';

/**
 * Inserts a bucket row straight through Drizzle, its secret sealed with `secrets`. The connection test is not
 * what is under test.
 *
 * @param db - Test db.
 * @param secrets - Seals the secret.
 * @param userId - Whose bucket it is.
 * @param [overrides] - Columns to change, such as `bucket` to put it in another memory bucket.
 * @returns The bucket's id.
 */
export async function insertBucket(
  db: TestDb,
  secrets: SecretBox,
  userId: string,
  overrides: Partial<dbSchema.NewBucket> = {},
): Promise<string> {
  const [row] = await db
    .insert(dbSchema.buckets)
    .values({
      userId,
      slug: `bucket-${Math.random().toString(36).slice(2, 10)}`,
      name: 'Artifacts',
      provider: 'rustfs',
      endpoint: 'http://rustfs.test:9000',
      region: 'us-east-1',
      bucket: 'artifacts',
      accessKeyId: 's3am',
      secretAccessKeyEnc: secrets.seal(TEST_BUCKET_SECRET, SecretPurpose.BucketSecret),
      forcePathStyle: true,
      ...overrides,
    })
    .returning({ id: dbSchema.buckets.id });
  return row.id;
}

/** Who a session token signs in as, through the same call a request's context makes. */
export async function sessionUserId(auth: Auth, token: string): Promise<string | null> {
  const session = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) });
  return session?.user.id ?? null;
}

export interface TestClient {
  /** Runs an operation as `userId`, or unauthenticated when it is null. */
  run: (query: string, variables?: Record<string, unknown>) => Promise<ExecutionResult>;
  /** Runs an operation and throws unless it succeeded, returning `data`. */
  // biome-ignore lint/suspicious/noExplicitAny: caller shapes the response
  expectOk: (query: string, variables?: Record<string, unknown>) => Promise<any>;
  /** Runs an operation, expects exactly one error, and returns it. */
  expectError: (query: string, variables?: Record<string, unknown>) => Promise<{ message: string; code: unknown }>;
}

export interface ClientOptions {
  /** Pass one to share sessions and captured magic links across clients. Defaults to a fresh `createTestAuth(db).auth`. */
  auth?: Auth;
  /** Pass one to see pairing rebuild it. Defaults to a host that always hands out `auth`. */
  authHost?: AuthHost;
  /** Pass a small one to reach the budget. Defaults to `createRateLimiter()`. */
  limiter?: RateLimiter;
  /** Client address the limiter keys on. Defaults to `TEST_IP`. */
  ip?: string;
  /** The session token the request carries, for a mutation that reads it from the headers. */
  token?: string;
  /** Where the caller reached the instance. Defaults to `appUrl()`. */
  origin?: string;
  /** The pretend S3 service buckets are stored in. Defaults to a fresh `createMemoryBackend()`. */
  backend?: MemoryBackend;
  /** Seals bucket secrets. Defaults to `createTestSecrets()`. */
  secrets?: SecretBox;
  /** Every bucket's storage. Defaults to a registry over `backend`. */
  storage?: StorageRegistry;
}

/**
 * The secret box tests seal with, keyed like production from a signing secret.
 *
 * @param [masterSecret] - Defaults to `TEST_SECRET`; pass another to play a rotated `BETTER_AUTH_SECRET`.
 * @returns The box.
 */
export function createTestSecrets(masterSecret = TEST_SECRET): SecretBox {
  return createSecretBox(masterSecret);
}

/** The bucket dependencies `createApp` takes, over a pretend S3 service. */
export interface TestStorageDeps {
  storage: StorageRegistry;
  secrets: SecretBox;
  fetch: typeof fetch;
  /** The pretend service, to put objects in or make an operation fail. */
  backend: MemoryBackend;
}

/**
 * The storage registry, secret box and fetch an app under test is built with.
 *
 * @param db - The test database the registry reads bucket rows from.
 * @returns Them, and the memory backend behind them.
 */
export function createTestStorageDeps(db: TestDb): TestStorageDeps {
  const backend = createMemoryBackend();
  const secrets = createTestSecrets();
  return {
    storage: createStorageRegistry({ db, secrets, factory: backend.factory }),
    secrets,
    fetch: backend.fetch,
    backend,
  };
}

export function createClient(db: TestDb, userId: string | null, options: ClientOptions = {}): TestClient {
  const { schema } = createSchema(db);
  const { limiter = createRateLimiter(), ip = TEST_IP, token } = options;
  const authHost = options.authHost ?? fixedAuthHost(options.auth ?? createTestAuth(db).auth);
  const backend = options.backend ?? createMemoryBackend();
  const secrets = options.secrets ?? createTestSecrets();
  const storage = options.storage ?? createStorageRegistry({ db, secrets, factory: backend.factory });

  const run = async (query: string, variables?: Record<string, unknown>) => {
    const headers = new Headers(token === undefined ? {} : { authorization: `Bearer ${token}` });
    const contextValue: Context = {
      db,
      // Per run, as the handler does per request: a pairing may have rebuilt it since the last one.
      auth: authHost.current(),
      authHost,
      limiter,
      ip,
      userId,
      origin: options.origin ?? appUrl(),
      headers,
      storage,
      secrets,
      fetch: backend.fetch,
    };
    return graphql({ schema, source: query, contextValue, variableValues: variables });
  };

  return {
    run,
    expectOk: async (query, variables) => {
      const result = await run(query, variables);
      // graphql masks a thrown non-GraphQLError as "Internal server error";
      // surface the original so a broken test reads as the bug it is.
      if (result.errors?.length) {
        const [first] = result.errors;
        throw first.originalError ?? new Error(result.errors.map((error) => error.message).join('; '));
      }
      return result.data;
    },
    expectError: async (query, variables) => {
      const result = await run(query, variables);
      const error = result.errors?.[0];
      if (!error) {
        throw new Error('expected an error, got a successful result');
      }
      return { message: error.message, code: error.extensions?.code };
    },
  };
}
