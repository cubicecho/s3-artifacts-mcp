import { defineRelations } from 'drizzle-orm';
import * as schema from './schema.ts';

/**
 * How the tables relate. drizzle-graphql reads this config, not the table list, so a table
 * with no entry here gets no relation fields in the API.
 */
export const relations = defineRelations(schema, (r) => ({
  users: {
    buckets: r.many.buckets(),
  },
  buckets: {
    user: r.one.users({ from: r.buckets.userId, to: r.users.id, optional: false }),
  },
}));
