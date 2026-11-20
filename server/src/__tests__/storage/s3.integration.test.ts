import { text } from 'node:stream/consumers';
import { describe, expect, it } from 'vitest';
import { runBucketTest } from '../../buckets/test.ts';
import { createS3Storage } from '../../storage/s3.ts';
import { Disposition } from '../../storage/storage.ts';

// Against a real S3-compatible service, which an in-memory storage cannot stand in for: signing,
// path style, the checksum settings and the share link's host. Skipped unless S3AM_IT_ENDPOINT is
// set, e.g. for the dev RustFS:
//
//   S3AM_IT_ENDPOINT=http://localhost:9010 S3AM_IT_BUCKET=artifacts \
//   S3AM_IT_ACCESS_KEY=s3am S3AM_IT_SECRET_KEY=s3am-dev-secret npx vitest run --project node s3.integration

const { S3AM_IT_ENDPOINT, S3AM_IT_BUCKET, S3AM_IT_ACCESS_KEY, S3AM_IT_SECRET_KEY, S3AM_IT_REGION } = process.env;
const isConfigured = (S3AM_IT_ENDPOINT ?? '') !== '';

describe.skipIf(isConfigured === false)('S3 storage against a real service', () => {
  const connection = {
    endpoint: S3AM_IT_ENDPOINT ?? null,
    publicEndpoint: null,
    region: S3AM_IT_REGION ?? 'us-east-1',
    bucket: S3AM_IT_BUCKET ?? 'artifacts',
    accessKeyId: S3AM_IT_ACCESS_KEY ?? '',
    forcePathStyle: true,
  };
  const storage = createS3Storage(connection, S3AM_IT_SECRET_KEY ?? '');

  it('passes the bucket test', async () => {
    const result = await runBucketTest(storage);
    expect(result.steps.filter((step) => step.ok === false)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('fails HeadBucket with a wrong secret, naming the status', async () => {
    const result = await runBucketTest(createS3Storage(connection, 'not-the-secret'));
    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({ step: 'HEAD_BUCKET', ok: false });
    expect(result.steps[0].errorCode).toMatch(/^(HTTP_403|Forbidden|AccessDenied|SignatureDoesNotMatch)$/);
  });

  it('uploads, heads, ranges, copies, shares and deletes', async () => {
    const key = `.s3am-it-${Date.now()}`;
    const copy = `${key}-copy`;
    await storage.upload(key, 'hello, bucket', { contentType: 'text/plain', size: 13 });
    expect(await storage.head(key)).toEqual({ size: 13, contentType: 'text/plain' });
    expect(await text(await storage.getStream(key, { first: 7, last: 12 }))).toBe('bucket');
    await storage.copy(key, copy);
    const url = await storage.presignGet(copy, {
      filename: 'hello.txt',
      contentType: 'text/plain',
      disposition: Disposition.Attachment,
      expiresInSeconds: 60,
    });
    const response = await fetch(url);
    expect(await response.text()).toBe('hello, bucket');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="hello.txt"/);
    await storage.delete([key, copy]);
    expect(await storage.head(key)).toBeNull();
    expect(await storage.head(copy)).toBeNull();
  });
});
