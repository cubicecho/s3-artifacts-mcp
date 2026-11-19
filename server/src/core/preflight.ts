// Environment checks that must run before anything opens a connection or signs a
// token. Imported for its side effects as the very first import of index.ts, so
// a misconfigured instance fails with a sentence rather than a stack trace.

import { DEV_SECRET, PLACEHOLDER_SECRET } from './config.ts';
import { AUTH_DEFAULTS } from './defaults.ts';

function fatal(message: string): never {
  console.error(`[preflight] ${message}`);
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  fatal('DATABASE_URL is required. Copy .env.example to .env, then run `npm run db:up` for a local Postgres.');
}

if (process.env.NODE_ENV === 'production') {
  const secret = process.env.BETTER_AUTH_SECRET ?? '';
  const isKnownSecret = secret === DEV_SECRET || secret === PLACEHOLDER_SECRET;
  const isWeakSecret = secret.length < AUTH_DEFAULTS.minSecretLength || isKnownSecret;
  if (isWeakSecret) {
    // Sessions are signed with this and nothing else. A known or guessable secret
    // means anyone can mint a session for any account.
    const renamed = process.env.JWT_SECRET ? ' JWT_SECRET is no longer read: rename it.' : '';
    fatal(
      `BETTER_AUTH_SECRET must be a random value of at least ${AUTH_DEFAULTS.minSecretLength} characters in production. Generate one with \`openssl rand -hex 32\`.${renamed}`,
    );
  }
}
