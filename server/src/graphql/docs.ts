import type { ColumnDescriber, TableDescriber } from '@vantreeseba/drizzle-graphql';

// Descriptions for the generated types, which drizzle-graphql cannot take from the Drizzle models.
// Keyed by the table's Drizzle key and the column's property name, as `exclude` is.

/** What each generated table's type describes. */
const TABLE_DOCS: Readonly<Record<string, string>> = Object.freeze({
  users: 'A person with an account. Only the caller’s own row is visible.',
  buckets:
    'A bucket on an S3-compatible service, with its own endpoint, region and credentials. Its secret is never returned.',
  documents: 'A file uploaded through the app into one of the owner’s buckets.',
  shareLinks:
    'A presigned URL for a document, signed on its bucket’s public endpoint. It works until it expires or the document is re-keyed, whatever this list says.',
  appSettings: 'What the owner set in Settings → General. Each value is checked against `appSettingsLimits`.',
  tags: 'One of the owner’s tags, which is how documents are organised. A name is unique to its owner, ignoring case.',
  documentTags: 'A tag on a document. Deleting the tag or the document removes it.',
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
  shareLinks: Object.freeze({
    documentId: 'The document the link opens.',
    label: 'What the owner called the link, to tell it apart. Null for none.',
    permission: '`view` asks the browser to show the file, `download` to save it. Neither stops a copy being kept.',
    objectKey: 'The key the link was signed for. Once the document’s own key differs, the link is revoked.',
    expiresAt: 'When the bucket stops accepting the link: at most 7 days after it was made.',
    createdBy: '`owner` for a link made in the app, `mcp` for one an MCP client made.',
  }),
  tags: Object.freeze({
    name: 'What the tag is called: trimmed, and unique to its owner ignoring case.',
    color: 'The tag’s colour, as `#rrggbb`.',
  }),
  documentTags: Object.freeze({
    documentId: 'The document the tag is on.',
    tagId: 'The tag.',
  }),
  appSettings: Object.freeze({
    maxUploadBytes: 'The largest file an upload may declare, in bytes.',
    defaultLinkExpiryHours: 'How long a new share link lasts when its maker names no expiry, in hours.',
    defaultLinkPermission: 'What a new share link lets its holder do when its maker names nothing.',
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
