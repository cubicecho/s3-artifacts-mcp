import { type Tag, tags } from '@cubicecho/s3-artifacts-mcp-db/schema';
import { resolveSelection } from '@vantreeseba/drizzle-graphql';
import { and, eq } from 'drizzle-orm';
import { assertObjectType, extendSchema, type GraphQLResolveInfo, type GraphQLSchema } from 'graphql';
import { z } from 'zod';
import type { Context } from '../core/context.ts';
import { badInput, notFound, requireAuth } from '../core/errors.ts';
import { typeNames } from '../graphql/naming.ts';
import { createTagRow, type TagInput, updateTagRow } from './names.ts';
import { TAGS_SDL } from './sdl.ts';
import { addTags, ownDocumentIds, ownTagIds, removeTags, replaceTags, TAG_NOT_FOUND } from './tagging.ts';

// The owner's tags: making, renaming, recolouring and deleting one, and putting tags on documents one at a time or in
// bulk. Reads are the generated `tags` / `tag` fields and `Document.tags`, scoped by owner in tenancy.ts. The name
// rules are in names.ts, which MCP shares.

/** The tables' keys in the Drizzle schema, which `resolveSelection` names them by. */
const TAGS_TABLE = 'tags';
const DOCUMENTS_TABLE = 'documents';

const idSchema = z.uuid();

/**
 * Loads one of the caller's tags.
 *
 * @param ctx - The request.
 * @param id - The tag's id, as sent.
 * @returns The row.
 * @throws NOT_FOUND when it is malformed, missing or not the caller's.
 */
async function ownTag(ctx: Context, id: unknown): Promise<Tag> {
  const userId = requireAuth(ctx);
  const parsed = idSchema.safeParse(id);
  const [row] = parsed.success
    ? await ctx.db
        .select()
        .from(tags)
        .where(and(eq(tags.id, parsed.data), eq(tags.userId, userId)))
    : [];
  if (row === undefined) {
    throw notFound(TAG_NOT_FOUND);
  }
  return row;
}

/**
 * Answers with rows of a table as the client selected them, relations included.
 *
 * @param ctx - The request.
 * @param info - The field's resolve info, whose selection is read.
 * @param table - The table's Drizzle key.
 * @param ids - The rows.
 * @param single - Whether the field is one row rather than a list.
 * @returns The rows, shaped like a generated read's.
 */
function selectRows(
  ctx: Context,
  info: GraphQLResolveInfo,
  table: string,
  ids: readonly string[],
  single: boolean,
): Promise<unknown> {
  return resolveSelection(info, {
    db: ctx.db,
    table,
    context: ctx,
    typeNameMapper: typeNames,
    where: single ? { id: { eq: ids[0] } } : { id: { inArray: [...ids] } },
    single,
  });
}

/**
 * Adds the tag mutations to the schema.
 *
 * @param schema - The schema so far, which must already have a Mutation type and the generated `Tag` and `Document`.
 * @returns The extended schema.
 */
export function applyTagsExtension(schema: GraphQLSchema): GraphQLSchema {
  const extended = extendSchema(schema, TAGS_SDL);
  const mutations = assertObjectType(extended.getType('Mutation')).getFields();

  mutations.createTag.resolve = async (
    _parent: unknown,
    args: TagInput,
    context: Context,
    info: GraphQLResolveInfo,
  ) => {
    const row = await createTagRow(context.db, requireAuth(context), args);
    return selectRows(context, info, TAGS_TABLE, [row.id], true);
  };

  mutations.updateTag.resolve = async (
    _parent: unknown,
    args: TagInput & { id: string },
    context: Context,
    info: GraphQLResolveInfo,
  ) => {
    const row = await updateTagRow(context.db, await ownTag(context, args.id), args);
    return selectRows(context, info, TAGS_TABLE, [row.id], true);
  };

  mutations.deleteTag.resolve = async (_parent: unknown, args: { id: string }, context: Context) => {
    const row = await ownTag(context, args.id);
    // The links go with it (ON DELETE CASCADE): the documents stay, without the tag.
    await context.db.delete(tags).where(and(eq(tags.id, row.id), eq(tags.userId, row.userId)));
    return true;
  };

  mutations.setDocumentTags.resolve = async (
    _parent: unknown,
    args: { documentId: string; tagIds: readonly string[] },
    context: Context,
    info: GraphQLResolveInfo,
  ) => {
    const userId = requireAuth(context);
    const [documentId] = await ownDocumentIds(context.db, userId, [args.documentId]);
    const tagIds = await ownTagIds(context.db, userId, args.tagIds);
    await context.db.transaction((tx) => replaceTags(tx, userId, documentId, tagIds));
    return selectRows(context, info, DOCUMENTS_TABLE, [documentId], true);
  };

  mutations.bulkTagDocuments.resolve = async (
    _parent: unknown,
    args: { documentIds: readonly string[]; add?: readonly string[] | null; remove?: readonly string[] | null },
    context: Context,
    info: GraphQLResolveInfo,
  ) => {
    const userId = requireAuth(context);
    const documentIds = await ownDocumentIds(context.db, userId, args.documentIds);
    const add = await ownTagIds(context.db, userId, args.add ?? []);
    const remove = await ownTagIds(context.db, userId, args.remove ?? []);
    const isInBoth = add.some((id) => remove.includes(id));
    if (isInBoth) {
      throw badInput('A tag cannot be added and removed at once.');
    }
    await context.db.transaction(async (tx) => {
      await addTags(tx, userId, documentIds, add);
      await removeTags(tx, userId, documentIds, remove);
    });
    return selectRows(context, info, DOCUMENTS_TABLE, documentIds, false);
  };

  return extended;
}
