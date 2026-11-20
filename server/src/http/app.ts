import type { DB } from '@cubicecho/s3-artifacts-mcp-db';
import express, { type Express } from 'express';
import type { AuthHost } from '../auth/auth-host.ts';
import type { RateLimiter } from '../auth/rate-limit.ts';
import { trustProxy } from '../core/config.ts';
import type { SecretBox } from '../core/secrets.ts';
import { HttpStatus } from '../core/wire.ts';
import { createGraphQLHandler } from '../graphql/handler.ts';
import type { StorageRegistry } from '../storage/registry.ts';
import { mountContent } from './content.ts';
import { checkHealth } from './health.ts';
import { mountSso } from './sso.ts';
import { createStaticHandler } from './static.ts';

/** Where the liveness probe answers. */
export const HEALTH_PATH = '/healthz';

/** Everything the app is built from. Nothing is reached for globally, so a test hands in its own. */
export interface AppDeps {
  db: DB;
  /** Hands out the current auth instance. Pairing a provider rebuilds it while the server runs. */
  authHost: AuthHost;
  limiter: RateLimiter;
  /** Every bucket's storage, built from the bucket rows. A test hands in one over in-memory storage. */
  storage: StorageRegistry;
  /** Seals and opens stored credentials, with a key derived from `BETTER_AUTH_SECRET`. */
  secrets: SecretBox;
  /** The server's own outbound requests. The global `fetch` unless a test hands in its own. */
  fetch?: typeof fetch;
  /** The built web client. Left out, the app serves the API alone. */
  staticDir?: string;
}

/**
 * Builds the Express app without starting it.
 *
 * @param deps - The database, the auth host, the sign-in limiter, the storage registry, the secret box, the
 *   outbound fetch and where the client is.
 * @returns The app, which the caller listens on. Nothing is opened or scheduled here.
 */
export function createApp({ staticDir, fetch: fetchUrl = fetch, ...deps }: AppDeps): Express {
  const app = express();
  // Which proxy hops may set X-Forwarded-For. `req.ip` feeds the sign-in throttle.
  app.set('trust proxy', trustProxy());
  const graphql = createGraphQLHandler({ ...deps, fetch: fetchUrl });

  // `all` rather than `use`: a mounted `use` strips the path from req.url, and
  // Yoga matches the request against `graphqlEndpoint` itself.
  app.all(graphql.graphqlEndpoint, (req, res) => graphql(req, res));
  // Before the static handler, whose fallback would answer 200 while the database is down.
  app.get(HEALTH_PATH, async (_req, res) => {
    const health = await checkHealth(deps.db);
    const status = health.ok ? HttpStatus.Ok : HttpStatus.ServiceUnavailable;
    res.status(status).json(health);
  });
  // Before the static handler too: its SPA fallback would answer both paths with the app.
  // Always mounted, because a provider can be paired while the server runs.
  mountSso(app, deps.authHost);
  // A document's bytes, in and out, and a JSON 404 for the rest of /api.
  mountContent(app, deps);
  if (staticDir !== undefined) {
    const serveStatic = createStaticHandler(staticDir);
    app.use((req, res) => serveStatic(req, res));
  }
  return app;
}
