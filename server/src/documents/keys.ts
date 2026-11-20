import { DOCUMENT_DEFAULTS } from '../core/defaults.ts';

// Where a document's bytes live in its bucket: `<objectId>-<safe filename>`, at the top level.
// The uuid keeps keys unique without a lookup, and the filename still tells anyone browsing the
// bucket what the object is (D11).

/** Anything outside the characters every S3-compatible service and every shell take without quoting. */
const UNSAFE_RUN = /[^A-Za-z0-9._-]+/g;
/** Combining marks, which NFKD splits off accented letters so the letter itself survives. */
const COMBINING_MARKS = /\p{M}/gu;
/** Separators and dots at either end, which read as hidden files or leave a dangling hyphen. */
const EDGE_PUNCTUATION = /^[-.]+|[-.]+$/g;
/** An extension worth keeping: a dot and a short run of letters and digits at the end. */
const EXTENSION = /\.[A-Za-z0-9]{1,16}$/;
/** What the name part becomes when nothing safe is left of the filename. */
const FALLBACK_NAME = 'file';
/** Joins the object id to the name. */
const SEPARATOR = '-';

/**
 * Makes a filename safe for an object key: ASCII letters, digits, `.`, `_` and `-` only, no `/`,
 * capped in length with its extension kept.
 *
 * @param filename - The name the file was uploaded as.
 * @param [maxLength] - The longest result, in characters.
 * @returns The safe name. Never empty.
 */
export function safeKeyName(filename: string, maxLength: number = DOCUMENT_DEFAULTS.keyFilenameMaxLength): string {
  const ascii = filename.normalize('NFKD').replace(COMBINING_MARKS, '');
  const safe = ascii.replace(UNSAFE_RUN, SEPARATOR);
  // Read before the edges are trimmed, so a name with nothing safe before its extension keeps it (`file.pdf`).
  const extension = EXTENSION.exec(safe)?.[0] ?? '';
  const base = safe.slice(0, safe.length - extension.length).replace(EDGE_PUNCTUATION, '');
  const room = Math.max(maxLength - extension.length, 1);
  const cut = base.slice(0, room).replace(EDGE_PUNCTUATION, '');
  return `${cut === '' ? FALLBACK_NAME : cut}${extension}`.slice(0, maxLength);
}

/**
 * The key a document's bytes are stored at.
 *
 * @param objectId - A random uuid: the document's id when it is first uploaded.
 * @param filename - The name the file was uploaded as.
 * @returns `<objectId>-<safe filename>`.
 */
export function objectKeyFor(objectId: string, filename: string): string {
  return `${objectId}${SEPARATOR}${safeKeyName(filename)}`;
}
