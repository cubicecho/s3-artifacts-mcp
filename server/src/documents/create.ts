import { randomUUID } from 'node:crypto';
import { type Bucket, type Document, DocumentStatus, documents } from '@cubicecho/s3-artifacts-mcp-db/schema';
import { z } from 'zod';
import { ownBucket } from '../buckets/resolvers.ts';
import type { Context } from '../core/context.ts';
import { DOCUMENT_DEFAULTS, UPLOAD_DEFAULTS } from '../core/defaults.ts';
import { badInput, requireAuth } from '../core/errors.ts';
import { SecretPurpose } from '../core/secrets.ts';
import { parseOrThrow } from '../core/validation.ts';
import { BYTES_PER_MEBIBYTE } from '../core/wire.ts';
import { objectKeyFor } from './keys.ts';

// How a document comes into being: a `pending_upload` row in a bucket the caller names, made before
// its bytes exist. The bytes then arrive through `PUT /api/documents/:id/content` (upload.ts), which
// makes it `ready`, or the sweeper drops it. Every upload names its bucket: there is no default one.

/** The type a document is stored as when the upload names none. */
export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';
/** Control characters, which a filename never needs and a header cannot carry. */
const CONTROL_CHARACTERS = /\p{Cc}/u;
/** A MIME type with optional parameters: `type/subtype; name=value`. Nothing a header could be split on. */
const CONTENT_TYPE = /^[\w.+-]+\/[\w.+-]+(?:\s*;\s*[\w.+-]+=(?:[\w.+-]+|"[^"\\\p{Cc}]*"))*$/u;
/** A file's extension, as `titleFromFilename` drops it. */
const EXTENSION = /\.[^./\\]+$/;

const { titleMaxLength, filenameMaxLength, contentTypeMaxLength } = DOCUMENT_DEFAULTS;

/** A title, for a new document or a rename. */
export const titleSchema = z
  .string()
  .trim()
  .min(1, 'Title cannot be empty.')
  .max(titleMaxLength, `A title can be at most ${titleMaxLength} characters.`);

/** A filename, for an upload or a file a scan found. */
export const filenameSchema = z
  .string()
  .trim()
  .min(1, 'Filename cannot be empty.')
  .max(filenameMaxLength, `A filename can be at most ${filenameMaxLength} characters.`)
  .refine((filename) => CONTROL_CHARACTERS.test(filename) === false, 'A filename cannot contain control characters.');

const contentTypeSchema = z
  .string()
  .nullish()
  .transform((value) => value?.trim() ?? '')
  .pipe(
    z.union([
      z.literal('').transform(() => DEFAULT_CONTENT_TYPE),
      z
        .string()
        .max(contentTypeMaxLength, 'The content type is too long.')
        .regex(CONTENT_TYPE, 'The content type is not a MIME type (`type/subtype`).'),
    ]),
  );

/**
 * What a new upload declares, checked against an upload cap.
 *
 * @param maxBytes - The largest file accepted, in bytes.
 * @returns The schema.
 */
function uploadSchema(maxBytes: number) {
  const maxMebibytes = Math.floor(maxBytes / BYTES_PER_MEBIBYTE);
  return z.object({
    filename: filenameSchema,
    contentType: contentTypeSchema,
    size: z
      .number()
      .int('The size must be a whole number of bytes.')
      .positive('The file is empty.')
      .max(maxBytes, `The file is larger than the ${maxMebibytes} MiB upload limit.`),
  });
}

/** What `createDocumentUpload` is sent. */
export interface DocumentUploadInput {
  bucketId: string;
  filename: string;
  contentType?: string | null;
  size: number;
}

/**
 * The title a file gets: its name without the extension.
 *
 * @param filename - The file's name.
 * @returns A title, cut to the longest a title may be. The whole name when it is only an extension.
 */
export function titleFromFilename(filename: string): string {
  const withoutExtension = filename.replace(EXTENSION, '').trim();
  return (withoutExtension === '' ? filename : withoutExtension).slice(0, titleMaxLength);
}

/**
 * Loads a bucket of the caller's whose secret still opens, so it can be reached now: for an upload or a scan.
 *
 * @param ctx - The request.
 * @param bucketId - The bucket as sent.
 * @param doing - What cannot happen without the secret, for the message: "uploaded to", "scanned".
 * @returns The bucket.
 * @throws NOT_FOUND when it is missing or someone else's; BAD_USER_INPUT when its secret no longer decrypts.
 */
export async function reachableBucket(ctx: Context, bucketId: string, doing: string): Promise<Bucket> {
  const bucket = await ownBucket(ctx, bucketId);
  const isSecretReadable = ctx.secrets.canOpen(bucket.secretAccessKeyEnc, SecretPurpose.BucketSecret);
  if (isSecretReadable === false) {
    throw badInput(
      `The stored secret for ${bucket.name} can no longer be decrypted, so it cannot be ${doing}. ` +
        'Enter it again in Settings → Buckets.',
    );
  }
  return bucket;
}

/**
 * Inserts a `pending_upload` row for a file about to be sent.
 *
 * @param ctx - The request.
 * @param input - The bucket, filename, type and size, as sent.
 * @returns The row. Its bytes go to `PUT /api/documents/<id>/content`.
 * @throws BAD_USER_INPUT for a bad filename or type, an empty file, one over the cap, or a bucket whose secret
 *   is unreadable; NOT_FOUND for a bucket that is missing or someone else's.
 */
export async function createPendingDocument(ctx: Context, input: DocumentUploadInput): Promise<Document> {
  const userId = requireAuth(ctx);
  // Step 4 reads the cap from `app_settings.max_upload_bytes`, bounded by this one.
  const { filename, contentType, size } = parseOrThrow(uploadSchema(UPLOAD_DEFAULTS.maxUploadBytes), input);
  const bucket = await reachableBucket(ctx, input.bucketId, 'uploaded to');
  const id = randomUUID();
  const [row] = await ctx.db
    .insert(documents)
    .values({
      id,
      userId,
      bucketId: bucket.id,
      title: titleFromFilename(filename),
      filename,
      objectKey: objectKeyFor(id, filename),
      contentType,
      size,
      status: DocumentStatus.PendingUpload,
    })
    .returning();
  return row;
}
