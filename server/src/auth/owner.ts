import type { DB } from '@cubicecho/s3-artifacts-mcp-db';
import * as dbSchema from '@cubicecho/s3-artifacts-mcp-db/schema';
import { APIError } from 'better-auth/api';
import { asc } from 'drizzle-orm';

// One person owns the instance: the first account to sign in, by any method. Every
// account is made through better-auth's adapter (a magic link, SECURE_LOCAL_NET,
// OIDC), so `refuseSecondUser` in its `user.create.before` hook is the one gate,
// and no other address can make an account once there is an owner. Rows that
// belong to someone still carry an owner id, so more accounts later is additive.

/** better-auth's error code when an account is refused because the instance has an owner. */
export const OWNER_EXISTS_CODE = 'OWNER_EXISTS';
/** What a refused sign-up is told. */
export const OWNER_EXISTS_MESSAGE = 'This instance already has an owner.';

/**
 * Reads who owns the instance.
 *
 * @param db - The database.
 * @returns The oldest account's id, or null on an instance nobody has signed in to yet.
 */
export async function ownerId(db: DB): Promise<string | null> {
  const [owner] = await db
    .select({ id: dbSchema.users.id })
    .from(dbSchema.users)
    .orderBy(asc(dbSchema.users.createdAt), asc(dbSchema.users.id))
    .limit(1);
  return owner?.id ?? null;
}

/**
 * Whether anyone owns the instance yet.
 *
 * @param db - The database.
 * @returns True once the first account exists.
 */
export async function hasOwner(db: DB): Promise<boolean> {
  return (await ownerId(db)) !== null;
}

/**
 * Whether a user is the owner.
 *
 * @param db - The database.
 * @param userId - The user.
 * @returns True for the owner's account; false for any other, and for one that does not exist.
 */
export async function isOwner(db: DB, userId: string): Promise<boolean> {
  return (await ownerId(db)) === userId;
}

/**
 * Refuses to make an account once the instance has an owner. better-auth's `user.create.before` hook.
 *
 * @param db - The database.
 * @throws A FORBIDDEN `APIError` coded `OWNER_EXISTS` when there is an owner already. better-auth
 *   passes it on: thrown from `createUser`, or as `?error=OWNER_EXISTS` on an OIDC callback's redirect.
 */
export async function refuseSecondUser(db: DB): Promise<void> {
  if (await hasOwner(db)) {
    throw new APIError('FORBIDDEN', { code: OWNER_EXISTS_CODE, message: OWNER_EXISTS_MESSAGE });
  }
}
