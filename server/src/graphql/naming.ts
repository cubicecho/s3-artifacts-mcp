import { singularizeMapper, type TypeNameMapper } from '@vantreeseba/drizzle-graphql';

// What each table is called in the API. Plural table keys get a singular type (`documents` → `Document`), except
// `appSettings`, whose one row is the caller's settings: singularized it would read `AppSetting`, which is not
// what the concept is called. `resolveSelection` takes the same mapper, so a hand-written field answers in the
// generated type's shape.

/** The names `appSettings` is given: the type `AppSettings` and the single read `appSettings`. */
const APP_SETTINGS_NAMES = Object.freeze({ singular: 'appSettings', plural: 'appSettingsRows' });

/**
 * The singular and plural names of a table's type and reads.
 *
 * @param tableName - The table's Drizzle key.
 * @returns Its names.
 */
export const typeNames: TypeNameMapper = (tableName) =>
  tableName === 'appSettings' ? APP_SETTINGS_NAMES : singularizeMapper(tableName);
