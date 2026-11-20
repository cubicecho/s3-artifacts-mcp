import { index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { documents } from './documents.ts';
import { users } from './users.ts';

/** What a share link lets whoever holds it do. Either way they can save the bytes: `view` is not copy protection. */
export const ShareLinkPermission = {
  /** The bucket answers `inline`, so a browser shows the file. */
  View: 'view',
  /** The bucket answers `attachment` with the filename, so a browser saves it. */
  Download: 'download',
} as const;
/** One of the permissions in `ShareLinkPermission`. */
export type ShareLinkPermission = (typeof ShareLinkPermission)[keyof typeof ShareLinkPermission];

/** Who made a share link. */
export const ShareLinkCreator = {
  /** The owner, in the app. */
  Owner: 'owner',
  /** An MCP client, with one of the owner's API keys. */
  Mcp: 'mcp',
} as const;
/** One of the makers in `ShareLinkCreator`. */
export type ShareLinkCreator = (typeof ShareLinkCreator)[keyof typeof ShareLinkCreator];

/** The column's enum, over the same words as `ShareLinkPermission`. */
export const shareLinkPermission = pgEnum('share_link_permission', [
  ShareLinkPermission.View,
  ShareLinkPermission.Download,
]);
/** The column's enum, over the same words as `ShareLinkCreator`. */
export const shareLinkCreator = pgEnum('share_link_creator', [ShareLinkCreator.Owner, ShareLinkCreator.Mcp]);

/**
 * A presigned GET for a document, signed on its bucket's public endpoint (D5). The bucket checks the signature,
 * not this row, so deleting the row does not stop the URL: it works until `expires_at`, or until the document is
 * re-keyed, which moves the object away from the `object_key` it was signed for. `url_enc` is the URL sealed by
 * server/src/core/secrets.ts, since anyone holding it can read the file, and is kept out of the GraphQL schema.
 */
export const shareLinks = pgTable(
  'share_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    label: text('label'),
    permission: shareLinkPermission('permission').notNull(),
    urlEnc: text('url_enc').notNull(),
    // The key the URL was signed for. Once the document's own key differs, the link is revoked.
    objectKey: text('object_key').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdBy: shareLinkCreator('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_share_links_user_id').on(table.userId),
    index('idx_share_links_document_id').on(table.documentId),
  ],
);

/** A share link row as read, sealed URL included. */
export type ShareLink = typeof shareLinks.$inferSelect;
/** A share link row as inserted. */
export type NewShareLink = typeof shareLinks.$inferInsert;
