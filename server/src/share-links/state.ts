// Whether a share link still opens. The bucket decides, not this database: a link works until its signature
// expires, or until the document is re-keyed and its object leaves the key the link was signed for. Revoked wins
// over expired, so a revoked link stays revoked rather than turning "expired" when its time is up.

/** Whether a share link still opens, as far as the server can tell. */
export const ShareLinkState = {
  /** Signed for the document's key, and not yet expired. */
  Active: 'active',
  /** Past its expiry: the bucket refuses the signature. */
  Expired: 'expired',
  /** The document was re-keyed since, so the key it was signed for holds nothing. */
  Revoked: 'revoked',
} as const;
/** One of the states in `ShareLinkState`. */
export type ShareLinkState = (typeof ShareLinkState)[keyof typeof ShareLinkState];

/**
 * A link's state.
 *
 * @param link - The key it was signed for and when it expires.
 * @param documentKey - Where the document's object is now.
 * @param now - The moment asked about.
 * @returns Revoked, expired or active.
 */
export function shareLinkState(
  link: { objectKey: string; expiresAt: Date },
  documentKey: string,
  now: Date,
): ShareLinkState {
  if (link.objectKey !== documentKey) {
    return ShareLinkState.Revoked;
  }
  return link.expiresAt.getTime() <= now.getTime() ? ShareLinkState.Expired : ShareLinkState.Active;
}
