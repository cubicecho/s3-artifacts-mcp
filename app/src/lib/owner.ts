import { CombinedGraphQLErrors } from '@apollo/client/errors';

// One account owns an instance: the first to sign in. The server refuses every
// other address with FORBIDDEN ("This instance already has an owner."), and the
// sign-in pages show that refusal as what it is rather than as a broken link.

/** The error code the server refuses a second account with. */
const FORBIDDEN = 'FORBIDDEN';

/**
 * The server's words when it refused to sign someone in because they are not the owner.
 *
 * @param error - What a sign-in request failed with.
 * @returns The refusal's message, or null when the failure was anything else.
 */
export function ownerRefusalOf(error: unknown): string | null {
  const isGraphQLError = CombinedGraphQLErrors.is(error);
  if (isGraphQLError === false) {
    return null;
  }
  const refusal = error.errors.find((entry) => entry.extensions?.code === FORBIDDEN);
  return refusal?.message ?? null;
}

/** The title every sign-in page gives the owner refusal. */
export const OWNER_REFUSAL_TITLE = "You can't sign in to this instance";

/**
 * What the owner refusal says under its title.
 *
 * @param message - The server's message.
 * @returns The message, and what it means for the reader.
 */
export function ownerRefusalDescription(message: string): string {
  return `${message} Only the owner's account can sign in here.`;
}
