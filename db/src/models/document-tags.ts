import { index, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { documents } from './documents.ts';
import { tags } from './tags.ts';
import { users } from './users.ts';

/**
 * A tag on a document. Deleting either removes the link, so deleting a tag takes it off every document. `user_id`
 * is the owner's, as on every table, so the link is scoped like the rows it joins.
 */
export const documentTags = pgTable(
  'document_tags',
  {
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Also the document_id foreign key's index: a document's tags.
    primaryKey({ columns: [table.documentId, table.tagId] }),
    // A tag's documents, and what a tag's delete cascades through.
    index('idx_document_tags_tag_id').on(table.tagId),
    index('idx_document_tags_user_id').on(table.userId),
  ],
);

/** A document's tag link as read. */
export type DocumentTag = typeof documentTags.$inferSelect;
/** A document's tag link as inserted. */
export type NewDocumentTag = typeof documentTags.$inferInsert;
