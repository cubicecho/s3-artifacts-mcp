/**
 * The numbers this app could reasonably have chosen differently, in one place.
 *
 * Each group is a frozen value typed by the interface above it, so a component reads a name and a
 * unit rather than a literal. Nothing here is computed and nothing is imported.
 */

/** How the upload panel sends files. */
export interface UploadSettings {
  /**
   * How many files are sent at once. The rest wait their turn, so a dropped folder of five
   * hundred files does not open five hundred requests to the server.
   */
  concurrency: number;
}

/** What the upload panel sends with. */
export const UPLOAD_DEFAULTS: Readonly<UploadSettings> = Object.freeze({
  concurrency: 3,
});

/** What the share dialog offers. */
export interface ShareLinkSettings {
  /**
   * The expiries offered as one press, in hours, drawn in this order. Those past the server's `maxLinkExpiryHours`
   * are not drawn; anything else is a custom amount.
   */
  expiryPresetHours: Readonly<Record<string, number>>;
}

/** What the share dialog and Settings → General offer. */
export const SHARE_LINK_DEFAULTS: Readonly<ShareLinkSettings> = Object.freeze({
  expiryPresetHours: Object.freeze({ oneHour: 1, oneDay: 24, threeDays: 72, sevenDays: 168 }),
});

/** How much of a document the document page draws in place. */
export interface PreviewSettings {
  /**
   * The largest text, Markdown, JSON or CSV file the page fetches to show. Past it the page
   * offers the download instead: a 50 MB log drawn into the page freezes the tab.
   */
  maxTextBytes: number;
}

/** What the document page previews. */
export const PREVIEW_DEFAULTS: Readonly<PreviewSettings> = Object.freeze({
  maxTextBytes: 1_048_576,
});

/** What a new tag starts as in the tag form. */
export interface TagSettings {
  /** The colour a new tag's form opens on, as `#rrggbb`. A tag made from the picker gets one picked by the server. */
  newTagColor: string;
}

/** What the tag form opens on. */
export const TAG_DEFAULTS: Readonly<TagSettings> = Object.freeze({
  newTagColor: '#3b82f6',
});
