import { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NotFound,
  PutObjectCommand,
  S3Client,
  UploadPartCopyCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { COPY_DEFAULTS, type CopySettings, UPLOAD_DEFAULTS } from '../core/defaults.ts';
import { type BucketConnection, contentDisposition, httpStatus, type Storage } from './storage.ts';

// One bucket on any S3-compatible service. Everything a client needs comes from the bucket's own
// row, so two buckets never share a client, a credential or an endpoint, whatever their provider.

/** The most keys one DeleteObjects call takes, on every S3-compatible service. */
const DELETE_BATCH_LIMIT = 1000;
/**
 * The headers a presigned PUT signs. The presigner leaves `content-type` unsigned by default, and `content-length`
 * is only signed when asked, so without this any type and any size would be accepted.
 */
const PUT_SIGNED_HEADERS: ReadonlySet<string> = new Set(['content-type', 'content-length']);
/** The status a HEAD answers for a key with nothing at it, which the SDK cannot name from a body. */
const HTTP_NOT_FOUND = 404;

/**
 * Builds a client for one endpoint of one bucket.
 *
 * @param endpoint - The address to send to, or null for AWS's regional default.
 * @param bucket - The region, path style and access key.
 * @param secretAccessKey - The key's secret.
 * @returns The client.
 */
function createClient(endpoint: string | null, bucket: BucketConnection, secretAccessKey: string): S3Client {
  return new S3Client({
    endpoint: endpoint ?? undefined,
    region: bucket.region,
    credentials: { accessKeyId: bucket.accessKeyId, secretAccessKey },
    forcePathStyle: bucket.forcePathStyle,
    // SDK v3 (3.729 on, and this one) adds CRC32 checksums to every PUT and validates them on
    // every GET by default. Backblaze B2 and older MinIO releases refuse the headers, and a
    // presigned PUT would carry the checksum of an empty body. Only send one when an operation
    // requires it.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

/**
 * Narrows a GetObject body to the stream it is under Node.
 *
 * @param body - `GetObjectCommandOutput.Body`, which the SDK types for every runtime at once.
 * @returns The body as a Node stream.
 * @throws When the object came back with no body, or one that is not a Node stream.
 */
function bodyStream(body: unknown): Readable {
  if (body instanceof Readable) {
    return body;
  }
  throw new Error('The bucket returned an object with no readable body.');
}

/**
 * Whether a HEAD failed only because nothing is at the key.
 *
 * @param error - What the HEAD threw.
 * @returns True for a 404.
 */
function isMissingObject(error: unknown): boolean {
  if (error instanceof NotFound) {
    return true;
  }
  return error instanceof Error && httpStatus(error) === HTTP_NOT_FOUND;
}

/** One part of a copy in parts: its number, from 1, and its bytes as a `CopySourceRange`. */
interface CopyPart {
  partNumber: number;
  range: string;
}

/**
 * Splits an object into the parts a copy in parts sends.
 *
 * @param size - The object's length in bytes.
 * @param partSize - Each part's length in bytes; the last may be shorter.
 * @returns The parts, in order.
 */
function copyParts(size: number, partSize: number): CopyPart[] {
  const parts: CopyPart[] = [];
  for (let first = 0; first < size; first += partSize) {
    const last = Math.min(first + partSize, size) - 1;
    parts.push({ partNumber: parts.length + 1, range: `bytes=${first}-${last}` });
  }
  return parts;
}

/**
 * Builds the storage for one bucket, over two clients.
 *
 * @param bucket - The bucket's row, or a form being tested: endpoints, region, bucket, access key and path style.
 * @param secretAccessKey - The access key's secret, already decrypted.
 * @param [copyOverrides] - Copy settings that differ from `COPY_DEFAULTS`, so a test can copy in parts.
 * @returns The bucket's storage.
 *
 * @remarks
 * Presigned URLs are signed by a second client against `publicEndpoint`, because a signature
 * covers the host and a URL cannot be rewritten after signing. Signing makes no request, so that
 * client never has to reach its endpoint; it only has to be the host a browser will.
 */
export function createS3Storage(
  bucket: BucketConnection,
  secretAccessKey: string,
  copyOverrides: Partial<CopySettings> = {},
): Storage {
  const { maxSingleCopyBytes, copyPartSizeBytes, copyPartQueueSize } = { ...COPY_DEFAULTS, ...copyOverrides };
  const client = createClient(bucket.endpoint, bucket, secretAccessKey);
  const publicEndpoint = bucket.publicEndpoint ?? bucket.endpoint;
  const signer = publicEndpoint === bucket.endpoint ? client : createClient(publicEndpoint, bucket, secretAccessKey);
  const Bucket = bucket.bucket;

  /**
   * Copies an object past CopyObject's limit as a multipart upload of `UploadPartCopy` parts, a few at a time.
   *
   * @param CopySource - The source, as `bucket/key`, encoded.
   * @param toKey - Where the copy goes.
   * @param size - The source's length in bytes.
   * @param contentType - The source's type, which a multipart upload does not copy by itself.
   */
  const copyInParts = async (
    CopySource: string,
    toKey: string,
    size: number,
    contentType: string | null,
  ): Promise<void> => {
    const { UploadId } = await client.send(
      new CreateMultipartUploadCommand({ Bucket, Key: toKey, ContentType: contentType ?? undefined }),
    );
    try {
      const pending = copyParts(size, copyPartSizeBytes);
      const done: { PartNumber: number; ETag: string | undefined }[] = [];
      const worker = async (): Promise<void> => {
        for (let part = pending.shift(); part !== undefined; part = pending.shift()) {
          const { CopyPartResult } = await client.send(
            new UploadPartCopyCommand({
              Bucket,
              Key: toKey,
              UploadId,
              PartNumber: part.partNumber,
              CopySource,
              CopySourceRange: part.range,
            }),
          );
          done.push({ PartNumber: part.partNumber, ETag: CopyPartResult?.ETag });
        }
      };
      await Promise.all(Array.from({ length: copyPartQueueSize }, worker));
      const Parts = done.sort((a, b) => a.PartNumber - b.PartNumber);
      await client.send(
        new CompleteMultipartUploadCommand({ Bucket, Key: toKey, UploadId, MultipartUpload: { Parts } }),
      );
    } catch (error) {
      await client.send(new AbortMultipartUploadCommand({ Bucket, Key: toKey, UploadId })).catch(() => undefined);
      throw error;
    }
  };

  return {
    async headBucket() {
      await client.send(new HeadBucketCommand({ Bucket }));
    },

    async head(key) {
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { size: result.ContentLength ?? 0, contentType: result.ContentType ?? null };
      } catch (error) {
        if (isMissingObject(error)) {
          return null;
        }
        throw error;
      }
    },

    async getStream(key, range) {
      const Range = range === undefined ? undefined : `bytes=${range.first}-${range.last}`;
      const result = await client.send(new GetObjectCommand({ Bucket, Key: key, Range }));
      return bodyStream(result.Body);
    },

    async upload(key, body, { contentType, size }) {
      // A single PUT with the length declared, which streams a Readable without buffering it.
      // Anything a person uploads goes through `uploadStream` instead.
      await client.send(
        new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType, ContentLength: size }),
      );
    },

    async uploadStream(key, body, { contentType, signal }) {
      // Destroying the body, rather than `Upload.abort()`, is what makes an abort wait for the
      // multipart upload to be aborted at the service: `abort()` rejects `done()` at once and
      // leaves the AbortMultipartUpload running behind it.
      const onAbort = (): void => {
        body.destroy(signal?.reason instanceof Error ? signal.reason : new Error('The upload was aborted.'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        if (signal?.aborted) {
          onAbort();
        }
        // The client's WHEN_REQUIRED checksum setting also reaches lib-storage: it adds no
        // ChecksumAlgorithm to CreateMultipartUpload, and each part is a plain UploadPart.
        const upload = new Upload({
          client,
          params: { Bucket, Key: key, Body: body, ContentType: contentType },
          partSize: UPLOAD_DEFAULTS.partSizeBytes,
          queueSize: UPLOAD_DEFAULTS.partQueueSize,
          leavePartsOnError: false,
        });
        await upload.done();
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },

    async *listObjects() {
      let ContinuationToken: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket, ContinuationToken }));
        yield (page.Contents ?? []).flatMap((object) =>
          object.Key === undefined ? [] : [{ key: object.Key, size: object.Size ?? 0 }],
        );
        ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (ContinuationToken !== undefined);
    },

    async copy(fromKey, toKey) {
      const CopySource = `${Bucket}/${fromKey.split('/').map(encodeURIComponent).join('/')}`;
      const source = await client.send(new HeadObjectCommand({ Bucket, Key: fromKey }));
      const size = source.ContentLength ?? 0;
      if (size > maxSingleCopyBytes) {
        await copyInParts(CopySource, toKey, size, source.ContentType ?? null);
        return;
      }
      await client.send(new CopyObjectCommand({ Bucket, Key: toKey, CopySource }));
    },

    async delete(keys) {
      // One key is a plain DeleteObject. DeleteObjects requires a body checksum, and the SDK now
      // sends CRC32 where some services (B2 among them) still expect Content-MD5.
      if (keys.length === 1) {
        await client.send(new DeleteObjectCommand({ Bucket, Key: keys[0] }));
        return;
      }
      for (let start = 0; start < keys.length; start += DELETE_BATCH_LIMIT) {
        const batch = keys.slice(start, start + DELETE_BATCH_LIMIT);
        await client.send(
          new DeleteObjectsCommand({ Bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }),
        );
      }
    },

    presignGet(key, { filename, contentType, disposition, expiresInSeconds }) {
      return getSignedUrl(
        signer,
        new GetObjectCommand({
          Bucket,
          Key: key,
          ResponseContentType: contentType,
          ResponseContentDisposition: contentDisposition(filename, disposition),
        }),
        { expiresIn: expiresInSeconds },
      );
    },

    presignPut(key, { contentType, size, expiresInSeconds }) {
      return getSignedUrl(
        signer,
        new PutObjectCommand({ Bucket, Key: key, ContentType: contentType, ContentLength: size }),
        { expiresIn: expiresInSeconds, signableHeaders: new Set(PUT_SIGNED_HEADERS) },
      );
    },
  };
}
