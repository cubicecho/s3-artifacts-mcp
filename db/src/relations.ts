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
  },
  buckets: {
    user: r.one.users({ from: r.buckets.userId, to: r.users.id, optional: false }),
    documents: r.many.documents(),
  },
  documents: {
    user: r.one.users({ from: r.documents.userId, to: r.users.id, optional: false }),
    bucket: r.one.buckets({ from: r.documents.bucketId, to: r.buckets.id, optional: false }),
    shareLinks: r.many.shareLinks(),
  },
  shareLinks: {
    user: r.one.users({ from: r.shareLinks.userId, to: r.users.id, optional: false }),
    document: r.one.documents({ from: r.shareLinks.documentId, to: r.documents.id, optional: false }),
  },
}));
