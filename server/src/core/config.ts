// Everything is read at call time so a test — or a reload — sees the current
// environment.

import { createRequire } from 'node:module';
import { DATABASE_DEFAULTS } from '@cubicecho/s3-artifacts-mcp-db/defaults';
import { AUTH_DEFAULTS, type AuthSettings, HTTP_DEFAULTS } from './defaults.ts';

/** Signs sessions when `BETTER_AUTH_SECRET` is unset. Preflight refuses it in production. */
export const DEV_SECRET = 'dev-secret-change-in-production-0123456789';
/** The value `.env.example` ships, which preflight refuses in production. */
export const PLACEHOLDER_SECRET = 'change-me-to-a-long-random-string';
/** The `TRUST_PROXY` word for trusting no hop, as opposed to a hop count or a subnet list. */
const TRUST_PROXY_OFF = 'false';
/** The `TRUST_PROXY` word for trusting every hop. */
const TRUST_PROXY_ON = 'true';
/** A whole number of proxy hops. */
const HOP_COUNT = /^\d+$/;
/** What `NODE_ENV` is on a deployed instance. */
const PRODUCTION = 'production';

// The exception to "read at call time": this is stamped into the build, not
// configured. The root package.json is the one semantic-release bumps, and the
// Dockerfile copies it to /app alongside the workspaces — so `../../../` finds the
// released version in the image and the working tree's version in development.
const VERSION: string = (() => {
  try {
    return createRequire(import.meta.url)('../../../package.json').version || 'unknown';
  } catch {
    return 'unknown';
  }
})();

/**
 * Names the release this instance is running, for the settings screen and bug reports.
 *
 * @returns The version in the root package.json, or `unknown` when it cannot be read.
 */
export function version(): string {
  return VERSION;
}

/**
 * Reads a truthy env-var value.
 *
 * @param value - The variable as set, if it is. "1", "true" and "yes" count, in any case.
 * @returns false when unset or anything else.
 */
export function envFlag(value: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes((value ?? '').trim().toLowerCase());
}

/** Falsy env-var values: "0", "false", "no" (case-insensitive). */
function envDisabled(value: string | undefined): boolean {
  return ['0', 'false', 'no'].includes((value ?? '').trim().toLowerCase());
}

/**
 * Reads a switch that has a default.
 *
 * @param value - The variable as set, if it is.
 * @param fallback - What the switch is when the variable says neither yes nor no.
 * @returns Whether the switch is on.
 */
function envSwitch(value: string | undefined, fallback: boolean): boolean {
  if (envFlag(value)) {
    return true;
  }
  return envDisabled(value) ? false : fallback;
}

/**
 * Reads a count or a size: a whole number above zero.
 *
 * @param value - The variable as set, if it is.
 * @param fallback - What to use when the variable is unset or is not a positive whole number.
 * @returns The number to use.
 *
 * @remarks
 * Every number configured here is a port or a millisecond count. A fraction is a typo in both.
 */
export function envPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Whether this is a deployed instance rather than a development or test one.
 *
 * @returns true when `NODE_ENV` is `production`.
 */
export function isProduction(): boolean {
  return process.env.NODE_ENV === PRODUCTION;
}

/**
 * How long boot waits for Postgres before exiting.
 *
 * @returns `DB_CONNECT_TIMEOUT_MS`, or `DATABASE_DEFAULTS.connectTimeoutMs`, in milliseconds.
 */
export function dbConnectTimeoutMs(): number {
  return envPositiveInteger(process.env.DB_CONNECT_TIMEOUT_MS, DATABASE_DEFAULTS.connectTimeoutMs);
}

/**
 * Reads the Postgres connection string, which preflight has already refused to boot without.
 *
 * @returns `DATABASE_URL`, or an empty string when unset.
 */
export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? '';
}

/**
 * Reads what better-auth signs sessions and hashes magic-link tokens with.
 *
 * @returns `BETTER_AUTH_SECRET`, or `DEV_SECRET` when unset.
 */
export function authSecret(): string {
  return process.env.BETTER_AUTH_SECRET || DEV_SECRET;
}

/**
 * Reads what Express trusts `X-Forwarded-For` from, which decides whose address `req.ip` is.
 *
 * @returns false or true, a hop count, or a subnet list passed through as written.
 *
 * @remarks
 * The sign-in throttle counts by `req.ip`: wrong, every client shares the proxy's address and
 * is locked out together.
 */
export function trustProxy(): boolean | number | string {
  const value = (process.env.TRUST_PROXY ?? '').trim();
  if (value === '') {
    return HTTP_DEFAULTS.trustProxy;
  }
  if (value === TRUST_PROXY_OFF) {
    return false;
  }
  if (value === TRUST_PROXY_ON) {
    return true;
  }
  return HOP_COUNT.test(value) ? Number(value) : value;
}

/**
 * Whether this instance trusts the network it is on.
 *
 * @returns `SECURE_LOCAL_NET`, or `AUTH_DEFAULTS.secureLocalNet`.
 *
 * @remarks
 * `SECURE_LOCAL_NET` is the ecosystem-wide spelling of "there is nothing hostile between the
 * browser and this port, so do not make people prove who they are". Here that means sign-in
 * needs no link.
 */
export function secureLocalNet(): boolean {
  return envSwitch(process.env.SECURE_LOCAL_NET, AUTH_DEFAULTS.secureLocalNet);
}

/**
 * Whether signing in requires following a magic link at all.
 *
 * @returns false when `SECURE_LOCAL_NET` is on.
 *
 * @remarks
 * Off, `requestSignIn` hands back a live session for whatever address it is given (the owner's,
 * or the first one on an empty instance). That is a deliberate convenience for a private
 * self-hosted instance, and must never be set on one exposed to the internet: the email address
 * becomes the entire credential.
 */
export function magicLinkRequired(): boolean {
  return secureLocalNet() === false;
}

/**
 * Whether the magic link is returned in the API response rather than only logged.
 *
 * @returns true outside production, or when `EXPOSE_MAGIC_LINK` is on.
 */
export function magicLinkExposed(): boolean {
  return isProduction() === false || envSwitch(process.env.EXPOSE_MAGIC_LINK, AUTH_DEFAULTS.exposeMagicLink);
}

/** The id the OIDC provider is registered under in better-auth, and so the last part of its callback path. */
export const OIDC_PROVIDER_ID = 'oidc';

/** An OpenID Connect provider to sign in with (heautou, Keycloak, Authentik, …), as a pairing saved it. */
export interface OidcConfig {
  /** The issuer URL, no trailing slash. Its discovery document is `/.well-known/openid-configuration` under it. */
  issuer: string;
  clientId: string;
  /** Unset for a public client, which proves itself with PKCE alone. */
  clientSecret: string | undefined;
  /** How a confidential client sends its secret. The provider must expect the same. */
  clientAuth: AuthSettings['oidcClientAuth'];
  /** What the login page's button calls the provider. */
  name: string;
}

/**
 * Names the address to register with the OIDC provider as this client's redirect URI.
 *
 * @param [origin] - Where the instance is reached. A request passes the origin it came in on.
 * @returns better-auth's callback for the provider, under that origin.
 */
export function oidcRedirectUri(origin: string = appUrl()): string {
  return `${origin}/api/auth/callback/${OIDC_PROVIDER_ID}`;
}

/**
 * Reads the port the server listens on.
 *
 * @returns `PORT`, or `HTTP_DEFAULTS.port`.
 */
export function port(): number {
  return envPositiveInteger(process.env.PORT, HTTP_DEFAULTS.port);
}

/**
 * Reads where this instance is reached.
 *
 * @returns `APP_URL`, or this server's own origin on `localhost`.
 *
 * @remarks
 * In production the server serves the client itself, so its own origin is the right default,
 * but only for someone browsing from this machine. Set APP_URL to the address users actually
 * type: magic links are built from it, and a link to `localhost` is useless in an inbox.
 */
export function appUrl(): string {
  return configuredAppUrl() ?? `http://localhost:${port()}`;
}

/**
 * Reads `APP_URL` alone, with no fallback.
 *
 * @returns `APP_URL` without a trailing slash, or null when it is unset or empty.
 *
 * @remarks
 * Unset, a request is answered with the origin it came in on (http/origin.ts), which is what
 * the OIDC redirect URI has to be: the provider sends the browser back to exactly that address.
 */
export function configuredAppUrl(): string | null {
  const value = process.env.APP_URL?.trim().replace(/\/+$/, '');
  return value ? value : null;
}
