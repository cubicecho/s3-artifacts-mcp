import type { Document } from '@cubicecho/s3-artifacts-mcp-db/schema';
import { CONTENT_DEFAULTS } from '../core/defaults.ts';
import { type SecretBox, SignaturePurpose } from '../core/secrets.ts';
import { MS_PER_SECOND, SECONDS_PER_MINUTE } from '../core/wire.ts';

// Where a document's bytes are sent to and read from, through the server (D4), and the signed
// form of the read URL. `<img>`, `<iframe>`, `<video>` and `<a download>` cannot send the session's
// bearer header, so `Document.contentUrl` hands the owner a URL that carries its own short-lived
// proof instead: an HMAC over the document, its object key, the disposition and the expiry.

/** The route both content handlers are mounted at, in Express's syntax. */
export const CONTENT_ROUTE = '/api/documents/:id/content';
/** The query parameter a signed URL carries its token in. */
export const TOKEN_PARAM = 't';
/** The query parameter that asks for an attachment rather than inline. */
export const DOWNLOAD_PARAM = 'download';
/** The value of `DOWNLOAD_PARAM` that turns it on. */
export const DOWNLOAD_ON = '1';
/** Separates the expiry from the signature in a token. Not in base64url's alphabet. */
const TOKEN_SEPARATOR = '.';
/** Separates the fields of the signed message. Never in a UUID, an object key or a number. */
const FIELD_SEPARATOR = '\n';

/**
 * The path a document's bytes are uploaded to and read from.
 *
 * @param documentId - The document.
 * @returns `/api/documents/<id>/content`.
 */
export function contentPath(documentId: string): string {
  return CONTENT_ROUTE.replace(':id', documentId);
}

/** The columns a content token is bound to. */
type SignedDocument = Pick<Document, 'id' | 'objectKey'>;

/**
 * What a token signs: the document, the key its bytes are at (so a re-key kills the URL), the disposition
 * and the expiry.
 *
 * @param document - The document.
 * @param download - Whether the URL asks for an attachment.
 * @param expiresAtSeconds - When it stops working, in Unix seconds.
 * @returns The message.
 */
function signedMessage(document: SignedDocument, download: boolean, expiresAtSeconds: number): string {
  return [document.id, document.objectKey, download ? DOWNLOAD_ON : '0', String(expiresAtSeconds)].join(
    FIELD_SEPARATOR,
  );
}

/**
 * Builds a URL that reads a document without a session, for a while.
 *
 * @param secrets - Signs the token.
 * @param document - The document, as stored now.
 * @param download - Whether the URL answers with an attachment rather than inline.
 * @param [now] - The time the URL is made at.
 * @returns `/api/documents/<id>/content?t=<token>`, plus `&download=1` when asked. Relative: same origin only.
 */
export function signedContentUrl(
  secrets: SecretBox,
  document: SignedDocument,
  download: boolean,
  now: Date = new Date(),
): string {
  const ttlSeconds = CONTENT_DEFAULTS.urlTtlMinutes * SECONDS_PER_MINUTE;
  const expiresAtSeconds = Math.floor(now.getTime() / MS_PER_SECOND) + ttlSeconds;
  const signature = secrets.sign(signedMessage(document, download, expiresAtSeconds), SignaturePurpose.ContentUrl);
  const query = new URLSearchParams({ [TOKEN_PARAM]: `${expiresAtSeconds}${TOKEN_SEPARATOR}${signature}` });
  if (download) {
    query.set(DOWNLOAD_PARAM, DOWNLOAD_ON);
  }
  return `${contentPath(document.id)}?${query}`;
}

/**
 * Checks a token from a signed URL against the document it names.
 *
 * @param secrets - Checks the signature.
 * @param document - The document the URL's path names, as stored now.
 * @param token - The `t` parameter as sent.
 * @param download - Whether the URL asks for an attachment, which the token must have been signed for.
 * @param [now] - The time it is checked at.
 * @returns Whether the token is this document's, for its current key and this disposition, and not expired.
 */
export function isValidContentToken(
  secrets: SecretBox,
  document: SignedDocument,
  token: string,
  download: boolean,
  now: Date = new Date(),
): boolean {
  const [expiry, signature, ...rest] = token.split(TOKEN_SEPARATOR);
  const expiresAtSeconds = Number(expiry);
  const isMalformed = rest.length > 0 || signature === undefined || Number.isSafeInteger(expiresAtSeconds) === false;
  if (isMalformed) {
    return false;
  }
  const isExpired = expiresAtSeconds * MS_PER_SECOND <= now.getTime();
  if (isExpired) {
    return false;
  }
  return secrets.verify(signedMessage(document, download, expiresAtSeconds), signature, SignaturePurpose.ContentUrl);
}
