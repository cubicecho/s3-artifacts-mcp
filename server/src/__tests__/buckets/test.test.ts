import { describe, expect, it } from 'vitest';
import { BucketTestStep, blockingStep, runBucketTest } from '../../buckets/test.ts';
import { BUCKET_DEFAULTS } from '../../core/defaults.ts';
import type { Storage } from '../../storage/storage.ts';
import { createMemoryBackend, type MemoryOperation } from '../memory-storage.ts';

const ALL_STEPS = Object.values(BucketTestStep);

/** A bucket in a fresh pretend service, and the test run against it. */
function setUp() {
  const backend = createMemoryBackend();
  const bucket = backend.bucket('artifacts');
  const run = (storage: Storage = bucket, overrides = {}) => runBucketTest(storage, overrides, backend.fetch);
  return { backend, bucket, run };
}

/** Each step's outcome, as `ok`, `skipped` or the error code it failed with. */
function outcomes(result: Awaited<ReturnType<typeof runBucketTest>>) {
  return Object.fromEntries(
    result.steps.map((step) => [step.step, step.ok ? 'ok' : step.skipped ? 'skipped' : (step.errorCode ?? 'failed')]),
  );
}

describe('runBucketTest', () => {
  it('passes every step on a working bucket, and leaves no probe behind', async () => {
    const { bucket, run } = setUp();
    const result = await run();
    expect(result.ok).toBe(true);
    expect(result.shareLinkWarning).toBeNull();
    expect(result.steps.map((step) => step.step)).toEqual(ALL_STEPS);
    expect(result.steps.every((step) => step.ok && step.skipped === false && step.errorCode === null)).toBe(true);
    expect(bucket.objects.has(BUCKET_DEFAULTS.probeKey)).toBe(false);
  });

  it('stops at HeadBucket, naming the code, and skips everything after it', async () => {
    const { bucket, run } = setUp();
    bucket.failures.headBucket = 'NoSuchBucket';
    const result = await run();
    expect(result.ok).toBe(false);
    expect(outcomes(result)).toEqual({
      HEAD_BUCKET: 'NoSuchBucket',
      PUT_OBJECT: 'skipped',
      GET_OBJECT: 'skipped',
      SHARE_LINK: 'skipped',
      DELETE_OBJECT: 'skipped',
    });
    expect(blockingStep(result)).toMatchObject({ step: 'HEAD_BUCKET', errorCode: 'NoSuchBucket' });
  });

  it('stops at a refused write, with nothing to clean up', async () => {
    const { bucket, run } = setUp();
    bucket.failures.upload = 'AccessDenied';
    const result = await run();
    expect(outcomes(result)).toMatchObject({ HEAD_BUCKET: 'ok', PUT_OBJECT: 'AccessDenied', DELETE_OBJECT: 'skipped' });
    expect(result.ok).toBe(false);
  });

  it('still deletes the probe after a failed read', async () => {
    const { bucket, run } = setUp();
    bucket.failures.getStream = 'InternalError';
    const result = await run();
    expect(outcomes(result)).toEqual({
      HEAD_BUCKET: 'ok',
      PUT_OBJECT: 'ok',
      GET_OBJECT: 'InternalError',
      SHARE_LINK: 'skipped',
      DELETE_OBJECT: 'ok',
    });
    expect(result.ok).toBe(false);
    expect(bucket.objects.size).toBe(0);
  });

  it('fails a read that comes back with other bytes', async () => {
    const { bucket, run } = setUp();
    const tampering: Storage = {
      ...bucket,
      upload: (key, _body, options) => bucket.upload(key, 'something else', options),
    };
    const result = await run(tampering);
    expect(result.steps.find((step) => step.step === 'GET_OBJECT')).toMatchObject({
      ok: false,
      errorCode: null,
      message: expect.stringMatching(/came back different/),
    });
  });

  it.each<[MemoryOperation, string]>([['delete', 'AccessDenied']])(
    'refuses a bucket whose %s fails',
    async (operation, code) => {
      const { bucket, run } = setUp();
      bucket.failures[operation] = code;
      const result = await run();
      expect(result.ok).toBe(false);
      expect(blockingStep(result)).toMatchObject({ step: 'DELETE_OBJECT', errorCode: code });
    },
  );

  it('passes with a warning when the share link does not open from the server', async () => {
    const { bucket, run } = setUp();
    bucket.publicOrigin = 'https://s3.unreachable.test';
    const result = await run();
    expect(result.ok).toBe(true);
    expect(outcomes(result)).toMatchObject({ SHARE_LINK: 'ECONNREFUSED', DELETE_OBJECT: 'ok' });
    expect(result.shareLinkWarning).toMatch(/Share links may not open from a browser.*ECONNREFUSED/);
    expect(blockingStep(result)).toBeUndefined();
  });

  it('reads the code out of an S3 error document a share link answers with', async () => {
    const { backend, bucket } = setUp();
    const denied: typeof fetch = async () =>
      new Response('<?xml version="1.0"?><Error><Code>SignatureDoesNotMatch</Code></Error>', { status: 403 });
    const result = await runBucketTest(bucket, {}, denied);
    expect(result.ok).toBe(true);
    expect(outcomes(result).SHARE_LINK).toBe('SignatureDoesNotMatch');
    expect(backend.bucket('artifacts').objects.size).toBe(0);
  });

  it('skips what is left when the test runs out of time', async () => {
    const { bucket, run } = setUp();
    const stalling: Storage = { ...bucket, upload: () => new Promise(() => {}) };
    const result = await run(stalling, { testTimeoutMs: 50 });
    expect(result.ok).toBe(false);
    expect(outcomes(result)).toEqual({
      HEAD_BUCKET: 'ok',
      PUT_OBJECT: 'TimeoutError',
      GET_OBJECT: 'skipped',
      SHARE_LINK: 'skipped',
      DELETE_OBJECT: 'skipped',
    });
  });

  it('gives up on a share link that hangs, within its own budget, and still deletes the probe', async () => {
    const { bucket } = setUp();
    const hanging: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    const result = await runBucketTest(bucket, { testTimeoutMs: 1000, shareLinkTimeoutMs: 30 }, hanging);
    expect(result.ok).toBe(true);
    expect(outcomes(result)).toMatchObject({ SHARE_LINK: 'TimeoutError', DELETE_OBJECT: 'ok' });
  });
});
