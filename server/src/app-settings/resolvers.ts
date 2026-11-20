import { resolveSelection } from '@vantreeseba/drizzle-graphql';
import { assertObjectType, extendSchema, type GraphQLResolveInfo, type GraphQLSchema } from 'graphql';
import type { Context } from '../core/context.ts';
import { SHARE_LINK_DEFAULTS, UPLOAD_DEFAULTS } from '../core/defaults.ts';
import { requireAuth } from '../core/errors.ts';
import { parseOrThrow } from '../core/validation.ts';
import { typeNames } from '../graphql/naming.ts';
import { appSettingsUpdateSchema, updateAppSettings } from './app-settings.ts';
import { APP_SETTINGS_SDL } from './sdl.ts';

// Settings → General. The read is the generated `appSettings`, scoped by owner in tenancy.ts; the row exists from
// the moment the account does.

/** The table's key in the Drizzle schema, which `resolveSelection` names it by. */
const APP_SETTINGS_TABLE = 'appSettings';

/** `AppSettingsInput` as the resolver receives it. */
type AppSettingsInputArgs = Record<string, unknown>;

/**
 * The fields of an update that were sent with a value: a null keeps the stored one, as a missing key does.
 *
 * @param input - The input as sent.
 * @returns Only the keys with values.
 */
function sentFields(input: AppSettingsInputArgs): AppSettingsInputArgs {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null && value !== undefined));
}

/**
 * Adds `appSettingsLimits` and `updateAppSettings` to the schema.
 *
 * @param schema - The schema so far, which must already have a Mutation type and the generated `AppSettings`.
 * @returns The extended schema.
 */
export function applyAppSettingsExtension(schema: GraphQLSchema): GraphQLSchema {
  const extended = extendSchema(schema, APP_SETTINGS_SDL);
  const queries = assertObjectType(extended.getType('Query')).getFields();
  const mutations = assertObjectType(extended.getType('Mutation')).getFields();

  queries.appSettingsLimits.resolve = (_parent: unknown, _args: unknown, context: Context) => {
    requireAuth(context);
    return {
      minUploadBytes: UPLOAD_DEFAULTS.minUploadBytes,
      maxUploadBytes: UPLOAD_DEFAULTS.maxUploadBytes,
      minLinkExpiryHours: SHARE_LINK_DEFAULTS.minExpiryHours,
      maxLinkExpiryHours: SHARE_LINK_DEFAULTS.maxExpiryHours,
    };
  };

  mutations.updateAppSettings.resolve = async (
    _parent: unknown,
    args: { input: AppSettingsInputArgs },
    context: Context,
    info: GraphQLResolveInfo,
  ) => {
    const userId = requireAuth(context);
    const update = parseOrThrow(appSettingsUpdateSchema, sentFields(args.input));
    await updateAppSettings(context.db, userId, update);
    return resolveSelection(info, {
      db: context.db,
      table: APP_SETTINGS_TABLE,
      context,
      typeNameMapper: typeNames,
      where: { userId: { eq: userId } },
      single: true,
    });
  };

  return extended;
}
