import { type Bucket, buckets, documents } from '@cubicecho/s3-artifacts-mcp-db/schema';
import { resolveSelection } from '@vantreeseba/drizzle-graphql';
import { and, count, eq, ne } from 'drizzle-orm';
import { assertObjectType, extendSchema, type GraphQLResolveInfo, type GraphQLSchema } from 'graphql';
import { z } from 'zod';
import type { Context } from '../core/context.ts';
import { badInput, conflict, ErrorCode, notFound, requireAuth, withCode } from '../core/errors.ts';
import { FOREIGN_KEY_VIOLATION, isUniqueViolation, postgresErrorOf } from '../core/postgres-errors.ts';
import { SecretPurpose, SecretUnreadableError } from '../core/secrets.ts';
import { parseOrThrow } from '../core/validation.ts';
import { typeNames } from '../graphql/naming.ts';
import { parentIdOf } from '../graphql/parent-id.ts';
import type { BucketConnection } from '../storage/storage.ts';
import {
  type BucketFields,
  type BucketFieldsInput,
  connectionChanged,
  resolveBucketFields,
  secretSchema,
} from './input.ts';
import { BUCKET_PRESET_LIST } from './presets.ts';
import { BUCKETS_SDL } from './sdl.ts';
import { type BucketTestResult, blockingStep, runBucketTest } from './test.ts';

// The owner's buckets: presets, the connection test, and every write. Reads are the generated
// `buckets` / `bucket` fields, scoped by owner in tenancy.ts. Every write here is scoped by owner
// in its own SQL, answers NOT_FOUND for a bucket that is missing or someone else's, and drops the
// bucket's built storage from the registry, so the next request reads the new settings.

/** The table's key in the Drizzle schema, which `resolveSelection` names it by. */
const BUCKETS_TABLE = 'buckets';
/** The message for a bucket that does not exist or is not the caller's, which the caller may not tell apart. */
const NOT_FOUND_MESSAGE = 'Bucket not found.';
/** What a refused save carries in `extensions.reason`. */
export const TEST_FAILED_REASON = 'BUCKET_TEST_FAILED';

const idSchema = z.uuid();

/** `BucketInput` as the resolvers receive it. */
interface BucketInputArgs extends BucketFieldsInput {
  secretAccessKey?: string | null;
}

/** `BucketUpdateInput` as the resolvers receive it: a key left out keeps the stored value. */
type BucketUpdateArgs = { [Field in keyof BucketInputArgs]?: BucketInputArgs[Field] | null };

/**
 * Reads a bucket id from an argument, refusing one that cannot name a row.
 *
 * @param id - The argument as sent.
 * @returns The id.
 * @throws NOT_FOUND for anything that is not a UUID, as for an id that names nothing.
 */
function parseBucketId(id: string): string {
  const parsed = idSchema.safeParse(id);
  if (parsed.success === false) {
    throw notFound(NOT_FOUND_MESSAGE);
  }
  return parsed.data;
}

/**
 * Loads one of the caller's buckets, sealed secret included, for a write to start from.
 *
 * @param ctx - The request.
 * @param id - The bucket's id, as sent.
 * @returns The row.
 * @throws NOT_FOUND when it is missing or not the caller's.
 */
export async function ownBucket(ctx: Context, id: string): Promise<Bucket> {
  const userId = requireAuth(ctx);
  const [row] = await ctx.db
    .select()
    .from(buckets)
    .where(and(eq(buckets.id, parseBucketId(id)), eq(buckets.userId, userId)));
  if (row === undefined) {
    throw notFound(NOT_FOUND_MESSAGE);
  }
  return row;
}

/**
 * Answers a write with the bucket as the client selected it, relations included.
 *
 * @param ctx - The request.
 * @param info - The mutation's resolve info, whose selection is read.
 * @param id - The bucket written.
 * @returns The row, shaped like a generated read's.
 */
function selectBucket(ctx: Context, info: GraphQLResolveInfo, id: string): Promise<unknown> {
  return resolveSelection(info, {
    db: ctx.db,
    table: BUCKETS_TABLE,
    context: ctx,
    typeNameMapper: typeNames,
    where: { id: { eq: id } },
    single: true,
  });
}

/**
 * Refuses a save the connection test did not pass.
 *
 * @param result - The test.
 * @throws BAD_USER_INPUT naming the first step that failed and the service's error code.
 */
function requirePassed(result: BucketTestResult): void {
  const failed = blockingStep(result);
  if (failed === undefined) {
    return;
  }
  const said = [failed.errorCode, failed.message].filter((part) => part !== null).join(': ');
  const message = failed.skipped
    ? `The bucket test did not reach ${failed.step}.`
    : `The bucket test failed at ${failed.step}${said === '' ? '' : ` (${said})`}.`;
  throw withCode(message, ErrorCode.BadUserInput, {
    reason: TEST_FAILED_REASON,
    step: failed.step,
    errorCode: failed.errorCode,
  });
}

/**
 * Refuses a slug another bucket has.
 *
 * @param ctx - The request.
 * @param slug - The slug about to be saved.
 * @param exceptId - The bucket being updated, which may keep its own slug, or null for a new one.
 * @throws CONFLICT when another bucket on the instance has it.
 */
async function requireFreeSlug(ctx: Context, slug: string, exceptId: string | null): Promise<void> {
  const others = exceptId === null ? eq(buckets.slug, slug) : and(eq(buckets.slug, slug), ne(buckets.id, exceptId));
  const [taken] = await ctx.db.select({ id: buckets.id }).from(buckets).where(others);
  if (taken !== undefined) {
    throw conflict(`Another bucket already has the slug "${slug}". Choose another.`);
  }
}

/** The index that keeps slugs unique, from `db/src/models/buckets.ts`. */
const SLUG_INDEX = 'uq_buckets_slug';

/**
 * Runs a write that saves a slug, turning a lost race for it into the same CONFLICT the check gives.
 *
 * @param slug - The slug being saved.
 * @param write - The insert or update.
 * @returns What the write returns.
 * @throws CONFLICT when another bucket saved the slug first.
 */
async function withSlugGuard<T>(slug: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isUniqueViolation(error, SLUG_INDEX)) {
      throw conflict(`Another bucket already has the slug "${slug}". Choose another.`);
    }
    throw error;
  }
}

/**
 * Opens a stored bucket's secret for a test or an edit.
 *
 * @param ctx - The request.
 * @param row - The stored bucket.
 * @returns The secret.
 * @throws BAD_USER_INPUT asking for the secret again when it no longer decrypts.
 */
function storedSecret(ctx: Context, row: Bucket): string {
  try {
    return ctx.secrets.open(row.secretAccessKeyEnc, SecretPurpose.BucketSecret);
  } catch (error) {
    if (error instanceof SecretUnreadableError) {
      throw badInput(`The stored secret for ${row.name} can no longer be decrypted. Enter it again.`);
    }
    throw error;
  }
}

/**
 * Runs the connection test over settings, saved or not.
 *
 * @param ctx - The request, whose registry builds the storage and whose fetch opens the share link.
 * @param connection - Where the bucket is.
 * @param secretAccessKey - The access key's secret.
 * @returns The test's outcome.
 */
function testConnection(
  ctx: Context,
  connection: BucketConnection,
  secretAccessKey: string,
): Promise<BucketTestResult> {
  return runBucketTest(ctx.storage.connect(connection, secretAccessKey), {}, ctx.fetch);
}

/**
 * The stored settings of a bucket, as the form would send them.
 *
 * @param row - The stored bucket.
 * @returns Its settings, without the secret.
 */
function storedFields(row: Bucket): BucketFields {
  return {
    name: row.name,
    slug: row.slug,
    provider: row.provider,
    endpoint: row.endpoint,
    publicEndpoint: row.publicEndpoint,
    region: row.region,
    bucket: row.bucket,
    accessKeyId: row.accessKeyId,
    forcePathStyle: row.forcePathStyle,
  };
}

/**
 * Lays an update over the stored settings. A key left out, or sent as null, keeps its value,
 * except the endpoints, where null clears it.
 *
 * @param stored - The settings as saved.
 * @param changes - The update as sent.
 * @returns The settings to check, before the preset fills anything in.
 */
function mergeUpdate(stored: BucketFields, changes: BucketUpdateArgs): BucketFieldsInput {
  const provider = changes.provider ?? stored.provider;
  // A new provider brings its own preset unless the update says otherwise.
  const isNewProvider = provider !== stored.provider;
  return {
    name: changes.name ?? stored.name,
    slug: changes.slug ?? stored.slug,
    provider,
    endpoint: 'endpoint' in changes ? changes.endpoint : stored.endpoint,
    publicEndpoint: 'publicEndpoint' in changes ? changes.publicEndpoint : stored.publicEndpoint,
    region: changes.region ?? (isNewProvider ? null : stored.region),
    bucket: changes.bucket ?? stored.bucket,
    accessKeyId: changes.accessKeyId ?? stored.accessKeyId,
    forcePathStyle: changes.forcePathStyle ?? (isNewProvider ? null : stored.forcePathStyle),
  };
}

/**
 * Adds the bucket queries and mutations, and `Bucket.secretReadable`, to the schema.
 *
 * @param schema - The schema so far, which must already have a Mutation type and the generated `Bucket`.
 * @returns The extended schema.
 */
export function applyBucketsExtension(schema: GraphQLSchema): GraphQLSchema {
  const extended = extendSchema(schema, BUCKETS_SDL);
  const queries = assertObjectType(extended.getType('Query')).getFields();
  const mutations = assertObjectType(extended.getType('Mutation')).getFields();
  const bucketFields = assertObjectType(extended.getType('Bucket')).getFields();

  bucketFields.secretReadable.resolve = async (parent: { id?: unknown }, _args: unknown, context: Context) => {
    const row = await ownBucket(context, parentIdOf(parent, 'Bucket.secretReadable'));
    return context.secrets.canOpen(row.secretAccessKeyEnc, SecretPurpose.BucketSecret);
  };

  queries.bucketPresets.resolve = (_parent: unknown, _args: unknown, context: Context) => {
    requireAuth(context);
    return BUCKET_PRESET_LIST;
  };

  mutations.testBucket.resolve = async (
    _parent: unknown,
    args: { input: BucketInputArgs; id?: string | null },
    context: Context,
  ) => {
    requireAuth(context);
    const fields = resolveBucketFields(args.input);
    const sentSecret = args.input.secretAccessKey ?? null;
    if (sentSecret !== null) {
      return testConnection(context, fields, parseOrThrow(secretSchema, sentSecret));
    }
    const storedId = args.id ?? null;
    if (storedId === null) {
      throw badInput('Enter the secret access key.');
    }
    return testConnection(context, fields, storedSecret(context, await ownBucket(context, storedId)));
  };

  mutations.createBucket.resolve = async (
    _parent: unknown,
    args: { input: BucketInputArgs },
    context: Context,
    info: GraphQLResolveInfo,
  ) => {
    const userId = requireAuth(context);
    const fields = resolveBucketFields(args.input);
    const secret = parseOrThrow(secretSchema, args.input.secretAccessKey ?? '');
    await requireFreeSlug(context, fields.slug, null);
    requirePassed(await testConnection(context, fields, secret));

    const id = await withSlugGuard(fields.slug, () =>
      context.db
        .insert(buckets)
        .values({ ...fields, userId, secretAccessKeyEnc: context.secrets.seal(secret, SecretPurpose.BucketSecret) })
        .returning({ id: buckets.id })
        .then(([row]) => row.id),
    );
    context.storage.invalidate(id);
    return selectBucket(context, info, id);
  };

  mutations.updateBucket.resolve = async (
    _parent: unknown,
    args: { id: string; input: BucketUpdateArgs },
    context: Context,
    info: GraphQLResolveInfo,
  ) => {
    const row = await ownBucket(context, args.id);
    const stored = storedFields(row);
    const fields = resolveBucketFields(mergeUpdate(stored, args.input));
    const sentSecret = args.input.secretAccessKey ?? null;
    const newSecret = sentSecret === null ? null : parseOrThrow(secretSchema, sentSecret);
    if (fields.slug !== stored.slug) {
      await requireFreeSlug(context, fields.slug, row.id);
    }
    const needsTest = newSecret !== null || connectionChanged(stored, fields);
    if (needsTest) {
      requirePassed(await testConnection(context, fields, newSecret ?? storedSecret(context, row)));
    }
    const sealed =
      newSecret === null ? {} : { secretAccessKeyEnc: context.secrets.seal(newSecret, SecretPurpose.BucketSecret) };
    await withSlugGuard(fields.slug, () =>
      context.db
        .update(buckets)
        .set({ ...fields, ...sealed })
        .where(and(eq(buckets.id, row.id), eq(buckets.userId, row.userId))),
    );
    context.storage.invalidate(row.id);
    return selectBucket(context, info, row.id);
  };

  mutations.setBucketSecret.resolve = async (
    _parent: unknown,
    args: { id: string; secretAccessKey: string },
    context: Context,
    info: GraphQLResolveInfo,
  ) => {
    const row = await ownBucket(context, args.id);
    const secret = parseOrThrow(secretSchema, args.secretAccessKey);
    requirePassed(await testConnection(context, row, secret));
    await context.db
      .update(buckets)
      .set({ secretAccessKeyEnc: context.secrets.seal(secret, SecretPurpose.BucketSecret) })
      .where(and(eq(buckets.id, row.id), eq(buckets.userId, row.userId)));
    context.storage.invalidate(row.id);
    return selectBucket(context, info, row.id);
  };

  mutations.setBucketMcp.resolve = async (
    _parent: unknown,
    args: { id: string; enabled: boolean; writable: boolean },
    context: Context,
    info: GraphQLResolveInfo,
  ) => {
    const row = await ownBucket(context, args.id);
    const isWritableWhileOff = args.writable && args.enabled === false;
    if (isWritableWhileOff) {
      throw badInput('Turn MCP on for the bucket before making it writable.');
    }
    await context.db
      .update(buckets)
      .set({ mcpEnabled: args.enabled, mcpWritable: args.writable })
      .where(and(eq(buckets.id, row.id), eq(buckets.userId, row.userId)));
    context.storage.invalidate(row.id);
    return selectBucket(context, info, row.id);
  };

  mutations.deleteBucket.resolve = async (
    _parent: unknown,
    args: { id: string; forgetDocuments?: boolean | null },
    context: Context,
  ) => {
    const row = await ownBucket(context, args.id);
    const forgetDocuments = args.forgetDocuments ?? false;
    const inUse = conflict(
      `${row.name} still holds documents. Delete them first, or forget them (their files stay in the bucket).`,
    );
    await context.db
      .transaction(async (tx) => {
        const isInBucket = eq(documents.bucketId, row.id);
        if (forgetDocuments) {
          // The rows only: the objects stay in the bucket, which the owner may still use elsewhere.
          await tx.delete(documents).where(isInBucket);
        } else {
          const [{ held }] = await tx.select({ held: count() }).from(documents).where(isInBucket);
          if (held > 0) {
            throw conflict(
              `${row.name} still holds ${held} document${held === 1 ? '' : 's'}. Delete them first, or forget them ` +
                '(their files stay in the bucket).',
            );
          }
        }
        await tx.delete(buckets).where(and(eq(buckets.id, row.id), eq(buckets.userId, row.userId)));
      })
      .catch((error: unknown) => {
        // An upload started between the count and the delete: the foreign key refuses, and the
        // owner hears the same CONFLICT the count gives rather than an internal error.
        throw postgresErrorOf(error)?.code === FOREIGN_KEY_VIOLATION ? inUse : error;
      });
    context.storage.invalidate(row.id);
    return true;
  };

  return extended;
}
