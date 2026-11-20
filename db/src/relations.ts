import { defineRelations } from 'drizzle-orm';
import * as schema from './schema.ts';

/**
 * How the tables relate. drizzle-graphql reads this config, not the table list, so a table
 * with no entry here gets no relation fields in the API.
 */
export const relations = defineRelations(schema, (r) => ({
  users: {
    buckets: r.many.buckets(),
    documents: r.many.documents(),
    shareLinks: r.many.shareLinks(),
    tags: r.many.tags(),
  },
  buckets: {
    user: r.one.users({ from: r.buckets.userId, to: r.users.id, optional: false }),
    documents: r.many.documents(),
  },
  documents: {
    user: r.one.users({ from: r.documents.userId, to: r.users.id, optional: false }),
    bucket: r.one.buckets({ from: r.documents.bucketId, to: r.buckets.id, optional: false }),
    shareLinks: r.many.shareLinks(),
    // Through the links. drizzle-graphql 16 builds broken SQL for a relation filter through them, so filter on the
    // tags a document answers, not with `where: { tags: … }`.
    tags: r.many.tags({
      from: r.documents.id.through(r.documentTags.documentId),
      to: r.tags.id.through(r.documentTags.tagId),
    }),
  },
  shareLinks: {
    user: r.one.users({ from: r.shareLinks.userId, to: r.users.id, optional: false }),
    document: r.one.documents({ from: r.shareLinks.documentId, to: r.documents.id, optional: false }),
  },
  tags: {
    user: r.one.users({ from: r.tags.userId, to: r.users.id, optional: false }),
    // `documentsAggregate` on it is how many documents carry the tag.
    documents: r.many.documents({
      from: r.tags.id.through(r.documentTags.tagId),
      to: r.documents.id.through(r.documentTags.documentId),
    }),
  },
  documentTags: {
    user: r.one.users({ from: r.documentTags.userId, to: r.users.id, optional: false }),
    document: r.one.documents({ from: r.documentTags.documentId, to: r.documents.id, optional: false }),
    tag: r.one.tags({ from: r.documentTags.tagId, to: r.tags.id, optional: false }),
  },
}));
