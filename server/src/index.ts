import './core/preflight.ts';

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, db } from '@cubicecho/s3-artifacts-mcp-db';
import { waitForDatabase } from '@cubicecho/s3-artifacts-mcp-db/wait';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createAuthHost } from './auth/auth-host.ts';
import { createRateLimiter } from './auth/rate-limit.ts';
import {
  appUrl,
  authSecret,
  databaseUrl,
  dbConnectTimeoutMs,
  magicLinkExposed,
  magicLinkRequired,
  oidcRedirectUri,
  port,
} from './core/config.ts';
import { errorMessage } from './core/errors.ts';
import { createSecretBox } from './core/secrets.ts';
import { startUploadSweeper } from './documents/sweep.ts';
import { createApp } from './http/app.ts';
import { stopOnSignals } from './http/shutdown.ts';
import { createStorageRegistry } from './storage/registry.ts';

export type { Context } from './core/context.ts';

/** Postgres's port, shown when DATABASE_URL names none. */
const DEFAULT_POSTGRES_PORT = '5432';
/** Every interface. The container's port mapping decides who can reach it. */
const LISTEN_HOST = '0.0.0.0';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = port();
const staticDir = join(__dirname, '../../app/dist');

try {
  await waitForDatabase(db, { connectTimeoutMs: dbConnectTimeoutMs() });
} catch (error) {
  const { hostname, port: urlPort } = new URL(databaseUrl());
  const dbPort = urlPort === '' ? DEFAULT_POSTGRES_PORT : urlPort;
  console.error(`[db] cannot reach Postgres at ${hostname}:${dbPort}: ${errorMessage(error)}`);
  console.error('[db] check DATABASE_URL in .env, and that the database is up and reachable from here.');
  console.error('[db] if your Docker daemon is remote (`docker context ls`), a container published on');
  console.error("[db] 127.0.0.1 is bound to the daemon host's loopback. Set DEV_BIND=0.0.0.0 and");
  console.error('[db] re-run `npm run db:up`.');
  process.exit(1);
}

// Migrations run at boot so `docker compose up` on a fresh volume is the whole
// install. They are idempotent; a container restart is a no-op.
await migrate(db, { migrationsFolder: join(__dirname, '../../db/drizzle') });

// After migrate: the provider is a pairing, which lives in the database.
const authHost = await createAuthHost(db);
const secrets = createSecretBox(authSecret());
const storage = createStorageRegistry({ db, secrets });
const app = createApp({ db, authHost, limiter: createRateLimiter(), storage, secrets, staticDir });

const server = app.listen(PORT, LISTEN_HOST, () => {
  // APP_URL, not localhost: on a NAS the banner is the only place the operator
  // sees what the instance thinks its own address is, and a wrong one there is
  // the same wrong one that breaks their magic links.
  console.log(`[server] ready at ${appUrl()}`);
  console.log(`[server] GraphQL at ${appUrl()}/graphql`);
  const oidc = authHost.oidc();
  if (oidc !== null) {
    // The redirect URI is the one thing the provider has to have registered, exactly.
    console.log(`[auth] sign-in with ${oidc.name} (${oidc.issuer}); redirect URI ${oidcRedirectUri()}`);
  }
  if (magicLinkRequired() === false) {
    console.warn('[auth] SECURE_LOCAL_NET is on: an email address signs in without a link. Private networks only.');
  } else if (magicLinkExposed()) {
    console.warn('[auth] EXPOSE_MAGIC_LINK is on: sign-in links are returned in API responses. Private networks only.');
  }
});
// Unfinished uploads, swept on a timer that stops before the drain.
const sweeper = startUploadSweeper({ db, storage });
stopOnSignals(server, { before: () => sweeper.stop(), after: closeDatabase });
