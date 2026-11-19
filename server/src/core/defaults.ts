// Every value someone might tune, as plain data. Nothing here computes, reads the environment or imports.

/** Settings for the HTTP door. */
export interface HttpSettings {
  /** Port the server listens on. `PORT` overrides it. */
  port: number;
  /** How long shutdown lets open requests finish before it cuts them. */
  drainSeconds: number;
  /** How long shutdown may take in all before a hard exit. Keep it under Docker's 10 s. */
  shutdownDeadlineSeconds: number;
  /** How long a browser may keep a hashed bundle without asking again. */
  assetCacheDays: number;
  /** Express `trust proxy`: which hops may set X-Forwarded-For. False trusts none. `TRUST_PROXY` overrides it. */
  trustProxy: boolean | number | string;
}

/** The shipped values of `HttpSettings`. */
export const HTTP_DEFAULTS: Readonly<HttpSettings> = Object.freeze({
  port: 3005,
  drainSeconds: 5,
  shutdownDeadlineSeconds: 8,
  assetCacheDays: 365,
  trustProxy: false,
});

/** The sign-in throttle. */
export interface RateLimitSettings {
  /** Attempts allowed per key inside one window. */
  maxAttempts: number;
  /** How long an attempt counts against its key. */
  windowMinutes: number;
  /** Past this many keys, a hit sweeps out the ones whose window has passed. */
  sweepAtKeys: number;
}

/** The shipped values of `RateLimitSettings`. */
export const RATE_LIMIT_DEFAULTS: Readonly<RateLimitSettings> = Object.freeze({
  maxAttempts: 10,
  windowMinutes: 15,
  sweepAtKeys: 10_000,
});

/** Sign-in and credential settings. */
export interface AuthSettings {
  /** How long a sign-in link works. */
  magicLinkTtlMinutes: number;
  /** Shortest signing secret production accepts, in characters. */
  minSecretLength: number;
  /** Whether the network is trusted, so an address alone signs in. `SECURE_LOCAL_NET` overrides it. */
  secureLocalNet: boolean;
  /** Whether the link comes back in the API response outside development. `EXPOSE_MAGIC_LINK` overrides it. */
  exposeMagicLink: boolean;
  /** How long the token an OIDC callback hands the app works: the hop from the callback to `/auth/sso`. */
  oneTimeTokenTtlMinutes: number;
  /** What the login page's OIDC button calls the provider when the setup URL names none. */
  oidcName: string;
  /** How a confidential OIDC client sends its secret, unless the provider registered another. */
  oidcClientAuth: 'client_secret_basic' | 'client_secret_post';
  /** How long pairing waits on the provider before calling it unreachable. */
  oidcPairingTimeoutMs: number;
}

/** The shipped values of `AuthSettings`. */
export const AUTH_DEFAULTS: Readonly<AuthSettings> = Object.freeze({
  magicLinkTtlMinutes: 15,
  minSecretLength: 32,
  secureLocalNet: false,
  exposeMagicLink: false,
  oneTimeTokenTtlMinutes: 3,
  oidcName: 'SSO',
  // heautou's default, and the one the OIDC spec names as the default.
  oidcClientAuth: 'client_secret_basic',
  oidcPairingTimeoutMs: 10_000,
});

/** API keys, which MCP clients send instead of a session. */
export interface ApiKeySettings {
  /** Characters of a key kept after its prefix, so the settings page can tell keys apart. */
  shownCharacters: number;
  /** The longest name a key may be given, in characters. */
  nameMaxLength: number;
}

/** The shipped values of `ApiKeySettings`. */
export const API_KEY_DEFAULTS: Readonly<ApiKeySettings> = Object.freeze({
  shownCharacters: 8,
  nameMaxLength: 60,
});
