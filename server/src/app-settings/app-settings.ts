import type { DB } from '@cubicecho/s3-artifacts-mcp-db';
import { type AppSettings, appSettings, ShareLinkPermission } from '@cubicecho/s3-artifacts-mcp-db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { UPLOAD_DEFAULTS } from '../core/defaults.ts';
import { BYTES_PER_GIBIBYTE, BYTES_PER_MEBIBYTE } from '../core/wire.ts';
import { expiryHoursSchema } from '../share-links/expiry.ts';

// The owner's settings row: the upload limit and what a new share link gets when its maker names nothing. Every
// account gets one when it is made (better-auth's `user.create.after`), and a reader that finds none makes it, so
// no path depends on the hook having run. Each value is bounded by a group in core/defaults.ts.

const { minUploadBytes, maxUploadBytes } = UPLOAD_DEFAULTS;

/**
 * A byte count as an upload limit is written: whole gibibytes as GiB, anything else in MiB.
 *
 * @param bytes - The count.
 * @returns For example "100 MiB" or "50 GiB".
 */
export function describeBytes(bytes: number): string {
  const isWholeGibibytes = bytes >= BYTES_PER_GIBIBYTE && bytes % BYTES_PER_GIBIBYTE === 0;
  if (isWholeGibibytes) {
    return `${bytes / BYTES_PER_GIBIBYTE} GiB`;
  }
  return `${Math.floor(bytes / BYTES_PER_MEBIBYTE)} MiB`;
}

/** What `updateAppSettings` may change. A key left out keeps its value. */
export const appSettingsUpdateSchema = z.object({
  maxUploadBytes: z
    .number()
    .int('The upload limit is a whole number of bytes.')
    .min(minUploadBytes, `The upload limit is at least ${describeBytes(minUploadBytes)}.`)
    .max(maxUploadBytes, `The upload limit is at most ${describeBytes(maxUploadBytes)}.`)
    .optional(),
  defaultLinkExpiryHours: expiryHoursSchema.optional(),
  defaultLinkPermission: z.enum([ShareLinkPermission.View, ShareLinkPermission.Download]).optional(),
});

/** What `updateAppSettings` saves, after the checks. */
export type AppSettingsUpdate = z.infer<typeof appSettingsUpdateSchema>;

/**
 * Makes a user's settings row with the columns' defaults, unless it exists.
 *
 * @param db - The database.
 * @param userId - Whose row.
 */
export async function ensureAppSettings(db: DB, userId: string): Promise<void> {
  await db.insert(appSettings).values({ userId }).onConflictDoNothing();
}

/**
 * Reads a user's settings, making the row first when there is none.
 *
 * @param db - The database.
 * @param userId - Whose settings.
 * @returns The row.
 */
export async function readAppSettings(db: DB, userId: string): Promise<AppSettings> {
  const read = () => db.select().from(appSettings).where(eq(appSettings.userId, userId));
  const [found] = await read();
  if (found !== undefined) {
    return found;
  }
  await ensureAppSettings(db, userId);
  const [made] = await read();
  return made;
}

/**
 * The largest file a user's uploads may declare now.
 *
 * @param settings - Their settings.
 * @returns The owner's limit, never past the bound in `UPLOAD_DEFAULTS`, in bytes.
 */
export function uploadLimitOf(settings: Pick<AppSettings, 'maxUploadBytes'>): number {
  return Math.min(settings.maxUploadBytes, maxUploadBytes);
}

/**
 * Saves changes to a user's settings.
 *
 * @param db - The database.
 * @param userId - Whose settings.
 * @param update - The checked changes.
 */
export async function updateAppSettings(db: DB, userId: string, update: AppSettingsUpdate): Promise<void> {
  await ensureAppSettings(db, userId);
  const isNothingToChange = Object.keys(update).length === 0;
  if (isNothingToChange) {
    return;
  }
  await db.update(appSettings).set(update).where(eq(appSettings.userId, userId));
}
