import {
  DocumentStatus,
  type ShareLink,
  type ShareLinkCreator,
  ShareLinkPermission,
  shareLinks,
} from '@cubicecho/s3-artifacts-mcp-db/schema';
import { z } from 'zod';
import { readAppSettings } from '../app-settings/app-settings.ts';
import type { Context } from '../core/context.ts';
import { SHARE_LINK_DEFAULTS } from '../core/defaults.ts';
import { conflict, ErrorCode, errorMessage, requireAuth, withCode } from '../core/errors.ts';
import { SecretPurpose } from '../core/secrets.ts';
import { parseOrThrow } from '../core/validation.ts';
import { SECONDS_PER_HOUR } from '../core/wire.ts';
import { bucketStorageFor } from '../documents/bucket-storage.ts';
import { ownDocument } from '../documents/rows.ts';
import { Disposition, describeStorageError } from '../storage/storage.ts';
import { expiryFrom, expiryHoursSchema } from './expiry.ts';

// Making a share link (D5): a GET presigned on the bucket's public endpoint, so whoever holds it fetches the file
// from the bucket itself and the app is not in the path. The URL is stored sealed, because it reads the file for
// anyone, and is opened again only for the owner (`ShareLink.url`). The owner makes links in the app; an MCP
// client will make them through the same function.

const { labelMaxLength } = SHARE_LINK_DEFAULTS;

/** How the bucket answers a link, by what it lets its holder do. */
const DISPOSITION_BY_PERMISSION: Readonly<Record<ShareLinkPermission, Disposition>> = Object.freeze({
  [ShareLinkPermission.View]: Disposition.Inline,
  [ShareLinkPermission.Download]: Disposition.Attachment,
});

/** A link's label: trimmed, and absent when blank. */
const labelSchema = z
  .string()
  .nullish()
  .transform((value) => value?.trim() ?? '')
  .pipe(z.string().max(labelMaxLength, `A label can be at most ${labelMaxLength} characters.`))
  .transform((value) => (value === '' ? null : value));

/** What a new share link is asked for. Anything left out takes the owner's default from `app_settings`. */
export interface ShareLinkInput {
  documentId: string;
  permission?: ShareLinkPermission | null;
  /** Whole hours, from `SHARE_LINK_DEFAULTS.minExpiryHours` to `maxExpiryHours`. */
  expiresInHours?: number | null;
  label?: string | null;
}

/** A share link just made: its row, and the URL in the clear, which only its maker sees now. */
export interface CreatedShareLink {
  row: ShareLink;
  url: string;
}

/**
 * Signs a share link for one of the caller's documents and keeps it, sealed.
 *
 * @param ctx - The request.
 * @param input - The document, and the permission, expiry and label asked for.
 * @param createdBy - Who is making it: the owner in the app, or an MCP client.
 * @param [now] - The moment it is made, from which it expires.
 * @returns The row and the URL.
 * @throws NOT_FOUND for a document that is missing or someone else's; CONFLICT for one still uploading;
 *   BAD_USER_INPUT for an expiry outside the bounds or not in whole hours, a label too long, or a bucket whose
 *   secret no longer decrypts; STORAGE_ERROR when the URL cannot be signed.
 */
export async function createShareLink(
  ctx: Context,
  input: ShareLinkInput,
  createdBy: ShareLinkCreator,
  now: Date = new Date(),
): Promise<CreatedShareLink> {
  const userId = requireAuth(ctx);
  const document = await ownDocument(ctx, input.documentId);
  if (document.status !== DocumentStatus.Ready) {
    throw conflict('The upload has not finished, so there is nothing to share yet.');
  }
  const settings = await readAppSettings(ctx.db, userId);
  const permission = input.permission ?? settings.defaultLinkPermission;
  const hours = parseOrThrow(expiryHoursSchema, input.expiresInHours ?? settings.defaultLinkExpiryHours);
  const label = parseOrThrow(labelSchema, input.label);
  const storage = await bucketStorageFor(ctx, document.bucketId);

  let url: string;
  try {
    url = await storage.presignGet(document.objectKey, {
      filename: document.filename,
      contentType: document.contentType,
      disposition: DISPOSITION_BY_PERMISSION[permission],
      expiresInSeconds: hours * SECONDS_PER_HOUR,
    });
  } catch (error) {
    const { code } = describeStorageError(error);
    console.error(`[share-links] could not sign a link for ${document.id}: ${errorMessage(error)}`);
    throw withCode(`The link could not be signed${code === null ? '' : ` (${code})`}.`, ErrorCode.StorageError, {
      errorCode: code,
    });
  }

  const [row] = await ctx.db
    .insert(shareLinks)
    .values({
      userId,
      documentId: document.id,
      label,
      permission,
      urlEnc: ctx.secrets.seal(url, SecretPurpose.ShareLinkUrl),
      objectKey: document.objectKey,
      expiresAt: expiryFrom(hours, now),
      createdBy,
    })
    .returning();
  return { row, url };
}
