import type { ColumnDescriber, TableDescriber } from '@vantreeseba/drizzle-graphql';

// Descriptions for the generated types, which drizzle-graphql cannot take from the Drizzle models.
// Keyed by the table's Drizzle key and the column's property name, as `exclude` is.

/** What each generated table's type describes. */
const TABLE_DOCS: Readonly<Record<string, string>> = Object.freeze({
  users: 'A person with an account. Only the caller’s own row is visible.',
  buckets:
    'A bucket on an S3-compatible service, with its own endpoint, region and credentials. Its secret is never returned.',
});

/** What each generated column field holds. */
const COLUMN_DOCS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  buckets: Object.freeze({
    slug: 'Names the bucket’s MCP endpoint, `/mcp/b/<slug>`. Unique on the instance.',
    name: 'What the UI calls the bucket.',
    provider: 'Which preset the bucket was set up from. It decides nothing after that.',
    endpoint: 'The address the server reaches the service at. Null on AWS means the regional default.',
    publicEndpoint: 'The address share links are signed for, as browsers reach the service. Null means `endpoint`.',
    region: 'The region requests are signed for.',
    bucket: 'The bucket’s name at the provider.',
    accessKeyId: 'The access key the server signs with. Its secret is stored encrypted and never returned.',
    forcePathStyle: 'Whether the bucket is addressed in the path (`host/bucket/key`) rather than the host.',
    isDefault: 'Whether uploads that name no bucket go here. At most one bucket is the default.',
    mcpEnabled: 'Whether MCP clients may reach the bucket at its endpoint.',
    mcpWritable: 'Whether MCP clients may upload to the bucket and share from it, not only read.',
  }),
});

/**
 * Describes a generated table's type.
 *
 * @param tableName - The table's Drizzle key.
 * @returns Its description, or undefined for none.
 */
export const describeTable: TableDescriber = (tableName) => TABLE_DOCS[tableName];

/**
 * Describes a generated column field.
 *
 * @param _column - The Drizzle column, unused: descriptions are looked up by name.
 * @param info - The table's Drizzle key and the column's property name.
 * @returns Its description, or undefined for none.
 */
export const describeColumn: ColumnDescriber = (_column, { tableName, columnName }) =>
  COLUMN_DOCS[tableName]?.[columnName];
