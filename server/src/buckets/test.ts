import { randomUUID } from 'node:crypto';
import { text } from 'node:stream/consumers';
import { BUCKET_DEFAULTS, type BucketSettings } from '../core/defaults.ts';
import { Disposition, describeStorageError, type Storage, xmlErrorCode } from '../storage/storage.ts';

// The connection test run by `testBucket` and before every save. Steps run in order, and a step
// that cannot run after an earlier failure is reported as skipped rather than left out, so the form
// can show the whole list. Only SHARE_LINK may fail and still let the bucket be saved: the server
// may not reach the public address that browsers can.

/** One step of the test, in the order they run. */
export const BucketTestStep = {
  HeadBucket: 'HEAD_BUCKET',
  PutObject: 'PUT_OBJECT',
  GetObject: 'GET_OBJECT',
  ShareLink: 'SHARE_LINK',
  DeleteObject: 'DELETE_OBJECT',
} as const;
/** One of the steps in `BucketTestStep`. */
export type BucketTestStep = (typeof BucketTestStep)[keyof typeof BucketTestStep];

/** How one step went. */
export interface BucketTestStepResult {
  step: BucketTestStep;
  ok: boolean;
  skipped: boolean;
  /** The service's error code, or a network one, when the step failed with one. */
  errorCode: string | null;
  message: string | null;
}

/** How the whole test went. */
export interface BucketTestResult {
  /** Whether every step but SHARE_LINK passed, which is what a save needs. */
  ok: boolean;
  steps: BucketTestStepResult[];
  /** Set when SHARE_LINK failed. */
  shareLinkWarning: string | null;
}

/** What the probe object is stored as. */
const PROBE_CONTENT_TYPE = 'text/plain';
/** What the deadline's error is called, which is the error code a timed-out step reports. */
const TIMEOUT_ERROR = 'TimeoutError';

/** A step that failed, with what the service said. */
interface StepFailure {
  errorCode: string | null;
  message: string;
}

/**
 * Runs a step against the test's deadline.
 *
 * @param work - The step.
 * @param deadline - Aborts when the test's time is up.
 * @param timeoutMs - The test's budget, for the message.
 * @returns Null when the step passed, or why it failed.
 */
async function attempt(
  work: () => Promise<void>,
  deadline: AbortSignal,
  timeoutMs: number,
): Promise<StepFailure | null> {
  const timedOut = new Promise<never>((_resolve, reject) => {
    const fail = () => {
      const error = new Error(`The test ran out of time after ${timeoutMs} ms.`);
      error.name = TIMEOUT_ERROR;
      reject(error);
    };
    if (deadline.aborted) {
      fail();
    }
    deadline.addEventListener('abort', fail, { once: true });
  });
  // Nothing else awaits it when the step wins the race.
  timedOut.catch(() => {});
  try {
    await Promise.race([work(), timedOut]);
    return null;
  } catch (error) {
    const { code, message } = describeStorageError(error);
    return { errorCode: code, message };
  }
}

/**
 * Opens a presigned URL from the server, as a browser following a share link would.
 *
 * @param url - The presigned GET.
 * @param expected - What the object holds.
 * @param fetchUrl - How to make the request.
 * @param signal - The test's deadline.
 * @throws With the service's error code as the name when the link does not answer with the object.
 */
async function openLink(url: string, expected: string, fetchUrl: typeof fetch, signal: AbortSignal): Promise<void> {
  const response = await fetchUrl(url, { signal });
  const body = await response.text();
  if (response.ok && body === expected) {
    return;
  }
  const error = new Error(
    response.ok ? 'The link answered, but not with the probe object.' : `The link answered HTTP ${response.status}.`,
  );
  error.name = xmlErrorCode(body) ?? `HTTP_${response.status}`;
  throw error;
}

/**
 * Tests a bucket: HeadBucket, then a probe object written, read back, opened through a share link
 * and deleted.
 *
 * @param storage - The bucket, saved or not.
 * @param overrides - The probe key, the time budget and the probe link's lifetime, over `BUCKET_DEFAULTS`.
 * @param fetchUrl - How the share link is opened. The global `fetch` unless a test hands in its own.
 * @returns Every step's outcome, whether the bucket can be saved, and the share-link warning.
 */
export async function runBucketTest(
  storage: Storage,
  overrides: Partial<
    Pick<BucketSettings, 'probeKey' | 'testTimeoutMs' | 'shareLinkTimeoutMs' | 'probeLinkTtlSeconds'>
  > = {},
  fetchUrl: typeof fetch = fetch,
): Promise<BucketTestResult> {
  const { probeKey, testTimeoutMs, shareLinkTimeoutMs, probeLinkTtlSeconds } = { ...BUCKET_DEFAULTS, ...overrides };
  const deadline = AbortSignal.timeout(testTimeoutMs);
  const probe = `s3-artifacts-mcp connection test ${randomUUID()}`;
  const outcomes = new Map<BucketTestStep, StepFailure | null>();

  const run = async (step: BucketTestStep, canRun: boolean, work: () => Promise<void>): Promise<void> => {
    if (canRun) {
      outcomes.set(step, await attempt(work, deadline, testTimeoutMs));
    }
  };
  const passed = (step: BucketTestStep): boolean => outcomes.has(step) && outcomes.get(step) === null;

  await run(BucketTestStep.HeadBucket, true, () => storage.headBucket());
  await run(BucketTestStep.PutObject, passed(BucketTestStep.HeadBucket), () =>
    storage.upload(probeKey, probe, { contentType: PROBE_CONTENT_TYPE, size: Buffer.byteLength(probe) }),
  );
  await run(BucketTestStep.GetObject, passed(BucketTestStep.PutObject), async () => {
    const body = await text(await storage.getStream(probeKey));
    if (body !== probe) {
      throw new Error('The probe object came back different from what was written.');
    }
  });
  await run(BucketTestStep.ShareLink, passed(BucketTestStep.GetObject), async () => {
    const url = await storage.presignGet(probeKey, {
      filename: probeKey,
      contentType: PROBE_CONTENT_TYPE,
      disposition: Disposition.Inline,
      expiresInSeconds: probeLinkTtlSeconds,
    });
    // A budget of its own, inside the test's, so an unreachable public address leaves time to delete the probe.
    await openLink(url, probe, fetchUrl, AbortSignal.any([deadline, AbortSignal.timeout(shareLinkTimeoutMs)]));
  });
  // Cleans up whenever the probe was written, even after a failed read.
  await run(BucketTestStep.DeleteObject, passed(BucketTestStep.PutObject), () => storage.delete([probeKey]));

  const steps = Object.values(BucketTestStep).map((step): BucketTestStepResult => {
    const skipped = outcomes.has(step) === false;
    const failure = outcomes.get(step) ?? null;
    return {
      step,
      ok: skipped === false && failure === null,
      skipped,
      errorCode: failure?.errorCode ?? null,
      message: failure?.message ?? null,
    };
  });
  const ok = steps.every((result) => result.ok || result.step === BucketTestStep.ShareLink);
  const shareLink = outcomes.get(BucketTestStep.ShareLink) ?? null;
  const shareLinkWarning =
    shareLink === null
      ? null
      : `Share links may not open from a browser: a link signed for the public endpoint failed (${shareLink.errorCode ?? 'no code'}: ${shareLink.message}).`;
  return { ok, steps, shareLinkWarning };
}

/**
 * The first step that stops a save, as a refusal names it.
 *
 * @param result - A test that did not pass.
 * @returns The failed or skipped step, or undefined when the test passed.
 */
export function blockingStep(result: BucketTestResult): BucketTestStepResult | undefined {
  return result.steps.find((step) => step.ok === false && step.step !== BucketTestStep.ShareLink);
}
