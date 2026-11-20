import { parse } from 'graphql';
import { SHARE_LINK_DEFAULTS } from '../core/defaults.ts';

const { minExpiryHours, maxExpiryHours, labelMaxLength } = SHARE_LINK_DEFAULTS;

// The hand-written half of the share-links API. The `ShareLink` type and the `shareLinks` / `shareLink` reads are
// generated from the table, without its sealed URL; the descriptions of its columns are in docs.ts.

/** The SDL `applyShareLinksExtension` adds to the generated schema. */
export const SHARE_LINKS_SDL = parse(`
  "Whether a share link still opens, as far as the server can tell."
  enum ShareLinkState {
    "Signed for the document's key, and not yet expired."
    active
    "Past its expiry: the bucket refuses it."
    expired
    "The document was re-keyed (\`rekeyDocument\`) since, so the key it was signed for holds nothing."
    revoked
  }

  extend type ShareLink {
    """
    The presigned URL, which opens the file for anyone who holds it, with no other credential, until it expires.
    Null when it can no longer be decrypted because \`BETTER_AUTH_SECRET\` changed; the URL itself still works.
    Select \`id\` beside it.
    """
    url: String
    "Active, expired or revoked. Revoked wins over expired. Select \`id\` beside it."
    state: ShareLinkState!
  }

  extend type Mutation {
    """
    Makes a share link for one of the caller's ready documents: a GET presigned on its bucket's public endpoint, so
    the recipient fetches the file from the bucket, not this app. \`view\` asks the browser to show it inline and
    \`download\` to save it under its filename; neither stops a recipient keeping a copy. \`expiresInHours\` is a
    whole number from ${minExpiryHours} to ${maxExpiryHours} (7 days, the most S3 signs for). A permission or expiry left out takes the default
    from \`appSettings\`. A link cannot be revoked alone before it expires: \`rekeyDocument\` revokes them all.
    NOT_FOUND for a document that is missing or someone else's; CONFLICT for one still uploading; BAD_USER_INPUT
    for an expiry out of range, a label over ${labelMaxLength} characters, or a bucket whose secret can no longer be decrypted;
    STORAGE_ERROR when the URL cannot be signed.
    """
    createShareLink(
      documentId: UUID!
      permission: ShareLinkPermission
      expiresInHours: Int
      label: String
    ): ShareLink!
    """
    Removes a share link from the list. The URL keeps working until it expires, since the bucket checks the
    signature and not this list; \`rekeyDocument\` is what stops it. NOT_FOUND for a link that is missing or
    someone else's.
    """
    deleteShareLink(id: UUID!): Boolean!
  }
`);
