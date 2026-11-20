import { badInput } from '../core/errors.ts';

// A field added to a generated type (`Bucket.secretReadable`, `Document.contentUrl`) finds its row
// by the parent's id. drizzle-graphql selects only the columns a query names, and adds the
// primary key on its own only when the query names none, so `{ title contentUrl }` reaches the
// field with no id. Say so, rather than answer NOT_FOUND for a row that exists.

/**
 * The id of the row an added field belongs to.
 *
 * @param parent - The generated row, as drizzle-graphql selected it.
 * @param field - The added field, as `Type.field`, for the message.
 * @returns The row's id.
 * @throws BAD_USER_INPUT when the query did not select `id` beside the field.
 */
export function parentIdOf(parent: { id?: unknown }, field: string): string {
  if (typeof parent.id !== 'string') {
    throw badInput(`Select \`id\` alongside ${field}: it is resolved from the row's id.`);
  }
  return parent.id;
}
