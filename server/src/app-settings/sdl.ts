import { parse } from 'graphql';

// The hand-written half of the settings API. The `AppSettings` type and its `appSettings` read are generated from
// the table; the descriptions of its columns are in docs.ts.

/** The SDL `applyAppSettingsExtension` adds to the generated schema. */
export const APP_SETTINGS_SDL = parse(`
  "The bounds the settings are checked against, which no setting can move."
  type AppSettingsLimits {
    "The smallest upload limit that may be set, in bytes."
    minUploadBytes: Float!
    "The largest upload limit that may be set, in bytes."
    maxUploadBytes: Float!
    "The shortest a share link may last, in hours."
    minLinkExpiryHours: Int!
    "The longest a share link may last, in hours: 168 (7 days), SigV4's own limit, so no link outlives it."
    maxLinkExpiryHours: Int!
  }

  "What \`updateAppSettings\` changes. A field left out, or sent as null, keeps its value."
  input AppSettingsInput {
    "The largest file an upload may declare, in bytes, a whole number within \`AppSettingsLimits\`."
    maxUploadBytes: Float
    "How long a new share link lasts when its maker names no expiry, in whole hours within \`AppSettingsLimits\`."
    defaultLinkExpiryHours: Int
    "What a new share link lets its holder do when its maker names nothing."
    defaultLinkPermission: ShareLinkPermission
  }

  extend type Query {
    "The bounds the settings are checked against."
    appSettingsLimits: AppSettingsLimits!
  }

  extend type Mutation {
    """
    Changes the caller's settings and answers them. BAD_USER_INPUT for an upload limit or a default expiry outside
    \`appSettingsLimits\`, or an expiry that is not a whole number of hours.
    """
    updateAppSettings(input: AppSettingsInput!): AppSettings!
  }
`);
