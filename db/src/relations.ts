import { defineRelations } from 'drizzle-orm';
import * as schema from './schema.ts';

/**
 * How the tables relate. drizzle-graphql reads this config, not the table list, so a table
 * with no entry here gets no relation fields in the API. Only `users` is in the schema so far, and
 * it relates to nothing the API serves.
 */
export const relations = defineRelations(schema, () => ({}));
