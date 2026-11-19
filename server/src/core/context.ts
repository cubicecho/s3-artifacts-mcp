import type { DB } from '@cubicecho/s3-artifacts-mcp-db';
import type { AuthHost } from '../auth/auth-host.ts';
import type { Auth } from '../auth/better-auth.ts';
import type { RateLimiter } from '../auth/rate-limit.ts';

/** `Context.ip` when Express gave no address, as when a test runs an operation in-process. */
export const UNKNOWN_IP = 'unknown';

/**
 * What every resolver — generated or hand-written — is handed. `userId` is the
 * only thing that says who the caller is: it comes from the request's session
 * and nothing downstream may take it from an argument.
 */
export interface Context {
  db: DB;
  /** better-auth instance for this request; the auth resolvers call `ctx.auth.api.*`. */
  auth: Auth;
  /** Where `auth` came from. Pairing a provider rebuilds it, so later requests get the new one. */
  authHost: AuthHost;
  /** Sign-in throttle; the auth mutations call it. */
  limiter: RateLimiter;
  /** Client address, for rate-limit keys. Never an identity. */
  ip: string;
  /** Signed-in user, or null. Resolvers call requireAuth(ctx) rather than reading this. */
  userId: string | null;
  /**
   * Where the caller reached this instance: `APP_URL`, or the request's own scheme and host.
   * Links and redirect URIs handed back to the caller are built from it.
   */
  origin: string;
  /** Request headers; sign-out needs them to find the session. */
  headers: Headers;
}
