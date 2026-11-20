import type { DB } from '@cubicecho/s3-artifacts-mcp-db';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Express, type Request, type Response } from 'express';
import type { AuthHost } from '../auth/auth-host.ts';
import { API_KEY_PREFIX } from '../auth/better-auth.ts';
import type { RateLimiter } from '../auth/rate-limit.ts';
import { type Context, UNKNOWN_IP } from '../core/context.ts';
import { HTTP_DEFAULTS, MCP_DEFAULTS } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import type { SecretBox } from '../core/secrets.ts';
import { HttpStatus } from '../core/wire.ts';
import { publicOrigin } from '../http/origin.ts';
import type { StorageRegistry } from '../storage/registry.ts';
import { findMcpBucket } from './access.ts';
import { createMcpServer } from './tools.ts';

// `/mcp/b/:slug`: one bucket's MCP endpoint, Streamable HTTP and stateless, one server per request, as Engrafo's
// `/mcp`. A client authenticates with one of the owner's API keys, never a session: not a cookie, not a session
// token, and SECURE_LOCAL_NET does not waive it, because the key is what says whose buckets these are. The key is
// checked first, so a caller without one learns nothing about which slugs exist; then a slug that names no bucket
// of the key's owner, and one whose MCP switch is off, answer the same 404.

/** Where one bucket's endpoint is, by its slug. */
export const MCP_ROUTE = '/mcp/b/:slug';

/**
 * The path of a bucket's endpoint.
 *
 * @param slug - The bucket's slug.
 * @returns `/mcp/b/<slug>`.
 */
export function mcpPath(slug: string): string {
  return `/mcp/b/${encodeURIComponent(slug)}`;
}

/** What the MCP endpoint reads requests against. */
export interface McpEndpointDeps {
  db: DB;
  authHost: AuthHost;
  limiter: RateLimiter;
  storage: StorageRegistry;
  secrets: SecretBox;
  fetch: typeof fetch;
}

/** JSON-RPC's code for a request the server will not serve; the SDK uses it for its own refusals. */
const JSON_RPC_SERVER_ERROR = -32_000;
/** An `Authorization` header carrying a bearer credential. */
const BEARER = /^Bearer\s+(.+)$/i;

const UNAUTHORIZED_MESSAGE = `Send one of the owner's API keys (Settings → API keys) as "Authorization: Bearer ${API_KEY_PREFIX}…" or "x-api-key".`;
const NOT_FOUND_MESSAGE = 'No bucket is shared over MCP at this address.';
const TOO_LARGE_MESSAGE =
  `The request is larger than this endpoint reads. upload_document takes at most ${MCP_DEFAULTS.inlineUploadBytes} ` +
  'bytes of text; send a larger file with create_upload.';

/**
 * The key a request carries, from `x-api-key` or `Authorization: Bearer`.
 *
 * @param req - The request.
 * @returns The key, or undefined when it carries none that looks like one. A cookie is never read.
 */
function keyOf(req: Request): string | undefined {
  const header = req.get('x-api-key') ?? req.get('authorization')?.match(BEARER)?.[1];
  const key = header?.trim();
  // A session token here is a mistake, not a credential: say so without asking better-auth.
  return key?.startsWith(API_KEY_PREFIX) ? key : undefined;
}

/**
 * Who a key belongs to.
 *
 * @param authHost - The current auth instance, which checks the key and records its use.
 * @param key - The key as sent.
 * @returns The owner's id, or null for a key that is unknown, revoked or expired.
 */
async function ownerOf(authHost: AuthHost, key: string): Promise<string | null> {
  const { valid, key: verified } = await authHost.current().api.verifyApiKey({ body: { key } });
  return valid && verified ? verified.referenceId : null;
}

/**
 * Answers a refusal as JSON-RPC, as the SDK answers its own.
 *
 * @param res - The response.
 * @param status - The HTTP status.
 * @param message - What the client is told.
 */
function refuse(res: Response, status: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code: JSON_RPC_SERVER_ERROR, message }, id: null });
}

/**
 * Mounts every bucket's endpoint on the app. Before the static handler, whose SPA fallback would answer it.
 *
 * @param app - The Express app.
 * @param deps - What a tool call's context is built from.
 */
export function mountMcp(app: Express, deps: McpEndpointDeps): void {
  const { db, authHost } = deps;
  const parseJson = express.json({ limit: HTTP_DEFAULTS.mcpBodyLimitBytes });

  // `all`, not `post`: clients also send GET (for a stream) and DELETE (to end a session), and the transport
  // answers both itself rather than Express's HTML 404.
  app.all(
    MCP_ROUTE,
    (req, res, next) => {
      parseJson(req, res, (error?: unknown) => {
        if (error === undefined) {
          next();
          return;
        }
        const isTooLarge = error instanceof Error && 'type' in error && error.type === 'entity.too.large';
        if (isTooLarge) {
          refuse(res, HttpStatus.PayloadTooLarge, TOO_LARGE_MESSAGE);
          return;
        }
        refuse(res, HttpStatus.BadRequest, 'The request body is not JSON.');
      });
    },
    async (req, res) => {
      const key = keyOf(req);
      const userId = key === undefined ? null : await ownerOf(authHost, key);
      if (userId === null) {
        refuse(res, HttpStatus.Unauthorized, UNAUTHORIZED_MESSAGE);
        return;
      }
      const bucket = await findMcpBucket(db, userId, String(req.params.slug));
      if (bucket === null) {
        refuse(res, HttpStatus.NotFound, NOT_FOUND_MESSAGE);
        return;
      }
      const ctx: Context = {
        ...deps,
        auth: authHost.current(),
        // Express's view of the client address, which honors `trust proxy`.
        ip: req.ip ?? UNKNOWN_IP,
        userId,
        origin: publicOrigin(req),
        // No tool reads the request's headers, and the key in them goes no further than here.
        headers: new Headers(),
      };
      const server = createMcpServer({ ctx, userId, bucket });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close().catch(() => undefined);
        void server.close().catch(() => undefined);
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        console.error(`[mcp] ${req.method} ${mcpPath(bucket.slug)}: ${errorMessage(error)}`);
        if (res.headersSent === false) {
          refuse(res, HttpStatus.InternalServerError, 'The server failed to answer.');
        }
      }
    },
  );
}
