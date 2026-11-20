// Telling apart the refusals Postgres gives a write, so a lost race answers the same code as the check before it.
// Drizzle wraps the driver's error, so its fields are on a cause, not on what the write threw.

/** Postgres's code for a unique violation. */
export const UNIQUE_VIOLATION = '23505';
/** Postgres's code for a foreign key refusing a write. */
export const FOREIGN_KEY_VIOLATION = '23503';

/** A SQLSTATE: five digits or capitals. */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * The Postgres error in an error's `cause` chain, if any.
 *
 * @param error - What a write threw.
 * @returns The SQLSTATE and constraint name, or null when no Postgres error is in the chain.
 */
export function postgresErrorOf(error: unknown): { code: string; constraint: unknown } | null {
  for (let current: unknown = error; current instanceof Object; current = (current as { cause?: unknown }).cause) {
    const { code, constraint } = current as { code?: unknown; constraint?: unknown };
    if (typeof code === 'string' && SQLSTATE.test(code)) {
      return { code, constraint };
    }
  }
  return null;
}

/**
 * Whether a write was refused by one unique index.
 *
 * @param error - What a write threw.
 * @param index - The index's name, as the model declares it.
 * @returns True when another row took the value between a check and the write.
 */
export function isUniqueViolation(error: unknown, index: string): boolean {
  const found = postgresErrorOf(error);
  return found?.code === UNIQUE_VIOLATION && found.constraint === index;
}
