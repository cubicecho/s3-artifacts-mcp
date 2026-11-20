import { sql } from 'drizzle-orm';
import { boolean, index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.ts';

/**
 * Which kind of S3-compatible service a bucket is on. It only chooses the form's preset
 * (server/src/buckets/presets.ts): every field it fills can be overridden, and nothing is keyed
 * by it, so two buckets on one provider are as independent as two on different ones.
 */
export const bucketProvider = pgEnum('bucket_provider', ['s3', 'minio', 'rustfs', 'b2']);

/**
 * A bucket the owner added in Settings. Each row carries its own endpoint, region and
 * credentials, so buckets on different accounts and providers sit side by side.
 * `secret_access_key_enc` is sealed by server/src/core/secrets.ts and is kept out of the
 * GraphQL schema.
 */
export const buckets = pgTable(
  'buckets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Names the bucket's MCP endpoint (`/mcp/b/:slug`), so it is unique across the instance.
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    provider: bucketProvider('provider').notNull(),
    // What the server talks to. Null on AWS means the regional default.
    endpoint: text('endpoint'),
    // What share links are signed for. Null means `endpoint`.
    publicEndpoint: text('public_endpoint'),
    region: text('region').notNull(),
    bucket: text('bucket').notNull(),
    accessKeyId: text('access_key_id').notNull(),
    secretAccessKeyEnc: text('secret_access_key_enc').notNull(),
    forcePathStyle: boolean('force_path_style').notNull().default(false),
    isDefault: boolean('is_default').notNull().default(false),
    mcpEnabled: boolean('mcp_enabled').notNull().default(false),
    mcpWritable: boolean('mcp_writable').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_buckets_slug').on(table.slug),
    // At most one default per owner: the bucket an upload goes to when it names none.
    uniqueIndex('uq_buckets_default').on(table.userId).where(sql`${table.isDefault}`),
    index('idx_buckets_user_id').on(table.userId),
  ],
);

/** A bucket row as read, sealed secret included. */
export type Bucket = typeof buckets.$inferSelect;
/** A bucket row as inserted. */
export type NewBucket = typeof buckets.$inferInsert;
/** One of the providers a bucket can be on. */
export type BucketProvider = (typeof bucketProvider.enumValues)[number];
