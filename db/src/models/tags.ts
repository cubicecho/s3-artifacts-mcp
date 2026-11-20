import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.ts';

/**
 * One of the owner's tags (D8), which is how documents are organised: there are no folders (D11). Tags live here,
 * never as S3 object tags. A name is unique to its owner ignoring case, so "Invoices" and "invoices" are one tag;
 * the rules a name is checked against are in server/src/tags/names.ts.
 */
export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Trimmed, as the owner typed it. Compared ignoring case.
    name: text('name').notNull(),
    // `#rrggbb`. The app draws it through its colour helpers, so it shows in every theme.
    color: text('color').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Also the user_id foreign key's index. Two saves racing for one name, in any case, cannot both land.
    uniqueIndex('uq_tags_user_name').on(table.userId, sql`lower(${table.name})`),
  ],
);

/** A tag row as read. */
export type Tag = typeof tags.$inferSelect;
/** A tag row as inserted. */
export type NewTag = typeof tags.$inferInsert;
