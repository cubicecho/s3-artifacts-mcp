import { buffer } from 'node:stream/consumers';
import {
  type Bucket,
  type Document,
  ShareLinkCreator,
  ShareLinkPermission,
} from '@cubicecho/s3-artifacts-mcp-db/schema';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { describeBytes } from '../app-settings/app-settings.ts';
import { version } from '../core/config.ts';
import type { Context } from '../core/context.ts';
import { DOCUMENT_DEFAULTS, MCP_DEFAULTS, SHARE_LINK_DEFAULTS, TAG_DEFAULTS } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import { bucketStorageFor } from '../documents/bucket-storage.ts';
import { type CreatedShareLink, createShareLink } from '../share-links/create.ts';
import { expiryHoursSchema } from '../share-links/expiry.ts';
import { parseTagNames } from '../tags/names.ts';
import { tagByName } from '../tags/tagging.ts';
import {
  bucketDocumentTags,
  bucketTagCounts,
  currentBucket,
  listBucketDocuments,
  readyBucketDocument,
  requireWritable,
  TagMatch,
} from './access.ts';
import { isInlineBinary, isTextLike } from './content-types.ts';
import { completeUpload, FILE_PLACEHOLDER, startUpload, uploadText } from './uploads.ts';

// The tools one bucket's endpoint offers. The read tools are always there; the write tools only when the bucket is
// `mcp_writable` as the request arrives, and each checks again when it runs. Every tool reads the bucket row afresh
// (access.ts), so switching MCP off or making the bucket read-only holds from the next call. Results are JSON, as
// text and as structured content, so an agent can read the share link's URL straight out of them.

/** The name the MCP server gives for itself. */
export const MCP_SERVER_NAME = 's3-artifacts-mcp';
/** The tools every endpoint offers. */
export const READ_TOOLS = ['list_documents', 'get_document', 'list_tags'] as const;
/** The tools a writable bucket's endpoint offers as well. */
export const WRITE_TOOLS = [
  'upload_document',
  'create_upload',
  'complete_upload',
  'create_share_link',
  'tag_document',
] as const;
/** Spaces a JSON result is indented by, so an agent and a person can both read it. */
const JSON_INDENT = 2;
/** Where an embedded resource says it came from. */
const RESOURCE_SCHEME = 's3a:';

const { pageSize, inlineTextBytes, inlineBinaryBytes, inlineUploadBytes, uploadUrlTtlMinutes } = MCP_DEFAULTS;
const { maxExpiryHours, labelMaxLength } = SHARE_LINK_DEFAULTS;
const { filenameMaxLength, contentTypeMaxLength } = DOCUMENT_DEFAULTS;
const { nameMaxLength, maxTagsPerCall } = TAG_DEFAULTS;

/** What a share link is, for a tool description. */
const LINK_NATURE = 'The link opens straight from the bucket with no sign-in, and cannot be revoked before it expires.';
/** What every write tool that makes a link says: how the agent hands the result on. */
const HAND_OVER = `Give the user \`shareLink.url\` and say when it stops working (\`shareLink.expiresAt\`). ${LINK_NATURE}`;

/** What the tools are handed: the call's context, as the key's owner, and the endpoint's bucket. */
export interface McpDeps {
  /** The call's context. `userId` is the API key's owner, and nothing an agent sends changes it. */
  ctx: Context;
  /** The key's owner. */
  userId: string;
  /** The endpoint's bucket, as it was when the request arrived. Each tool reads it again. */
  bucket: Bucket;
}

/** A tool's answer: the JSON it returns, and any content that goes after it. */
interface ToolAnswer {
  data: Record<string, unknown>;
  more?: ContentBlock[];
}

/** The share link to make along with an upload. Anything left out takes the owner's default. */
const shareSchema = z
  .object({
    permission: z
      .enum([ShareLinkPermission.View, ShareLinkPermission.Download])
      .optional()
      .describe('`view` opens the file in the browser; `download` saves it under its filename'),
    expiresInHours: expiryHoursSchema
      .optional()
      .describe(`Whole hours the link works, at most ${maxExpiryHours} (7 days, the most S3 allows)`),
    label: z.string().max(labelMaxLength).optional().describe('A note the owner sees beside the link'),
  })
  .describe("Also make a share link for the document. Fields left out take the owner's defaults");

/** Tags an agent names. Names are the owner's, matched ignoring case. */
const tagNamesSchema = z.array(z.string().max(nameMaxLength)).max(maxTagsPerCall);

/** Tags to put on a new document. A name the owner has no tag for makes one. */
const newTagsSchema = tagNamesSchema
  .optional()
  .describe('Tags to put on it, by name, ignoring case. One that does not exist yet is made; list_tags names them');

/** What a share link a tool made looks like to the agent. */
type ShareLinkView = Record<string, unknown>;

/**
 * A document as a tool shows it.
 *
 * @param document - The row.
 * @param tags - The names of its tags.
 * @returns Its id, names, type, size, hash, when it was added and its tags.
 */
function documentView(document: Document, tags: readonly string[]): Record<string, unknown> {
  return {
    id: document.id,
    title: document.title,
    filename: document.filename,
    contentType: document.contentType,
    size: document.size,
    sha256: document.sha256,
    createdAt: document.createdAt.toISOString(),
    tags,
  };
}

/**
 * A new share link as a tool shows it.
 *
 * @param link - The row and the URL.
 * @returns Its URL, permission, expiry and label.
 */
function shareLinkView({ row, url }: CreatedShareLink): ShareLinkView {
  return { url, permission: row.permission, expiresAt: row.expiresAt.toISOString(), label: row.label };
}

/**
 * Runs a tool body and answers with what it returned. A failure is a result the model can read, never a transport
 * error.
 *
 * @param body - The tool's work.
 * @returns The result: the JSON as text and as structured content, then any further content.
 */
async function run(body: () => Promise<ToolAnswer>): Promise<CallToolResult> {
  try {
    const { data, more = [] } = await body();
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, JSON_INDENT) }, ...more],
      structuredContent: data,
    };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: errorMessage(error) }] };
  }
}

/**
 * What the server tells an agent about itself when it connects.
 *
 * @param bucket - The endpoint's bucket.
 * @returns The instructions.
 */
function instructionsFor(bucket: Bucket): string {
  const reach = `Files in the owner's bucket "${bucket.name}". Only this bucket is reachable here.`;
  if (bucket.mcpWritable === false) {
    return `${reach} It is shared read-only: list_documents, get_document and list_tags read it.`;
  }
  return (
    `${reach} To hand the user a file you made, store it here and give them a share link. ` +
    'Text you wrote yourself (markdown, HTML, CSV, JSON, code): upload_document with `share`. ' +
    'A file on disk (PDF, image, archive): create_upload, run the curl command it gives, then complete_upload with ' +
    `\`share\`. Either upload takes \`tags\`, by name, to file it; list_tags names the ones in use. ${HAND_OVER}`
  );
}

/**
 * Builds the MCP server for one request to one bucket's endpoint. Stateless: everything lives in Postgres and the
 * bucket, so a server per request costs only the tool list.
 *
 * @param deps - The call's context, the key's owner and the endpoint's bucket.
 * @returns The server, with its tools registered.
 */
export function createMcpServer({ ctx, userId, bucket }: McpDeps): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: version() },
    { instructions: instructionsFor(bucket) },
  );
  /** The bucket as it is now. */
  const reread = () => currentBucket(ctx.db, userId, bucket.id);
  /** The bucket as it is now, refusing when it is read-only. */
  const writable = async (): Promise<Bucket> => {
    const now = await reread();
    requireWritable(now);
    return now;
  };
  /** A document as a tool shows it, with its tags as they are now. */
  const view = async (now: Bucket, document: Document): Promise<Record<string, unknown>> => {
    const tags = await bucketDocumentTags(ctx.db, now, [document.id]);
    return documentView(document, tags.get(document.id) ?? []);
  };
  /** Puts the tags an upload named on its new document. */
  const tagNew = async (document: Document, names: readonly string[]): Promise<void> => {
    if (names.length > 0) {
      await tagByName(ctx.db, userId, document.id, { add: names });
    }
  };
  /** Makes the share link an upload asked for, if it asked for one. */
  const shareIfAsked = async (
    document: Document,
    share: z.infer<typeof shareSchema> | undefined,
  ): Promise<Record<string, unknown>> => {
    if (share === undefined) {
      return {};
    }
    const link = await createShareLink(ctx, { documentId: document.id, ...share }, ShareLinkCreator.Mcp);
    return { shareLink: shareLinkView(link) };
  };

  server.registerTool(
    'list_documents',
    {
      title: 'List documents',
      description: `The documents in this bucket, newest first, ${pageSize} at most a call: id, title, filename, type, size, when each was added and its tags. When there are more, \`nextCursor\` is set: pass it as \`cursor\` for the next page.`,
      inputSchema: {
        title: z.string().trim().min(1).optional().describe('Only titles containing this, ignoring case'),
        contentType: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Only types starting with this, ignoring case: `image/` for every image, `application/pdf`'),
        tags: tagNamesSchema
          .optional()
          .describe('Only documents with these tags, by name, ignoring case. `match` says whether any or all'),
        match: z
          .enum([TagMatch.Any, TagMatch.All])
          .default(TagMatch.Any)
          .describe('`any` (the default): a document with at least one of `tags`. `all`: only one with every one'),
        limit: z.number().int().min(1).max(pageSize).default(pageSize),
        cursor: z.string().optional().describe('`nextCursor` from the page before'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        const now = await reread();
        const page = await listBucketDocuments(ctx.db, now, { ...args, tags: parseTagNames(args.tags ?? []) });
        const tags = await bucketDocumentTags(
          ctx.db,
          now,
          page.documents.map((document) => document.id),
        );
        const listed = page.documents.map((document) => documentView(document, tags.get(document.id) ?? []));
        return { data: { documents: listed, nextCursor: page.nextCursor } };
      }),
  );

  server.registerTool(
    'get_document',
    {
      title: 'Read a document',
      description: `One document's details, then its content: text up to ${describeBytes(inlineTextBytes)} as text, an image or PDF up to ${describeBytes(inlineBinaryBytes)} as an embedded resource. Anything larger or of another type comes back as its details and a note.`,
      inputSchema: { id: z.string().describe('The document id, from list_documents') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ id }) =>
      run(async () => {
        const now = await reread();
        const document = await readyBucketDocument(ctx.db, now, id);
        const details = await view(now, document);
        const isText = isTextLike(document.contentType) && document.size <= inlineTextBytes;
        const isBinary = isInlineBinary(document.contentType) && document.size <= inlineBinaryBytes;
        if (isText === false && isBinary === false) {
          return { data: { document: details, note: tooLargeNote(document) } };
        }
        const storage = await bucketStorageFor(ctx, now.id);
        const bytes = await buffer(await storage.getStream(document.objectKey));
        if (isText) {
          return { data: { document: details }, more: [{ type: 'text', text: bytes.toString('utf8') }] };
        }
        const uri = `${RESOURCE_SCHEME}//${now.slug}/${document.id}`;
        const resource = { uri, mimeType: document.contentType, blob: bytes.toString('base64') };
        return { data: { document: details }, more: [{ type: 'resource', resource }] };
      }),
  );

  server.registerTool(
    'list_tags',
    {
      title: 'List tags',
      description:
        "The tags in use in this bucket, and the owner's unused ones, by name, with each one's colour and how many documents in this bucket carry it. A name matches ignoring case.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      run(async () => {
        return { data: { tags: await bucketTagCounts(ctx.db, await reread()) } };
      }),
  );

  if (bucket.mcpWritable === false) {
    return server;
  }

  server.registerTool(
    'upload_document',
    {
      title: 'Upload text as a document',
      description: `Stores text you wrote (markdown, HTML, CSV, JSON, code) as a new document, up to ${describeBytes(inlineUploadBytes)} of UTF-8, and with \`share\` makes a share link for it in the same call. A text type with no charset is stored with \`charset=utf-8\`. For a file on disk, or anything binary, use create_upload. ${HAND_OVER}`,
      inputSchema: {
        filename: z
          .string()
          .max(filenameMaxLength)
          .describe('What the file is called, with its extension: `report.md`'),
        contentType: z.string().max(contentTypeMaxLength).describe('Its MIME type: `text/markdown`, `text/html`'),
        text: z.string().describe('The whole file'),
        tags: newTagsSchema,
        share: shareSchema.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ share, tags = [], ...upload }) =>
      run(async () => {
        const names = parseTagNames(tags);
        const now = await writable();
        const document = await uploadText(ctx, now, upload);
        await tagNew(document, names);
        return { data: { document: await view(now, document), ...(await shareIfAsked(document, share)) } };
      }),
  );

  server.registerTool(
    'create_upload',
    {
      title: 'Start a file upload',
      description: `Starts uploading a file from your disk (a PDF, image, archive; anything binary or large): it answers with \`uploadUrl\`, a presigned PUT straight to the bucket that works for ${uploadUrlTtlMinutes} minutes, and \`curl\`, the command that sends the file to it. Replace ${FILE_PLACEHOLDER} with the file's path and run it, then call complete_upload with \`documentId\`. The PUT must send exactly \`headers\` and \`size\` bytes. Pass \`share\` to complete_upload, then give the user \`shareLink.url\` and say when it stops working (\`shareLink.expiresAt\`). ${LINK_NATURE}`,
      inputSchema: {
        filename: z
          .string()
          .max(filenameMaxLength)
          .describe('What the file is called, with its extension: `chart.png`'),
        contentType: z.string().max(contentTypeMaxLength).describe('Its MIME type: `application/pdf`, `image/png`'),
        size: z.number().int().positive().describe("The file's exact length in bytes"),
        tags: newTagsSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ tags = [], ...upload }) =>
      run(async () => {
        const names = parseTagNames(tags);
        const started = await startUpload(ctx, await writable(), upload);
        await tagNew(started.document, names);
        return {
          data: {
            documentId: started.document.id,
            uploadUrl: started.uploadUrl,
            expiresAt: started.expiresAt.toISOString(),
            headers: started.headers,
            curl: started.curl,
          },
        };
      }),
  );

  server.registerTool(
    'complete_upload',
    {
      title: 'Finish a file upload',
      description: `Finishes an upload once its file has been sent to the URL create_upload gave: the bucket's copy is checked against the size declared and hashed, and the document is ready. With \`share\` it also makes a share link. Calling it again on a finished upload answers the document again. ${HAND_OVER}`,
      inputSchema: {
        documentId: z.string().describe('`documentId` from create_upload'),
        share: shareSchema.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ documentId, share }) =>
      run(async () => {
        const now = await writable();
        const document = await completeUpload(ctx, now, documentId);
        return { data: { document: await view(now, document), ...(await shareIfAsked(document, share)) } };
      }),
  );

  server.registerTool(
    'create_share_link',
    {
      title: 'Share a document',
      description: `Makes a share link for a document already in the bucket. Fields left out take the owner's defaults. ${HAND_OVER}`,
      inputSchema: { id: z.string().describe('The document id, from list_documents'), ...shareSchema.shape },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ id, ...share }) =>
      run(async () => {
        const now = await writable();
        const document = await readyBucketDocument(ctx.db, now, id);
        return { data: { document: await view(now, document), ...(await shareIfAsked(document, share)) } };
      }),
  );

  server.registerTool(
    'tag_document',
    {
      title: 'Tag a document',
      description:
        'Puts tags on a document in this bucket and takes tags off it, by name, ignoring case. A name in `add` the owner has no tag for makes one; a name in `remove` that is not on it is no matter. Answers the document with its tags.',
      inputSchema: {
        id: z.string().describe('The document id, from list_documents'),
        add: tagNamesSchema.optional().describe('Tags to put on it'),
        remove: tagNamesSchema.optional().describe('Tags to take off it'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ id, add = [], remove = [] }) =>
      run(async () => {
        const names = { add: parseTagNames(add), remove: parseTagNames(remove) };
        const now = await writable();
        const document = await readyBucketDocument(ctx.db, now, id);
        await tagByName(ctx.db, userId, document.id, names);
        return { data: { document: await view(now, document) } };
      }),
  );

  return server;
}

/**
 * Why `get_document` returned no content.
 *
 * @param document - The document.
 * @returns The note.
 */
function tooLargeNote(document: Document): string {
  const isText = isTextLike(document.contentType);
  if (isText) {
    return `It is ${describeBytes(document.size)}, past the ${describeBytes(inlineTextBytes)} returned inline.`;
  }
  if (isInlineBinary(document.contentType)) {
    return `It is ${describeBytes(document.size)}, past the ${describeBytes(inlineBinaryBytes)} returned inline.`;
  }
  return `A ${document.contentType} file is not returned inline; only text, images and PDFs are.`;
}
