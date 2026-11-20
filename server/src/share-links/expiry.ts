import { z } from 'zod';
import { SHARE_LINK_DEFAULTS } from '../core/defaults.ts';
import { MS_PER_HOUR } from '../core/wire.ts';

// How long a share link lasts: a whole number of hours, from `minExpiryHours` to `maxExpiryHours`. The top is
// SigV4's own limit of seven days, so no setting can raise it, and there is no "never".

const { minExpiryHours, maxExpiryHours } = SHARE_LINK_DEFAULTS;

/** A share link's lifetime in hours, as a new link or the default in Settings → General gives it. */
export const expiryHoursSchema = z
  .number()
  .int('A share link lasts a whole number of hours.')
  .min(minExpiryHours, `A share link lasts at least ${minExpiryHours} hour.`)
  .max(maxExpiryHours, `A share link lasts at most ${maxExpiryHours} hours (7 days), the most S3 allows.`);

/**
 * When a link made now stops working.
 *
 * @param hours - Its lifetime, already checked.
 * @param now - The moment it is made.
 * @returns The moment it expires.
 */
export function expiryFrom(hours: number, now: Date): Date {
  return new Date(now.getTime() + hours * MS_PER_HOUR);
}
