import { assertObjectType, extendSchema, type GraphQLSchema, parse } from 'graphql';
import { hasOwner, isOwner } from '../auth/owner.ts';
import { oidcRedirectUri } from '../core/config.ts';
import type { Context } from '../core/context.ts';
import { badInput, conflict, ErrorCode, forbidden, withCode } from '../core/errors.ts';
import { PairingError, PairingFailure, pair, unpair } from './pairing.ts';
import { effectiveOidc, SsoSource } from './settings.ts';

// Pairing the instance with an OIDC provider from the app (pairing.ts): paste
// the setup URL the provider gave you, and its button appears on the login page
// without a restart.
//
// Who may pair: the owner, or anyone at all while the instance is brand new (no
// owner yet), so whoever installs it can set sign-in up from the login page
// before there is an owner to ask. The first account to sign in becomes the
// owner (auth/owner.ts). Once there is one, a stranger could otherwise point
// sign-in at a provider of their own and sign in as the owner's address, so only
// the owner may.
//
// Pairing is the only way to configure a provider: there is no environment override.

const SSO_SDL = parse(`
  "Whether the instance has an OIDC provider."
  enum SsoSource {
    "Paired from a setup URL."
    PAIRED
    "There is none."
    NONE
  }

  "How sign-in through an OIDC provider is set up, and whether the caller may change it."
  type SsoSetup {
    source: SsoSource!
    "The provider's issuer URL. Only for a caller who may pair."
    issuer: String
    "What the login page's button calls the provider."
    name: String
    "Whether the caller may pair a provider, or disconnect the paired one."
    canPair: Boolean!
    "The redirect URI pairing registers with the provider: better-auth's callback on the origin the caller used."
    redirectUri: String!
  }

  extend type Query {
    "Readable signed out, so a new instance's login page can offer to set sign-in up."
    ssoSetup: SsoSetup!
  }

  extend type Mutation {
    """
    Pairs with the provider a setup URL names (\`<issuer>#setup=<token>&name=<name>\`). The owner, or
    anyone on an instance with no owner yet. BAD_USER_INPUT or TOO_MANY_REQUESTS with
    \`extensions.reason\` when the provider would not pair.
    """
    pairSso(setupUrl: String!): SsoSetup!
    "Deletes the paired provider's client and stops offering it on the login page. Same rule as pairSso."
    unpairSso: SsoSetup!
  }
`);

/**
 * Whether the caller may pair or disconnect a provider.
 *
 * @param ctx - The request.
 * @param source - Where the provider in use comes from.
 * @returns True for the owner, or for anyone while the instance has no owner.
 */
export async function canPairSso(ctx: Context): Promise<boolean> {
  if (ctx.userId !== null && (await isOwner(ctx.db, ctx.userId))) {
    return true;
  }
  return (await hasOwner(ctx.db)) === false;
}

async function ssoSetup(ctx: Context) {
  const { config, source } = await effectiveOidc(ctx.db);
  const canPair = await canPairSso(ctx);
  return {
    source,
    issuer: canPair ? (config?.issuer ?? null) : null,
    name: config?.name ?? null,
    canPair,
    redirectUri: oidcRedirectUri(ctx.origin),
  };
}

/**
 * Refuses a caller who may not pair.
 *
 * @returns Where the provider in use comes from.
 * @throws FORBIDDEN. This is about the instance, not a row, so it is not the NOT_FOUND a row would be.
 */
async function requirePairing(ctx: Context): Promise<SsoSource> {
  if ((await canPairSso(ctx)) === false) {
    throw forbidden('Only the owner can change how people sign in.');
  }
  const { source } = await effectiveOidc(ctx.db);
  return source;
}

/** A pairing failure as an API error, with its reason for the app. */
function pairingError(error: unknown): unknown {
  if (error instanceof PairingError === false) {
    return error;
  }
  if (error.reason === PairingFailure.RateLimited) {
    return withCode(error.message, ErrorCode.TooManyRequests, { reason: error.reason });
  }
  return withCode(error.message, ErrorCode.BadUserInput, { reason: error.reason });
}

/**
 * Adds `ssoSetup`, `pairSso` and `unpairSso` to the schema.
 *
 * @param schema - The schema, which must already have a Mutation type.
 * @returns The extended schema.
 */
export function applySsoExtension(schema: GraphQLSchema): GraphQLSchema {
  const extendedSchema = extendSchema(schema, SSO_SDL);
  const queries = assertObjectType(extendedSchema.getType('Query')).getFields();
  const mutations = assertObjectType(extendedSchema.getType('Mutation')).getFields();

  queries.ssoSetup.resolve = (_parent: unknown, _args: unknown, context: Context) => ssoSetup(context);

  mutations.pairSso.resolve = async (_parent: unknown, args: { setupUrl: string }, context: Context) => {
    const source = await requirePairing(context);
    if (source === SsoSource.Paired) {
      throw conflict('This instance is already paired with a provider. Disconnect it first.');
    }
    if (args.setupUrl.trim() === '') {
      throw badInput('Paste the setup URL your provider gave you.');
    }
    try {
      await pair(context.db, args.setupUrl, oidcRedirectUri(context.origin));
    } catch (error) {
      throw pairingError(error);
    }
    await context.authHost.rebuild();
    return ssoSetup(context);
  };

  mutations.unpairSso.resolve = async (_parent: unknown, _args: unknown, context: Context) => {
    await requirePairing(context);
    await unpair(context.db);
    await context.authHost.rebuild();
    return ssoSetup(context);
  };

  return extendedSchema;
}
