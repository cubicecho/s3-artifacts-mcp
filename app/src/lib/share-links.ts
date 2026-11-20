import type { ShareLinkPermission, ShareLinkState } from '@/__generated__/graphql';

// What the app knows about share links that is not a component: how long one lasts, in the words the expiry
// picker uses, and the words and limits the screens agree on. The limits themselves come from the server
// (`appSettingsLimits`); nothing here hard-codes 7 days.

/** Hours in one day, the larger unit an expiry is chosen in. */
export const HOURS_PER_DAY = 24;

/** The two units a custom expiry is typed in. */
export const ExpiryUnit = { Hours: 'hours', Days: 'days' } as const;
/** One of the units in `ExpiryUnit`. */
export type ExpiryUnit = (typeof ExpiryUnit)[keyof typeof ExpiryUnit];

/** How many hours one of each unit is. */
const HOURS_PER_UNIT: Readonly<Record<ExpiryUnit, number>> = Object.freeze({
  [ExpiryUnit.Hours]: 1,
  [ExpiryUnit.Days]: HOURS_PER_DAY,
});

/** The shortest and longest a link may last, in hours, as `appSettingsLimits` answers them. */
export interface ExpiryLimits {
  minLinkExpiryHours: number;
  maxLinkExpiryHours: number;
}

/**
 * A number of hours as a person says it: whole days as days, anything else in hours.
 *
 * @param hours - The lifetime.
 * @returns For example "1 hour", "36 hours", "1 day" or "7 days".
 */
export function describeExpiry(hours: number): string {
  const isWholeDays = hours >= HOURS_PER_DAY && hours % HOURS_PER_DAY === 0;
  const [amount, unit] = isWholeDays ? [hours / HOURS_PER_DAY, 'day'] : [hours, 'hour'];
  return `${amount} ${unit}${amount === 1 ? '' : 's'}`;
}

/**
 * The hours a custom amount comes to.
 *
 * @param amount - What was typed, or null when nothing that reads as a number was.
 * @param unit - Hours or days.
 * @returns The hours, or null when the amount is not a whole positive number.
 */
export function hoursOf(amount: number | null, unit: ExpiryUnit): number | null {
  const isWholePositive = amount !== null && Number.isInteger(amount) && amount > 0;
  return isWholePositive ? amount * HOURS_PER_UNIT[unit] : null;
}

/**
 * A lifetime split the way the custom fields show it: whole days in days, anything else in hours.
 *
 * @param hours - The lifetime.
 * @returns The amount and its unit.
 */
export function splitHours(hours: number): { amount: number; unit: ExpiryUnit } {
  const isWholeDays = hours >= HOURS_PER_DAY && hours % HOURS_PER_DAY === 0;
  return isWholeDays
    ? { amount: hours / HOURS_PER_DAY, unit: ExpiryUnit.Days }
    : { amount: hours, unit: ExpiryUnit.Hours };
}

/**
 * What is wrong with a chosen lifetime. The server checks it too.
 *
 * @param hours - The lifetime, or null when the custom amount is not a whole number.
 * @param limits - The shortest and longest the server allows.
 * @returns The problem, or undefined when there is none.
 */
export function expiryError(hours: number | null, limits: ExpiryLimits): string | undefined {
  const range = `from ${describeExpiry(limits.minLinkExpiryHours)} to ${describeExpiry(limits.maxLinkExpiryHours)}`;
  if (hours === null) {
    return `Enter a whole number of hours or days, ${range}`;
  }
  const isOutOfRange = hours < limits.minLinkExpiryHours || hours > limits.maxLinkExpiryHours;
  return isOutOfRange ? `Choose ${range}` : undefined;
}

/** What each permission is called on screen. */
export const PERMISSION_LABELS: Readonly<Record<ShareLinkPermission, string>> = Object.freeze({
  view: 'View',
  download: 'Download',
});

/** What each state is called on screen. */
export const STATE_LABELS: Readonly<Record<ShareLinkState, string>> = Object.freeze({
  active: 'Active',
  expired: 'Expired',
  revoked: 'Revoked',
});

/** Who made a link, as the list says it. */
export const CREATOR_LABELS: Readonly<Record<'owner' | 'mcp', string>> = Object.freeze({
  owner: 'Made by you',
  mcp: 'Made by an MCP client',
});

/** The queries a new, removed or revoked link changes, by operation name, for `refetchQueries`. */
export const SHARE_LINK_QUERIES = ['DocumentShareLinks', 'ShareLinks'] as const;
