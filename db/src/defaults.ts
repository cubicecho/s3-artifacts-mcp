// Every value someone might tune, as plain data. Nothing here computes, reads the environment or imports.

/** Settings for reaching and leaving Postgres. */
export interface DatabaseSettings {
  /** How long boot waits for Postgres before giving up. `DB_CONNECT_TIMEOUT_MS` overrides it. */
  connectTimeoutMs: number;
  /** The wait before the first retry. */
  firstRetryDelayMs: number;
  /** The longest wait between two retries. */
  maxRetryDelayMs: number;
  /** How much the wait grows after each failed attempt. */
  retryBackoffFactor: number;
  /** How long running queries get at shutdown before they are cancelled. */
  closeTimeoutSeconds: number;
}

/** The shipped values of `DatabaseSettings`. */
export const DATABASE_DEFAULTS: Readonly<DatabaseSettings> = Object.freeze({
  connectTimeoutMs: 60_000,
  firstRetryDelayMs: 500,
  maxRetryDelayMs: 5_000,
  retryBackoffFactor: 2,
  closeTimeoutSeconds: 5,
});

/** What a new instance's settings start as: the `app_settings` row the owner changes in Settings → General. */
export interface AppSettingsSettings {
  /** The largest file an upload may declare, in bytes. The server bounds it by `UPLOAD_DEFAULTS.maxUploadBytes`. */
  maxUploadBytes: number;
  /** How long a share link works when its maker names no expiry, in hours. */
  defaultLinkExpiryHours: number;
  /** What a share link lets its holder do when its maker names nothing. */
  defaultLinkPermission: 'view' | 'download';
}

/** The shipped values of `AppSettingsSettings`: the columns' defaults. */
export const APP_SETTINGS_DEFAULTS: Readonly<AppSettingsSettings> = Object.freeze({
  maxUploadBytes: 104_857_600,
  defaultLinkExpiryHours: 24,
  defaultLinkPermission: 'download',
});
