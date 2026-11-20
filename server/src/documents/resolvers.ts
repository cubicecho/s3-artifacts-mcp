import { type Document, documents } from '@cubicecho/s3-artifacts-mcp-db/schema';
import { resolveSelection, singularizeMapper } from '@vantreeseba/drizzle-graphql';
import { and, eq } from 'drizzle-orm';
import { assertObjectType, extendSchema, type GraphQLResolveInfo, type GraphQLSchema } from 'graphql';
import type { Context } from '../core/context.ts';
import { badInput, ErrorCode, errorMessage, notFound, requireAuth, withCode } from '../core/errors.ts';
import { SecretUnreadableError } from '../core/secrets.ts';
import { parseOrThrow } from '../core/validation.ts';
import { parentIdOf } from '../graphql/parent-id.ts';
import { describeStorageError, type Storage } from '../storage/storage.ts';
import { SECRET_UNREADABLE_MESSAGE } from './bucket-storage.ts';
import { contentPath, signedContentUrl } from './content-url.ts';
import { createPendingDocument, type DocumentUploadInput, titleSchema } from './create.ts';
import { DOCUMENT_NOT_FOUND, findOwnedDocument } from './rows.ts';
import { DOCUMENTS_SDL } from './sdl.ts';

// The owner's documents: starting an upload, renaming and deleting. Reads are the generated
// `documents` / `document` fields, scoped by owner in tenancy.ts. The bytes travel through the
// content routes (upload.ts, download.ts), never through GraphQL.

/** The table's key in the Drizzle schema, which `resolveSelection` names it by. */
const DOCUMENTS_TABLE = 'documents';

/** What `createDocumentUpload` resolves to, before `DocumentUpload.document` reads the row. */
interface DocumentUploadResult {
  documentId: string;
  uploadPath: string;
}

/**
 * Loads one of the caller's documents.
 *
 * @param ctx - The request.
 * @param id - The document's id, as sent.
 * @returns The row.
 * @throws NOT_FOUND when it is malformed, missing or not the caller's.
 */
async function ownDocument(ctx: Context, id: string): Promise<Document> {
  const row = await findOwnedDocument(ctx.db, requireAuth(ctx), id);
  if (row === null) {
    throw notFound(DOCUMENT_NOT_FOUND);
  }
  return row;
}

/**
 * Answers with a document as the client selected it, relations included.
 *
 * @param ctx - The request.
 * @param info - The field's resolve info, whose selection is read.
 * @param id - The document.
 * @returns The row, shaped like a generated read's.
 */
function selectDocument(ctx: Context, info: GraphQLResolveInfo, id: string): Promise<unknown> {
  return resolveSelection(info, {
    db: ctx.db,
    table: DOCUMENTS_TABLE,
    context: ctx,
    typeNameMapper: singularizeMapper,
    where: { id: { eq: id } },
    single: true,
  });
}

/**
 * The storage a document's bytes are in.
 *
 * @param ctx - The request.
 * @param document - The document.
 * @returns Its bucket's storage.
 * @throws BAD_USER_INPUT when the bucket's secret no longer decrypts.
 */
async function documentStorage(ctx: Context, document: Document): Promise<Storage> {
  try {
    return await ctx.storage.get(document.bucketId);
  } catch (error) {
    if (error instanceof SecretUnreadableError) {
      throw badInput(SECRET_UNREADABLE_MESSAGE);
    }
    throw error;
  }
}

/**
 * Adds the document mutations, `DocumentUpload` and `Document.contentUrl` to the schema.
 *
 * @param schema - The schema so far, which must already have a Mutation type and the generated `Document`.
 * @returns The extended schema.
 */
export function applyDocumentsExtension(schema: GraphQLSchema): GraphQLSchema {
  const extended = extendSchema(schema, DOCUMENTS_SDL);
  const mutations = assertObjectType(extended.getType('Mutation')).getFields();
  const documentFields = assertObjectType(extended.getType('Document')).getFields();
  const uploadFields = assertObjectType(extended.getType('DocumentUpload')).getFields();

  documentFields.contentUrl.resolve = async (
    parent: { id?: unknown },
    args: { download?: boolean | null },
    context: Context,
  ) => {
    // Read again rather than trusting the parent: the selection may not include the object key.
    const row = await ownDocument(context, parentIdOf(parent, 'Document.contentUrl'));
    return signedContentUrl(context.secrets, row, args.download ?? false);
  };

  uploadFields.document.resolve = (
    parent: DocumentUploadResult,
    _args: unknown,
    context: Context,
    info: GraphQLResolveInfo,
  ) => selectDocument(context, info, parent.documentId);

  mutations.createDocumentUpload.resolve = async (
    _parent: unknown,
    args: DocumentUploadInput,
    context: Context,
  ): Promise<DocumentUploadResult> => {
    const row = await createPendingDocument(context, args);
    return { documentId: row.id, uploadPath: contentPath(row.id) };
  };

  mutations.renameDocument.resolve = async (
    _parent: unknown,
    args: { id: string; title: string },
    context: Context,
    info: GraphQLResolveInfo,
  ) => {
    const title = parseOrThrow(titleSchema, args.title);
    const row = await ownDocument(context, args.id);
    await context.db
      .update(documents)
      .set({ title })
      .where(and(eq(documents.id, row.id), eq(documents.userId, row.userId)));
    return selectDocument(context, info, row.id);
  };

  mutations.deleteDocument.resolve = async (_parent: unknown, args: { id: string }, context: Context) => {
    const row = await ownDocument(context, args.id);
    const storage = await documentStorage(context, row);
    try {
      // Deleting a key with nothing at it succeeds, so a document whose object is already gone goes quietly.
      await storage.delete([row.objectKey]);
    } catch (error) {
      const { code } = describeStorageError(error);
      console.error(`[documents] could not delete the object of ${row.id}: ${errorMessage(error)}`);
      throw withCode(
        `The bucket refused to delete the file${code === null ? '' : ` (${code})`}. Nothing was deleted.`,
        ErrorCode.StorageError,
        { errorCode: code },
      );
    }
    await context.db.delete(documents).where(and(eq(documents.id, row.id), eq(documents.userId, row.userId)));
    return true;
  };

  return extended;
}
