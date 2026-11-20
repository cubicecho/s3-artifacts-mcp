import type { ColumnDescriber, TableDescriber } from '@vantreeseba/drizzle-graphql';

// Descriptions for the generated types, which drizzle-graphql cannot take from the Drizzle models.
// Keyed by the table's Drizzle key and the column's property name, as `exclude` is.

/** What each generated table's type describes. */
const TABLE_DOCS: Readonly<Record<string, string>> = Object.freeze({
  users: 'A person with an account. Only the caller’s own row is visible.',
  buckets:
    'A bucket on an S3-compatible service, with its own endpoint, region and credentials. Its secret is never returned.',
  documents: 'A file uploaded through the app into one of the owner’s buckets.',
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
    mcpEnabled: 'Whether MCP clients may reach the bucket at its endpoint.',
    mcpWritable: 'Whether MCP clients may upload to the bucket and share from it, not only read.',
  }),
  documents: Object.freeze({
    bucketId: 'The bucket the document’s bytes are in.',
    title: 'What the UI calls the document. It starts as the filename without its extension.',
    filename:
      'The name the file was uploaded as, or the last segment of a scanned file’s key: what a download saves it as.',
    objectKey:
      'Where the bytes are in the bucket: `<objectId>-<safe filename>` at its top level for an upload, or wherever a scanned file already was.',
    contentType: 'The MIME type the document is served as.',
    size: 'The file’s length in bytes.',
    sha256:
      'The SHA-256 of the bytes, in hex. Null until the upload has finished, and for a scanned file, whose bytes were never read.',
    status: '`pending_upload` while its bytes are on their way, `ready` once they are in the bucket.',
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
