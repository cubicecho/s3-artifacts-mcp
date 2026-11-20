// Where an MCP client reaches a bucket, and the command that connects Claude Code to it. The path is the server's
// `MCP_ROUTE` (server/src/mcp/endpoint.ts); the app cannot import it, so the two are kept in step by hand.

/** What a bucket's endpoint path starts with, before its slug. */
export const MCP_PATH_PREFIX = '/mcp/b/';

/** Stands for the key in the snippet: a key is shown once, when it is made, and never again. */
export const API_KEY_PLACEHOLDER = '<your API key>';

/**
 * A bucket's MCP endpoint.
 *
 * @param origin - Where this instance is reached: the address the browser used.
 * @param slug - The bucket's slug.
 * @returns The endpoint's URL.
 */
export function mcpEndpoint(origin: string, slug: string): string {
  return `${origin}${MCP_PATH_PREFIX}${encodeURIComponent(slug)}`;
}

/**
 * The command that adds a bucket's endpoint to Claude Code, named after the bucket.
 *
 * @param slug - The bucket's slug, which names the server in Claude Code.
 * @param endpoint - The endpoint's URL.
 * @returns The command, with `API_KEY_PLACEHOLDER` where the key goes.
 *
 * @remarks
 * `--header` takes several values, so it comes after the name and the URL, where it cannot swallow them.
 */
export function claudeMcpAddCommand(slug: string, endpoint: string): string {
  return `claude mcp add --transport http ${slug} ${endpoint} --header "x-api-key: ${API_KEY_PLACEHOLDER}"`;
}
