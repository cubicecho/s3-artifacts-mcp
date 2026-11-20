import type { DB } from '@cubicecho/s3-artifacts-mcp-db';
import type { Express, Request } from 'express';
import type { AuthHost } from '../auth/auth-host.ts';
import { ErrorCode } from '../core/errors.ts';
import type { SecretBox } from '../core/secrets.ts';
import { HttpStatus } from '../core/wire.ts';
import { CONTENT_ROUTE, TOKEN_PARAM } from '../documents/content-url.ts';
import { createDownloadHandler } from '../documents/download.ts';
import { CLOSE_CONNECTION, createUploadHandler } from '../documents/upload.ts';
import type { StorageRegistry } from '../storage/registry.ts';
import { RouteError, sendRouteError } from './route-error.ts';

// The REST door for a document's bytes (D4): `PUT` streams them in, `GET` streams them out. The
// session is the app's bearer token, as on /graphql, read from the `Authorization` header alone:
// a cookie is never consulted, so a cross-site page cannot ride on one. API keys are refused here
// (MCP has its own endpoint). `GET` also takes a signed URL from `Document.contentUrl`, for
// elements that cannot send a header. There are no CORS headers: same origin only.
//
// No body parser runs on these routes, so the upload's body reaches its handler as the raw stream,
// whatever its size; the size cap is the one `createDocumentUpload` checked.

/** Everything under here is the REST API. A path nobody mounted answers JSON, not the app. */
const API_PREFIX = '/api';

/** What the content routes are built from. */
export interface ContentRouteDeps {
  db: DB;
  /** Hands out the current auth instance, which reads the session. */
  authHost: AuthHost;
  storage: StorageRegistry;
  /** Checks the tokens in signed URLs. */
  secrets: SecretBox;
}

/**
 * Reads who the request is signed in as, from its bearer token only.
 *
 * @param authHost - The current auth instance's host.
 * @param req - The request.
 * @returns The user's id, or null when there is no header or the token is not a live session.
 */
async function bearerUserId(authHost: AuthHost, req: Request): Promise<string | null> {
  const { authorization } = req.headers;
  if (authorization === undefined) {
    return null;
  }
  const session = await authHost.current().api.getSession({ headers: new Headers({ authorization }) });
  return session?.user.id ?? null;
}

/** The refusal for a request with no live session. The client drops its token on this code. */
const UNAUTHENTICATED = new RouteError(HttpStatus.Unauthorized, ErrorCode.Unauthenticated, 'Unauthenticated');

/**
 * Mounts the content routes, and a JSON 404 for the rest of /api. Before the static handler, whose fallback
 * would answer them with the app.
 *
 * @param app - The Express app.
 * @param deps - The database, the auth host, the storage registry and the secret box.
 */
export function mountContent(app: Express, { db, authHost, storage, secrets }: ContentRouteDeps): void {
  const upload = createUploadHandler({ db, storage });
  const download = createDownloadHandler({ db, storage, secrets });

  app.put(CONTENT_ROUTE, async (req, res) => {
    const userId = await bearerUserId(authHost, req);
    if (userId === null) {
      sendRouteError(res, UNAUTHENTICATED, CLOSE_CONNECTION);
      return;
    }
    await upload(req, res, userId);
  });

  // Express answers HEAD with the GET route too; the handler sends the headers alone then.
  app.get(CONTENT_ROUTE, async (req, res) => {
    const token = req.query[TOKEN_PARAM];
    if (typeof token === 'string') {
      await download(req, res, { token });
      return;
    }
    const userId = await bearerUserId(authHost, req);
    if (userId === null) {
      sendRouteError(res, UNAUTHENTICATED);
      return;
    }
    await download(req, res, { userId });
  });

  app.use(API_PREFIX, (_req, res) => {
    sendRouteError(res, new RouteError(HttpStatus.NotFound, ErrorCode.NotFound, 'No such API route.'));
  });
}
