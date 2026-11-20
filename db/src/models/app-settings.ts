import { bigint, integer, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { APP_SETTINGS_DEFAULTS } from '../defaults.ts';
import { shareLinkPermission } from './share-links.ts';
import { users } from './users.ts';

/**
 * The values the owner may change in Settings → General: one row per user, keyed by `user_id`, made when the
 * account is (server/src/settings/app-settings.ts). With one owner that is the instance's single row, but it is
 * scoped by `user_id` like every other table, so more accounts later is additive. The server checks each value
 * against a bound in `core/defaults.ts` before it is saved.
 */
export const appSettings = pgTable('app_settings', {
  // Also the user_id foreign key's index.
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  maxUploadBytes: bigint('max_upload_bytes', { mode: 'number' })
    .notNull()
    .default(APP_SETTINGS_DEFAULTS.maxUploadBytes),
  defaultLinkExpiryHours: integer('default_link_expiry_hours')
    .notNull()
    .default(APP_SETTINGS_DEFAULTS.defaultLinkExpiryHours),
  defaultLinkPermission: shareLinkPermission('default_link_permission')
    .notNull()
    .default(APP_SETTINGS_DEFAULTS.defaultLinkPermission),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** A settings row as read. */
export type AppSettings = typeof appSettings.$inferSelect;
