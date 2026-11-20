import { Readable } from 'node:stream';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { type BucketConnection, type Disposition, httpStatus, type Storage } from './storage.ts';

// One bucket on any S3-compatible service. Everything a client needs comes from the bucket's own
// row, so two buckets never share a client, a credential or an endpoint, whatever their provider.

/** The most keys one DeleteObjects call takes, on every S3-compatible service. */
const DELETE_BATCH_LIMIT = 1000;
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
 * Content-Disposition with the filename quoted safely, and a UTF-8 form for non-ASCII names.
 *
 * @param filename - The name to save as.
 * @param disposition - Inline or attachment.
 * @returns The header value.
 */
function contentDisposition(filename: string, disposition: Disposition): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
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

/**
 * Builds the storage for one bucket, over two clients.
 *
 * @param bucket - The bucket's row, or a form being tested: endpoints, region, bucket, access key and path style.
 * @param secretAccessKey - The access key's secret, already decrypted.
 * @returns The bucket's storage.
 *
 * @remarks
 * Presigned URLs are signed by a second client against `publicEndpoint`, because a signature
 * covers the host and a URL cannot be rewritten after signing. Signing makes no request, so that
 * client never has to reach its endpoint; it only has to be the host a browser will.
 */
export function createS3Storage(bucket: BucketConnection, secretAccessKey: string): Storage {
  const client = createClient(bucket.endpoint, bucket, secretAccessKey);
  const publicEndpoint = bucket.publicEndpoint ?? bucket.endpoint;
  const signer = publicEndpoint === bucket.endpoint ? client : createClient(publicEndpoint, bucket, secretAccessKey);
  const Bucket = bucket.bucket;

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
      // Bodies past a single PUT's limit (5 GiB) need lib-storage's multipart upload, which comes
      // with the upload route.
      await client.send(
        new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType, ContentLength: size }),
      );
    },

    async copy(fromKey, toKey) {
      const CopySource = `${Bucket}/${fromKey.split('/').map(encodeURIComponent).join('/')}`;
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
  };
}
