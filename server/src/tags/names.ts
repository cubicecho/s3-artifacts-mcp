import type { DB } from '@cubicecho/s3-artifacts-mcp-db';
import { type Tag, tags } from '@cubicecho/s3-artifacts-mcp-db/schema';
import { and, eq, inArray, ne, type SQL, sql } from 'drizzle-orm';
import type { GraphQLError } from 'graphql';
import { z } from 'zod';
import { TAG_DEFAULTS } from '../core/defaults.ts';
import { badInput, conflict } from '../core/errors.ts';
import { isUniqueViolation } from '../core/postgres-errors.ts';
import { parseOrThrow } from '../core/validation.ts';

// What a tag's name and colour may be, for the app and for MCP alike. A name is trimmed, capped, and unique to its
// owner ignoring case (D8): "Invoices" and "invoices" are one tag. The check runs before each write and the unique
// index `(user_id, lower(name))` decides a race, which answers the same CONFLICT. MCP names tags rather than
// picking them, so it finds a tag by its name in any case and makes the ones that are missing.

/** The index that keeps names unique, from `db/src/models/tags.ts`. */
const NAME_INDEX = 'uq_tags_user_name';
/** Control characters, which a name never needs. */
const CONTROL_CHARACTERS = /\p{Cc}/u;
/** `#rgb` or `#rrggbb`. */
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
/** How many hex digits the short form has, each doubled to make the long one. */
const SHORT_HEX_DIGITS = 3;
/** The multiplier of the name hash a palette colour is picked by. */
const HASH_MULTIPLIER = 31;

const { nameMaxLength, maxTagsPerCall, palette } = TAG_DEFAULTS;

/** A tag's name: trimmed, not empty, at most `TAG_DEFAULTS.nameMaxLength` characters. */
export const tagNameSchema = z
  .string()
  .trim()
  .min(1, 'A tag needs a name.')
  .max(nameMaxLength, `A tag name can be at most ${nameMaxLength} characters.`)
  .refine((name) => CONTROL_CHARACTERS.test(name) === false, 'A tag name cannot contain control characters.');

/** A tag's colour, as `#rrggbb` in lower case. `#rgb` is taken and written out. */
export const tagColorSchema = z
  .string()
  .trim()
  .regex(HEX_COLOR, 'A colour is a hex value, such as `#3b82f6`.')
  .transform((hex) => {
    const digits = hex.slice(1).toLowerCase();
    const isShort = digits.length === SHORT_HEX_DIGITS;
    return `#${isShort ? [...digits].map((digit) => digit + digit).join('') : digits}`;
  });

/** A list of names, as the app or an agent sends them. */
const tagNamesSchema = z.array(tagNameSchema).max(maxTagsPerCall, `Name at most ${maxTagsPerCall} tags at a time.`);

/**
 * A name as it is compared: in lower case, as the unique index compares it.
 *
 * @param name - A trimmed name.
 * @returns Its key.
 */
function nameKey(name: string): string {
  return name.toLowerCase();
}

/**
 * The colour a tag made without one is given: one of the palette's, picked by the name, so the same name gets the
 * same colour every time.
 *
 * @param name - The tag's name.
 * @returns A `#rrggbb` colour.
 */
export function colorForName(name: string): string {
  let hash = 0;
  for (const char of nameKey(name)) {
    hash = (hash * HASH_MULTIPLIER + (char.codePointAt(0) ?? 0)) >>> 0;
  }
  return palette[hash % palette.length] ?? '#64748b';
}

/**
 * Checks a list of names and drops the repeats, ignoring case. The first spelling of each is kept.
 *
 * @param names - The names as sent.
 * @returns The trimmed names, each once.
 * @throws BAD_USER_INPUT for a bad name, or more than `TAG_DEFAULTS.maxTagsPerCall`.
 */
export function parseTagNames(names: readonly unknown[]): string[] {
  const parsed = parseOrThrow(tagNamesSchema, names);
  const seen = new Set<string>();
  return parsed.filter((name) => {
    const key = nameKey(name);
    const isRepeat = seen.has(key);
    seen.add(key);
    return isRepeat === false;
  });
}

/**
 * The CONFLICT for a name the owner has already given another tag.
 *
 * @param name - The name, as it was asked for.
 * @returns The error to throw.
 */
function nameTaken(name: string): GraphQLError {
  return conflict(`You already have a tag called “${name}”. Tag names are unique, ignoring case.`);
}

/**
 * Refuses a name another of the owner's tags has, in any case.
 *
 * @param db - The database.
 * @param userId - The owner.
 * @param name - The trimmed name.
 * @param exceptId - The tag being renamed, which may keep its own name in a new case, or null for a new tag.
 * @throws CONFLICT when the name is taken.
 */
async function requireFreeName(db: DB, userId: string, name: string, exceptId: string | null): Promise<void> {
  const sameName = and(eq(tags.userId, userId), eq(sql`lower(${tags.name})`, nameKey(name)));
  const others = exceptId === null ? sameName : and(sameName, ne(tags.id, exceptId));
  const [taken] = await db.select({ id: tags.id }).from(tags).where(others);
  if (taken !== undefined) {
    throw nameTaken(name);
  }
}

/**
 * Runs a write that saves a name, turning a lost race for it into the same CONFLICT the check gives.
 *
 * @typeParam T - What the write returns.
 * @param name - The name being saved.
 * @param write - The insert or update.
 * @returns What the write returns.
 * @throws CONFLICT when another tag saved the name first.
 */
async function withNameGuard<T>(name: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isUniqueViolation(error, NAME_INDEX)) {
      throw nameTaken(name);
    }
    throw error;
  }
}

/** What a new tag or an edit sends. A field left out (or null) is not changed; a new tag left without a colour gets one. */
export interface TagInput {
  name?: unknown;
  color?: unknown;
}

/**
 * Makes one of the owner's tags.
 *
 * @param db - The database.
 * @param userId - The owner.
 * @param input - Its name, and its colour if chosen.
 * @returns The tag.
 * @throws BAD_USER_INPUT for a bad name or colour; CONFLICT for a name the owner already has, in any case.
 */
export async function createTagRow(db: DB, userId: string, input: TagInput): Promise<Tag> {
  const name = parseOrThrow(tagNameSchema, input.name);
  const color = input.color == null ? colorForName(name) : parseOrThrow(tagColorSchema, input.color);
  await requireFreeName(db, userId, name, null);
  const [row] = await withNameGuard(name, () => db.insert(tags).values({ userId, name, color }).returning());
  return row;
}

/**
 * Renames or recolours one of the owner's tags.
 *
 * @param db - The database.
 * @param tag - The tag, already found to be the owner's.
 * @param input - The new name, the new colour, or both.
 * @returns The tag as it is now.
 * @throws BAD_USER_INPUT for a bad name or colour, or neither given; CONFLICT for a name another tag has.
 */
export async function updateTagRow(db: DB, tag: Tag, input: TagInput): Promise<Tag> {
  const name = input.name == null ? undefined : parseOrThrow(tagNameSchema, input.name);
  const color = input.color == null ? undefined : parseOrThrow(tagColorSchema, input.color);
  if (name === undefined && color === undefined) {
    throw badInput('Send a new name, a new colour, or both.');
  }
  if (name !== undefined) {
    await requireFreeName(db, tag.userId, name, tag.id);
  }
  const [row] = await withNameGuard(name ?? tag.name, () =>
    db
      .update(tags)
      .set({ ...(name === undefined ? {} : { name }), ...(color === undefined ? {} : { color }) })
      .where(and(eq(tags.id, tag.id), eq(tags.userId, tag.userId)))
      .returning(),
  );
  return row;
}

/**
 * The owner's tags of these names, in any case.
 *
 * @param db - The database.
 * @param userId - The owner.
 * @param names - Trimmed names, from `parseTagNames`.
 * @returns The tags that exist, in no particular order.
 */
export function findTagsNamed(db: DB, userId: string, names: readonly string[]): Promise<Tag[]> {
  if (names.length === 0) {
    return Promise.resolve([]);
  }
  const isNamed: SQL = inArray(sql`lower(${tags.name})`, names.map(nameKey));
  return db
    .select()
    .from(tags)
    .where(and(eq(tags.userId, userId), isNamed));
}

/**
 * The owner's tags of these names, making the ones that are missing with the palette's colour. A name another call
 * makes at the same moment is found rather than refused, so this never answers CONFLICT.
 *
 * @param db - The database.
 * @param userId - The owner.
 * @param names - Trimmed names, from `parseTagNames`.
 * @returns A tag for each name, in the order the names were given.
 */
export async function ensureTagsNamed(db: DB, userId: string, names: readonly string[]): Promise<Tag[]> {
  const found = await findTagsNamed(db, userId, names);
  const existing = new Set(found.map((tag) => nameKey(tag.name)));
  const missing = names.filter((name) => existing.has(nameKey(name)) === false);
  if (missing.length > 0) {
    await db
      .insert(tags)
      .values(missing.map((name) => ({ userId, name, color: colorForName(name) })))
      .onConflictDoNothing();
  }
  const all = missing.length > 0 ? await findTagsNamed(db, userId, names) : found;
  const byKey = new Map(all.map((tag) => [nameKey(tag.name), tag]));
  return names.flatMap((name) => byKey.get(nameKey(name)) ?? []);
}
