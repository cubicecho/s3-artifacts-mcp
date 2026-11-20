import {
  documents,
  ShareLinkCreator,
  type ShareLinkPermission,
  shareLinks,
} from '@cubicecho/s3-artifacts-mcp-db/schema';
import { resolveSelection } from '@vantreeseba/drizzle-graphql';
import { and, eq } from 'drizzle-orm';
import { assertObjectType, extendSchema, type GraphQLResolveInfo, type GraphQLSchema } from 'graphql';
import { z } from 'zod';
import type { Context } from '../core/context.ts';
import { notFound, requireAuth } from '../core/errors.ts';
import { SecretPurpose, SecretUnreadableError } from '../core/secrets.ts';
import { typeNames } from '../graphql/naming.ts';
import { parentIdOf } from '../graphql/parent-id.ts';
import { createShareLink } from './create.ts';
import { SHARE_LINKS_SDL } from './sdl.ts';
import { type ShareLinkState, shareLinkState } from './state.ts';

// The owner's share links: making one, its URL and state, and removing it from the list. Reads are the generated
// `shareLinks` / `shareLink` fields and `Document.shareLinks`, scoped by owner in tenancy.ts.

/** The table's key in the Drizzle schema, which `resolveSelection` names it by. */
const SHARE_LINKS_TABLE = 'shareLinks';
/** The message for a link that does not exist or is not the caller's, which the caller may not tell apart. */
const SHARE_LINK_NOT_FOUND = 'Share link not found.';

const idSchema = z.uuid();

/** A link as its added fields need it: the sealed URL, and the key the link and its document are at. */
interface OwnedShareLink {
  urlEnc: string;
  objectKey: string;
  expiresAt: Date;
  documentKey: string;
}

/**
 * Loads one of the caller's links, with where its document's object is now.
 *
 * @param ctx - The request.
 * @param id - The link's id, as sent.
 * @returns The link.
 * @throws NOT_FOUND when it is malformed, missing or not the caller's.
 */
async function ownShareLink(ctx: Context, id: unknown): Promise<OwnedShareLink> {
  const userId = requireAuth(ctx);
  const parsed = idSchema.safeParse(id);
  if (parsed.success === false) {
    throw notFound(SHARE_LINK_NOT_FOUND);
  }
  const [row] = await ctx.db
    .select({
      urlEnc: shareLinks.urlEnc,
      objectKey: shareLinks.objectKey,
      expiresAt: shareLinks.expiresAt,
      documentKey: documents.objectKey,
    })
    .from(shareLinks)
    .innerJoin(documents, eq(documents.id, shareLinks.documentId))
    .where(and(eq(shareLinks.id, parsed.data), eq(shareLinks.userId, userId)));
  if (row === undefined) {
    throw notFound(SHARE_LINK_NOT_FOUND);
  }
  return row;
}

/**
 * Adds the share-link mutations, `ShareLink.url` and `ShareLink.state` to the schema.
 *
 * @param schema - The schema so far, which must already have a Mutation type and the generated `ShareLink`.
 * @returns The extended schema.
 */
export function applyShareLinksExtension(schema: GraphQLSchema): GraphQLSchema {
  const extended = extendSchema(schema, SHARE_LINKS_SDL);
  const mutations = assertObjectType(extended.getType('Mutation')).getFields();
  const linkFields = assertObjectType(extended.getType('ShareLink')).getFields();

  linkFields.url.resolve = async (parent: { id?: unknown }, _args: unknown, context: Context) => {
    const link = await ownShareLink(context, parentIdOf(parent, 'ShareLink.url'));
    try {
      return context.secrets.open(link.urlEnc, SecretPurpose.ShareLinkUrl);
    } catch (error) {
      if (error instanceof SecretUnreadableError) {
        return null;
      }
      throw error;
    }
  };

  linkFields.state.resolve = async (
    parent: { id?: unknown },
    _args: unknown,
    context: Context,
  ): Promise<ShareLinkState> => {
    const link = await ownShareLink(context, parentIdOf(parent, 'ShareLink.state'));
    return shareLinkState(link, link.documentKey, new Date());
  };

  mutations.createShareLink.resolve = async (
    _parent: unknown,
    args: {
      documentId: string;
      permission?: ShareLinkPermission | null;
      expiresInHours?: number | null;
      label?: string | null;
    },
    context: Context,
    info: GraphQLResolveInfo,
  ) => {
    const { row } = await createShareLink(context, args, ShareLinkCreator.Owner);
    return resolveSelection(info, {
      db: context.db,
      table: SHARE_LINKS_TABLE,
      context,
      typeNameMapper: typeNames,
      where: { id: { eq: row.id } },
      single: true,
    });
  };

  mutations.deleteShareLink.resolve = async (_parent: unknown, args: { id: string }, context: Context) => {
    const userId = requireAuth(context);
    const parsed = idSchema.safeParse(args.id);
    const deleted = parsed.success
      ? await context.db
          .delete(shareLinks)
          .where(and(eq(shareLinks.id, parsed.data), eq(shareLinks.userId, userId)))
          .returning({ id: shareLinks.id })
      : [];
    if (deleted.length === 0) {
      throw notFound(SHARE_LINK_NOT_FOUND);
    }
    return true;
  };

  return extended;
}
