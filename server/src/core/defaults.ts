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

/** Buckets: how they are tested and how many clients are kept built. */
export interface BucketSettings {
  /** The object a connection test writes, reads back and deletes. */
  probeKey: string;
  /** How long a whole connection test may take before the steps left are skipped. */
  testTimeoutMs: number;
  /** How long the test waits on a share link to the probe, within `testTimeoutMs`, so the probe can still be deleted after. */
  shareLinkTimeoutMs: number;
  /** How many buckets' S3 clients the storage registry keeps built before dropping the least recently used. */
  clientCacheSize: number;
  /** The longest name a bucket may be given, in characters. */
  nameMaxLength: number;
  /** The longest slug a bucket may have, in characters. */
  slugMaxLength: number;
  /** How long a presigned GET made by the connection test stays valid. */
  probeLinkTtlSeconds: number;
}

/** The shipped values of `BucketSettings`. */
export const BUCKET_DEFAULTS: Readonly<BucketSettings> = Object.freeze({
  probeKey: '.s3-artifacts-mcp-probe',
  testTimeoutMs: 10_000,
  shareLinkTimeoutMs: 4000,
  clientCacheSize: 32,
  nameMaxLength: 80,
  slugMaxLength: 48,
  probeLinkTtlSeconds: 60,
});

/** Uploads into a bucket through the server (`PUT /api/documents/:id/content`), and the rows waiting on one. */
export interface UploadSettings {
  /**
   * The largest upload limit the owner may set in Settings → General, in bytes: the bound `app_settings.max_upload_bytes`
   * is checked against. lib-storage sends at most 10,000 parts of `partSizeBytes` (8 MiB), about 78 GiB, so 50 GiB
   * leaves room. Raising it past that means raising `partSizeBytes` too.
   */
  maxUploadBytes: number;
  /** The smallest upload limit the owner may set, in bytes. */
  minUploadBytes: number;
  /**
   * How many files the app sends at once. The app keeps its own copy of this number (it cannot import the
   * server's); this is the documented value the two agree on.
   */
  concurrency: number;
  /** How long a `pending_upload` row may wait for its bytes before the sweeper drops it. */
  pendingTtlMinutes: number;
  /** How often the sweeper looks for such rows. */
  sweepIntervalMinutes: number;
  /** The size of each part of a multipart upload, in bytes. S3's minimum is 5 MiB. */
  partSizeBytes: number;
  /** How many parts of one upload are in flight at once. One upload buffers up to this many parts in memory. */
  partQueueSize: number;
}

/** The shipped values of `UploadSettings`. */
export const UPLOAD_DEFAULTS: Readonly<UploadSettings> = Object.freeze({
  maxUploadBytes: 53_687_091_200,
  minUploadBytes: 1_048_576,
  concurrency: 3,
  pendingTtlMinutes: 60,
  sweepIntervalMinutes: 10,
  partSizeBytes: 8_388_608,
  partQueueSize: 4,
});

/** Copying an object to another key in its bucket, as `rekeyDocument` does. */
export interface CopySettings {
  /** The largest object one CopyObject call copies, in bytes: S3's own limit is 5 GiB. Past it a copy goes in parts. */
  maxSingleCopyBytes: number;
  /** The size of each part of a copy in parts, in bytes. 50 GiB is 100 of them; S3 takes 5 MiB to 5 GiB a part. */
  copyPartSizeBytes: number;
  /** How many parts of one copy run at once. */
  copyPartQueueSize: number;
}

/** The shipped values of `CopySettings`. */
export const COPY_DEFAULTS: Readonly<CopySettings> = Object.freeze({
  maxSingleCopyBytes: 5_368_709_120,
  copyPartSizeBytes: 536_870_912,
  copyPartQueueSize: 4,
});

/** Share links: presigned GETs on a bucket's public endpoint (D5). */
export interface ShareLinkSettings {
  /** The shortest a share link may last, in hours. */
  minExpiryHours: number;
  /** The longest a share link may last, in hours: SigV4's limit of 7 days, on AWS, MinIO and RustFS alike. */
  maxExpiryHours: number;
  /** The longest label a share link may be given, in characters. */
  labelMaxLength: number;
}

/** The shipped values of `ShareLinkSettings`. */
export const SHARE_LINK_DEFAULTS: Readonly<ShareLinkSettings> = Object.freeze({
  minExpiryHours: 1,
  maxExpiryHours: 168,
  labelMaxLength: 100,
});

/** What a document may hold. */
export interface DocumentSettings {
  /** The longest title, in characters. */
  titleMaxLength: number;
  /** The longest filename an upload may give, in characters. */
  filenameMaxLength: number;
  /** The longest filename part of an object key, in characters, after it is made safe. The extension is kept. */
  keyFilenameMaxLength: number;
  /** The longest content type an upload may declare, in characters. */
  contentTypeMaxLength: number;
}

/** The shipped values of `DocumentSettings`. */
export const DOCUMENT_DEFAULTS: Readonly<DocumentSettings> = Object.freeze({
  titleMaxLength: 200,
  filenameMaxLength: 255,
  keyFilenameMaxLength: 120,
  contentTypeMaxLength: 255,
});

/** Scanning a bucket for files already in it (`scanBucket`). */
export interface ScanSettings {
  /**
   * The most files one scan adds. A scan that reaches it stops and says so; scanning again carries on, since what
   * was added is skipped the second time.
   */
  maxImports: number;
  /** How many of the files a scan could not add it names, with why. The rest are only counted. */
  skippedReported: number;
}

/** The shipped values of `ScanSettings`. */
export const SCAN_DEFAULTS: Readonly<ScanSettings> = Object.freeze({
  maxImports: 5000,
  skippedReported: 20,
});

/** Reading a document's bytes through the server (`GET /api/documents/:id/content`). */
export interface ContentSettings {
  /** How long a signed content URL (`Document.contentUrl`) works, for elements that cannot send a session. */
  urlTtlMinutes: number;
}

/** The shipped values of `ContentSettings`. */
export const CONTENT_DEFAULTS: Readonly<ContentSettings> = Object.freeze({
  urlTtlMinutes: 15,
});
