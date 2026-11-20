import type { DB } from '@cubicecho/s3-artifacts-mcp-db';
import { AUTH_TABLES, SERVER_TABLES } from '@cubicecho/s3-artifacts-mcp-db/schema';
import { buildSchema, type GeneratedData } from '@vantreeseba/drizzle-graphql';
import { GraphQLObjectType, GraphQLSchema } from 'graphql';
import { applyApiKeysExtension } from '../api-keys/resolvers.ts';
import { applyAppSettingsExtension } from '../app-settings/resolvers.ts';
import { applyAuthExtension } from '../auth/resolvers.ts';
import { applyBucketsExtension } from '../buckets/resolvers.ts';
import { applyDocumentsExtension } from '../documents/resolvers.ts';
import { applyShareLinksExtension } from '../share-links/resolvers.ts';
import { applySsoExtension } from '../sso/resolvers.ts';
import { applyTagsExtension } from '../tags/resolvers.ts';
import { describeColumn, describeTable } from './docs.ts';
import { typeNames } from './naming.ts';
import { contextValues, features, scope } from './tenancy.ts';

// Reads are generated from the Drizzle schema; every write is hand-written (see
// `features` in tenancy.ts for why). Kept separate from schema.ts, which binds
// it to the real database, so a test can build the same schema against a
// throwaway one.

/** GraphQL names for the Postgres enums, instead of drizzle-graphql's `<Name>Enum`. */
const ENUM_NAMES: Readonly<Record<string, string>> = Object.freeze({
  bucket_provider: 'BucketProvider',
  document_status: 'DocumentStatus',
  share_link_permission: 'ShareLinkPermission',
  share_link_creator: 'ShareLinkCreator',
});

/**
 * With every generated write turned off, drizzle-graphql omits the Mutation
 * type entirely, and `extend type Mutation` has nothing to extend. An empty root
 * is invalid on its own, but the extensions fill it before anything validates.
 */
function withMutationRoot(schema: GraphQLSchema): GraphQLSchema {
  if (schema.getMutationType()) {
    return schema;
  }
  return new GraphQLSchema({ ...schema.toConfig(), mutation: new GraphQLObjectType({ name: 'Mutation', fields: {} }) });
}

/**
 * Builds the served schema: generated reads, then the hand-written fields of each concept.
 *
 * @param db - Database client the generated resolvers query.
 * @returns The schema, and drizzle-graphql's entities for anything that wants its resolvers.
 */
export function createSchema(db: DB): GeneratedData<DB, 'loose'> {
  const { schema: drizzleSchema, entities } = buildSchema(db, {
    prefixes: {
      insert: 'create',
      update: 'update',
      delete: 'delete',
    },
    // Table keys are plural (`documents`); derive singular names for the type
    // and single-row fields (Document, document). `appSettings` keeps its name (naming.ts).
    typeNameMapper: typeNames,
    // Sessions and magic-link tokens are only ever touched through better-auth,
    // and the OIDC pairing holds credentials only the server reads.
    // A bucket's sealed secret is read only by the storage registry, never through the API, and a share link's
    // sealed URL only by `ShareLink.url`.
    exclude: {
      tables: [...AUTH_TABLES, ...SERVER_TABLES],
      columns: { buckets: ['secretAccessKeyEnc'], shareLinks: ['urlEnc'] },
    },
    // `bucket_provider` reads as `BucketProvider`, not drizzle-graphql's `BucketProviderEnum`.
    enumNameMapper: ({ enumName }) => (enumName === undefined ? undefined : ENUM_NAMES[enumName]),
    describeTable,
    describeColumn,
    scope,
    contextValues,
    features,
  });

  let schema = withMutationRoot(drizzleSchema);
  schema = applyAuthExtension(schema);
  schema = applySsoExtension(schema);
  schema = applyApiKeysExtension(schema);
  schema = applyBucketsExtension(schema);
  schema = applyDocumentsExtension(schema);
  schema = applyShareLinksExtension(schema);
  schema = applyTagsExtension(schema);
  schema = applyAppSettingsExtension(schema);

  return { schema, entities };
}
