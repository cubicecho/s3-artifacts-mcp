/**
 * Every path the app answers at, as react-router patterns.
 *
 * The router, the sidebar and every redirect read the same entry, so a path that
 * moves is changed once rather than found by searching for a string.
 */
export const ROUTES = Object.freeze({
  /** The documents, across every bucket. */
  documents: '/',
  settings: '/settings',
  login: '/login',
  /** Where a magic link lands, carrying its token in the query string. */
  verify: '/auth/verify',
  /** Where an OIDC sign-in lands, carrying a one-time token the server's callback minted. */
  sso: '/auth/sso',
});
