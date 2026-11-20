import { bigint, index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { buckets } from './buckets.ts';
import { users } from './users.ts';

/** Where a document is in its life. */
export const DocumentStatus = {
  /** The row exists and its bytes are on their way. The sweeper drops one left like this too long. */
  PendingUpload: 'pending_upload',
  /** The bytes are in the bucket: uploaded and checked, or found there by a scan. */
  Ready: 'ready',
} as const;
/** One of the states in `DocumentStatus`. */
export type DocumentStatus = (typeof DocumentStatus)[keyof typeof DocumentStatus];

/** The column's enum, over the same words as `DocumentStatus`. */
export const documentStatus = pgEnum('document_status', [DocumentStatus.PendingUpload, DocumentStatus.Ready]);

/**
 * A file in one of the owner's buckets. One uploaded through the app is made `pending_upload` before
 * its bytes exist, and becomes `ready` when the server has streamed them into the bucket and checked
 * them. One that was already in the bucket becomes a document, `ready` at once, when the bucket is
 * scanned (D6, server/src/documents/scan.ts).
 */
export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Restrict: removing a bucket with documents is refused, or forgets them first (deleteBucket).
    bucketId: uuid('bucket_id')
      .notNull()
      .references(() => buckets.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    // As the file was called when it was uploaded, or the last segment of a scanned file's key: what a download saves as.
    filename: text('filename').notNull(),
    // `<objectId>-<sanitized filename>` at the bucket's top level (server/src/documents/keys.ts), or
    // wherever a scanned file already was.
    objectKey: text('object_key').notNull(),
    contentType: text('content_type').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    // Hex. Null until the upload has finished, and for a scanned file, whose bytes the server never read.
    sha256: text('sha256'),
    status: documentStatus('status').notNull().default(DocumentStatus.PendingUpload),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('idx_documents_user_id').on(table.userId),
    // Also the bucket_id foreign key's index: a bucket's ready documents, and whether any point at it.
    index('idx_documents_bucket_id_status').on(table.bucketId, table.status),
    // One document per object: a scan that finds a key already listed skips it, even when two scans race.
    uniqueIndex('uq_documents_bucket_object_key').on(table.bucketId, table.objectKey),
  ],
);

/** A document row as read. */
export type Document = typeof documents.$inferSelect;
/** A document row as inserted. */
export type NewDocument = typeof documents.$inferInsert;
