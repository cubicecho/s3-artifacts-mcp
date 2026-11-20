import { DocumentStatus, documents, type NewDocument } from '@cubicecho/s3-artifacts-mcp-db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { lookup } from 'mrmime';
import type { Context } from '../core/context.ts';
import { BUCKET_DEFAULTS, SCAN_DEFAULTS, type ScanSettings } from '../core/defaults.ts';
import { badInput, ErrorCode, errorMessage, requireAuth, withCode } from '../core/errors.ts';
import { SecretUnreadableError } from '../core/secrets.ts';
import { describeStorageError, type ListedObject, type Storage } from '../storage/storage.ts';
import { SECRET_UNREADABLE_MESSAGE } from './bucket-storage.ts';
import { DEFAULT_CONTENT_TYPE, filenameSchema, reachableBucket, titleFromFilename } from './create.ts';

// Files already in a bucket, put there by something other than this app, becoming documents (D6).
// A scan lists the bucket and adds a `ready` row for each object no document points at yet. It
// never reads, moves or renames an object: the key stays where it is. The server never saw the
// bytes, so there is no checksum, and the type is guessed from the extension.

/** Control characters, which a header cannot carry and so a download could not be named after. */
const CONTROL_CHARACTERS = /\p{Cc}/u;
/** What separates a key's segments, as every S3 console draws folders from it. */
const KEY_SEPARATOR = '/';

/** A file a scan found and could not add, and why. */
export interface SkippedObject {
  key: string;
  reason: string;
}

/** What a scan did. */
export interface ScanResult {
  /** Files added as documents. */
  imported: number;
  /** Files a document already pointed at, including the app's own uploads. */
  alreadyListed: number;
  /** How many files could not be added. */
  skippedCount: number;
  /** The first of those, with why. */
  skipped: SkippedObject[];
  /** Whether the scan stopped at its limit with files left to look at. */
  truncated: boolean;
}

/** A file as the scan would add it, or why it cannot be. */
type Candidate = { row: NewDocument } | { skip: SkippedObject };

/**
 * Whether an object is not a file at all: a folder marker that a console made, or the connection test's probe
 * left behind by a test that could not delete it.
 *
 * @param key - The object's key.
 * @returns True when the scan passes over it without counting it.
 */
function isNotAFile(key: string): boolean {
  return key.endsWith(KEY_SEPARATOR) || key === BUCKET_DEFAULTS.probeKey;
}

/**
 * Builds the row for a file the scan found.
 *
 * @param userId - The bucket's owner.
 * @param bucketId - The bucket.
 * @param object - The object as listed.
 * @returns The row, or why it cannot be one.
 *
 * @remarks
 * The filename, which a download saves as, is the key's last segment. The title is the whole key without its
 * extension, so `2024/01/report.pdf` and `2024/02/report.pdf` read apart in a flat list.
 */
function candidateFor(userId: string, bucketId: string, object: ListedObject): Candidate {
  const { key } = object;
  if (CONTROL_CHARACTERS.test(key)) {
    return { skip: { key, reason: 'The key contains control characters.' } };
  }
  const parsed = filenameSchema.safeParse(key.slice(key.lastIndexOf(KEY_SEPARATOR) + 1));
  if (parsed.success === false) {
    return { skip: { key, reason: parsed.error.issues[0]?.message ?? 'The filename cannot be used.' } };
  }
  const filename = parsed.data;
  return {
    row: {
      userId,
      bucketId,
      title: titleFromFilename(key),
      filename,
      objectKey: key,
      contentType: lookup(filename) ?? DEFAULT_CONTENT_TYPE,
      size: object.size,
      sha256: null,
      status: DocumentStatus.Ready,
    },
  };
}

/**
 * The storage of a bucket about to be scanned.
 *
 * @param ctx - The request.
 * @param bucketId - The bucket, already checked to be the caller's.
 * @returns Its storage.
 * @throws BAD_USER_INPUT when its secret stopped decrypting after it was checked.
 */
async function scanStorage(ctx: Context, bucketId: string): Promise<Storage> {
  try {
    return await ctx.storage.get(bucketId);
  } catch (error) {
    if (error instanceof SecretUnreadableError) {
      throw badInput(SECRET_UNREADABLE_MESSAGE);
    }
    throw error;
  }
}

/**
 * The error for a bucket that would not be listed.
 *
 * @param bucketId - The bucket.
 * @param error - What the listing threw.
 * @param imported - How many files were added before it did.
 * @returns A STORAGE_ERROR naming the service's code.
 */
function listingRefused(bucketId: string, error: unknown, imported: number): Error {
  const { code } = describeStorageError(error);
  console.error(`[documents] could not list bucket ${bucketId}: ${errorMessage(error)}`);
  const added = imported === 0 ? '' : ` The ${imported} found before that were added.`;
  return withCode(
    `The bucket refused to list its files${code === null ? '' : ` (${code})`}. ` +
      `The access key needs permission to list the bucket.${added}`,
    ErrorCode.StorageError,
    { errorCode: code, imported },
  );
}

/**
 * Lists one of the caller's buckets and adds every file in it that is not a document yet.
 *
 * @param ctx - The request.
 * @param bucketId - The bucket as sent.
 * @param [settings] - The limits, over `SCAN_DEFAULTS`.
 * @returns What was added, already there, and skipped.
 * @throws NOT_FOUND for a bucket that is missing or someone else's; BAD_USER_INPUT when its secret no longer
 *   decrypts; STORAGE_ERROR when the bucket refuses to be listed. Files added before a refusal stay added.
 *
 * @remarks
 * Each page of the listing is checked against the bucket's documents and inserted on its own, so a scan holds
 * at most a page in memory. An insert that meets a key another scan just added skips it, through the unique
 * (bucket, key) index. Running a scan again is safe: it adds only what is new.
 */
export async function scanBucket(
  ctx: Context,
  bucketId: string,
  settings: Partial<ScanSettings> = {},
): Promise<ScanResult> {
  const userId = requireAuth(ctx);
  const { maxImports, skippedReported } = { ...SCAN_DEFAULTS, ...settings };
  const bucket = await reachableBucket(ctx, bucketId, 'scanned');
  const storage = await scanStorage(ctx, bucket.id);
  const result: ScanResult = { imported: 0, alreadyListed: 0, skippedCount: 0, skipped: [], truncated: false };

  const skip = (skipped: SkippedObject): void => {
    result.skippedCount += 1;
    if (result.skipped.length < skippedReported) {
      result.skipped.push(skipped);
    }
  };

  /** Adds one page's files. False once the limit is reached. */
  const importPage = async (page: ListedObject[]): Promise<boolean> => {
    const files = page.filter((object) => isNotAFile(object.key) === false);
    if (files.length === 0) {
      return true;
    }
    const known = await ctx.db
      .select({ objectKey: documents.objectKey })
      .from(documents)
      .where(
        and(
          eq(documents.bucketId, bucket.id),
          inArray(
            documents.objectKey,
            files.map((file) => file.key),
          ),
        ),
      );
    const knownKeys = new Set(known.map((row) => row.objectKey));
    const rows: NewDocument[] = [];
    for (const file of files) {
      if (knownKeys.has(file.key)) {
        result.alreadyListed += 1;
        continue;
      }
      if (result.imported + rows.length >= maxImports) {
        result.truncated = true;
        break;
      }
      const candidate = candidateFor(userId, bucket.id, file);
      if ('skip' in candidate) {
        skip(candidate.skip);
      } else {
        rows.push(candidate.row);
      }
    }
    if (rows.length > 0) {
      const inserted = await ctx.db
        .insert(documents)
        .values(rows)
        .onConflictDoNothing({ target: [documents.bucketId, documents.objectKey] })
        .returning({ id: documents.id });
      result.imported += inserted.length;
      // Another scan, a moment ahead, added the rest.
      result.alreadyListed += rows.length - inserted.length;
    }
    return result.truncated === false;
  };

  // Only the listing's own failures are the bucket's; a database error goes up as it is.
  const pages = storage.listObjects()[Symbol.asyncIterator]();
  for (;;) {
    let next: IteratorResult<ListedObject[]>;
    try {
      next = await pages.next();
    } catch (error) {
      throw listingRefused(bucket.id, error, result.imported);
    }
    if (next.done) {
      break;
    }
    if ((await importPage(next.value)) === false) {
      await pages.return?.();
      break;
    }
  }
  return result;
}
