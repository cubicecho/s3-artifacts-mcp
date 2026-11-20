// How the MCP tools treat a document by its type: what `get_document` may hand an agent as text, what as an
// embedded resource, and which uploads are text that `upload_document` stores as UTF-8.

/** Types whose bytes are text a model can read: every `text/*`, and the structured formats written as text. */
const TEXT_LIKE =
  /^(?:text\/[\w.+-]+|image\/svg\+xml|application\/(?:json|xml|javascript|ecmascript|yaml|x-yaml|toml|sql|graphql|x-sh|[\w.-]+\+(?:json|xml)))$/;
/** Types `get_document` hands over as an embedded resource: images and PDFs. */
const INLINE_BINARY = /^(?:image\/[\w.+-]+|application\/pdf)$/;
/** A `charset` parameter, in any case. */
const CHARSET_PARAM = /;\s*charset\s*=/i;
/** What `upload_document` stores text as. */
const UTF8_CHARSET = 'charset=utf-8';

/**
 * A content type without its parameters, lower case: `text/markdown; charset=utf-8` is `text/markdown`.
 *
 * @param contentType - The type as stored.
 * @returns Its essence.
 */
export function typeEssence(contentType: string): string {
  return contentType.split(';')[0].trim().toLowerCase();
}

/**
 * Whether a document of this type is text a model can read.
 *
 * @param contentType - The type as stored.
 * @returns True for text, markup and the text formats.
 */
export function isTextLike(contentType: string): boolean {
  return TEXT_LIKE.test(typeEssence(contentType));
}

/**
 * Whether a document of this type is handed over as an embedded resource.
 *
 * @param contentType - The type as stored.
 * @returns True for images (SVG aside, which is text) and PDFs.
 */
export function isInlineBinary(contentType: string): boolean {
  return isTextLike(contentType) === false && INLINE_BINARY.test(typeEssence(contentType));
}

/**
 * The type text uploaded inline is stored as: the one asked for, saying UTF-8 when it is a text type that names no
 * charset, so a browser opening its share link does not guess another encoding.
 *
 * @param contentType - The type the agent asked for, already checked.
 * @returns The type to store.
 */
export function utf8ContentType(contentType: string): string {
  const isUnnamedText = isTextLike(contentType) && CHARSET_PARAM.test(contentType) === false;
  return isUnnamedText ? `${contentType}; ${UTF8_CHARSET}` : contentType;
}
