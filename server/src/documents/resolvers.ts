import { documents } from '@cubicecho/s3-artifacts-mcp-db/schema';
import { resolveSelection } from '@vantreeseba/drizzle-graphql';
import { and, eq } from 'drizzle-orm';
import { assertObjectType, extendSchema, type GraphQLResolveInfo, type GraphQLSchema } from 'graphql';
import type { Context } from '../core/context.ts';
import { ErrorCode, errorMessage, withCode } from '../core/errors.ts';
import { parseOrThrow } from '../core/validation.ts';
import { typeNames } from '../graphql/naming.ts';
import { parentIdOf } from '../graphql/parent-id.ts';
import { describeStorageError } from '../storage/storage.ts';
import { bucketStorageFor } from './bucket-storage.ts';
import { contentPath, signedContentUrl } from './content-url.ts';
import { createPendingDocument, type DocumentUploadInput, titleSchema } from './create.ts';
import { rekeyDocument } from './rekey.ts';
import { ownDocument } from './rows.ts';
import { scanBucket } from './scan.ts';
import { DOCUMENTS_SDL } from './sdl.ts';

// The owner's documents: starting an upload, scanning a bucket for files already in it, renaming, deleting, and
// re-keying to revoke its share links (rekey.ts). Reads are the generated
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
    typeNameMapper: typeNames,
    where: { id: { eq: id } },
    single: true,
  });
}

/**
 * Adds the document mutations, `DocumentUpload`, `BucketScan` and `Document.contentUrl` to the schema.
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
    const storage = await bucketStorageFor(context, row.bucketId);
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

  mutations.scanBucket.resolve = (_parent: unknown, args: { id: string }, context: Context) =>
    scanBucket(context, args.id);

  mutations.rekeyDocument.resolve = async (
    _parent: unknown,
    args: { id: string },
    context: Context,
    info: GraphQLResolveInfo,
  ) => selectDocument(context, info, (await rekeyDocument(context, args.id)).id);

  return extended;
}
