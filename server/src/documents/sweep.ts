import type { DB } from '@cubicecho/s3-artifacts-mcp-db';
import { DocumentStatus, documents } from '@cubicecho/s3-artifacts-mcp-db/schema';
import { and, eq, lt } from 'drizzle-orm';
import { UPLOAD_DEFAULTS, type UploadSettings } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import { MS_PER_SECOND, SECONDS_PER_MINUTE } from '../core/wire.ts';
import type { StorageRegistry } from '../storage/registry.ts';
import { deletePendingRow } from './rows.ts';

// Drops uploads that were started and never finished: a browser closed mid-upload, a PUT that was
// never sent. A failed PUT cleans up after itself, so what is left here is mostly rows whose bytes
// never started. Any object at the key goes too, in case a process died between the bucket and the
// database. The clock counts from the row's last change, which the upload route bumps when it starts
// streaming, so a long upload in progress is not swept from under itself.

/** What the sweeper works on. */
export interface SweepDeps {
  db: DB;
  /** Every bucket's storage. */
  storage: StorageRegistry;
}

/** A running sweeper. */
export interface UploadSweeper {
  /** Stops it. A sweep already running finishes. */
  stop(): void;
}

/**
 * Drops every `pending_upload` row older than the time limit, and any object at its key.
 *
 * @param deps - The database and the storage registry.
 * @param [overrides] - Settings that differ from `UPLOAD_DEFAULTS`. Only `pendingTtlMinutes` is read.
 * @param [now] - The time to measure age from.
 * @returns How many rows were dropped.
 */
export async function sweepPendingUploads(
  { db, storage }: SweepDeps,
  overrides: Partial<UploadSettings> = {},
  now: Date = new Date(),
): Promise<number> {
  const { pendingTtlMinutes } = { ...UPLOAD_DEFAULTS, ...overrides };
  const cutoff = new Date(now.getTime() - pendingTtlMinutes * SECONDS_PER_MINUTE * MS_PER_SECOND);
  const stale = await db
    .select({ id: documents.id, bucketId: documents.bucketId, objectKey: documents.objectKey })
    .from(documents)
    .where(and(eq(documents.status, DocumentStatus.PendingUpload), lt(documents.updatedAt, cutoff)));
  let dropped = 0;
  for (const { id, bucketId, objectKey } of stale) {
    try {
      const bucket = await storage.get(bucketId);
      await bucket.delete([objectKey]);
    } catch (error) {
      // The row goes anyway: a pending row is never shown as a document, and keeping it would retry forever.
      console.warn(`[sweeper] could not delete the object of ${id}: ${errorMessage(error)}`);
    }
    const isDropped = await deletePendingRow(db, id);
    if (isDropped) {
      dropped += 1;
    }
  }
  return dropped;
}

/**
 * Sweeps every `sweepIntervalMinutes`, until stopped. Only index.ts starts one.
 *
 * @param deps - The database and the storage registry.
 * @param [overrides] - Settings that differ from `UPLOAD_DEFAULTS`.
 * @returns The running sweeper.
 */
export function startUploadSweeper(deps: SweepDeps, overrides: Partial<UploadSettings> = {}): UploadSweeper {
  const settings = { ...UPLOAD_DEFAULTS, ...overrides };
  let isSweeping = false;
  const tick = async (): Promise<void> => {
    if (isSweeping) {
      return;
    }
    isSweeping = true;
    try {
      const dropped = await sweepPendingUploads(deps, settings);
      if (dropped > 0) {
        console.log(`[sweeper] dropped ${dropped} unfinished upload(s)`);
      }
    } catch (error) {
      console.error(`[sweeper] sweep failed: ${errorMessage(error)}`);
    } finally {
      isSweeping = false;
    }
  };
  const timer = setInterval(() => void tick(), settings.sweepIntervalMinutes * SECONDS_PER_MINUTE * MS_PER_SECOND);
  // The sweeper alone never keeps the process alive.
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
