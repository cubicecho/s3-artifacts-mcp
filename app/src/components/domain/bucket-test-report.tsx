import { BucketTestStep } from '@/__generated__/graphql';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { Alert } from '@/components/ui/alert';
import { CircleAlert, CircleCheck, CircleQuestionMark, TriangleAlert } from '@/components/ui/icons';
import type { SlotNode } from '@/lib/utils';

/** One step of a connection test, as `testBucket` answers it. */
export interface BucketTestStepOutcome {
  step: BucketTestStep;
  ok: boolean;
  /** Never ran, because an earlier step failed. */
  skipped: boolean;
  /** The S3 error code, when the service gave one. */
  errorCode: string | null;
  message: string | null;
}

/** A whole connection test, as `testBucket` answers it. */
export interface BucketTestOutcome {
  /** Whether the bucket can be saved. A failed share-link step leaves it true. */
  ok: boolean;
  steps: readonly BucketTestStepOutcome[];
  /** Set when a browser may not reach a share link on the public endpoint. */
  shareLinkWarning: string | null;
}

/** What each step is called in the report. */
const STEP_LABELS: Readonly<Record<BucketTestStep, string>> = Object.freeze({
  [BucketTestStep.HeadBucket]: 'Reach the bucket',
  [BucketTestStep.PutObject]: 'Write a probe object',
  [BucketTestStep.GetObject]: 'Read it back',
  [BucketTestStep.DeleteObject]: 'Delete it',
  [BucketTestStep.ShareLink]: 'Open a share link to it',
});

/** How a step went, which picks its word and its icon. */
const Verdict = { Passed: 'Passed', Failed: 'Failed', Warning: 'Warning', Skipped: 'Skipped' } as const;
type Verdict = (typeof Verdict)[keyof typeof Verdict];

/**
 * How a step went. A failed share link is only a warning: the bucket still works.
 *
 * @param step - The step.
 * @returns Its verdict.
 */
function verdictOf(step: BucketTestStepOutcome): Verdict {
  if (step.skipped) {
    return Verdict.Skipped;
  }
  if (step.ok) {
    return Verdict.Passed;
  }
  return step.step === BucketTestStep.ShareLink ? Verdict.Warning : Verdict.Failed;
}

/** The glyph in front of a step, inked by its verdict, so the state is a word, an icon and a colour. */
const VERDICT_ICONS: Readonly<Record<Verdict, SlotNode>> = Object.freeze({
  [Verdict.Passed]: <CircleCheck aria-hidden className="size-4 text-positive" />,
  [Verdict.Failed]: <CircleAlert aria-hidden className="size-4 text-negative" />,
  [Verdict.Warning]: <TriangleAlert aria-hidden className="size-4 text-warning" />,
  [Verdict.Skipped]: <CircleQuestionMark aria-hidden className="size-4 text-foreground/60" />,
});

/**
 * The line under a step that did not pass: the S3 error code and what the service said.
 *
 * @param step - The step.
 * @returns The line, or nothing for a step with nothing to say.
 */
function detailOf(step: BucketTestStepOutcome): string | undefined {
  const parts = [step.errorCode, step.message].filter(Boolean);
  return parts.length > 0 ? parts.join(': ') : undefined;
}

interface BucketTestReportProps {
  outcome: BucketTestOutcome;
}

/**
 * The result of a connection test: a summary, then each step with how it went and, for one that
 * did not pass, the S3 error code and message. A share link that would not open is a warning,
 * because the bucket still works and saving it is not refused for that.
 *
 * @param props - The test's outcome.
 * @returns The report.
 */
export function BucketTestReport({ outcome }: BucketTestReportProps) {
  const failed = outcome.steps.find((step) => verdictOf(step) === Verdict.Failed);

  let summary = (
    <Alert
      variant="info"
      iconSlot={<CircleCheck />}
      title="Connection works"
      description="The bucket answered, a probe object was written, read back and deleted, and a share link to it opened."
    />
  );
  if (outcome.ok === false) {
    summary = (
      <Alert
        variant="destructive"
        title={failed ? `Failed: ${STEP_LABELS[failed.step].toLowerCase()}` : 'The test failed'}
        description={failed ? detailOf(failed) : undefined}
      />
    );
  } else if (outcome.shareLinkWarning) {
    summary = (
      <Alert variant="warning" title="Works, but share links may not open" description={outcome.shareLinkWarning} />
    );
  }

  return (
    <section aria-label="Connection test" className="grid gap-2">
      {summary}
      <List
        label="Test steps"
        contentSlot={outcome.steps.map((step) => {
          const verdict = verdictOf(step);
          return (
            <ListItem
              key={step.step}
              leadingSlot={VERDICT_ICONS[verdict]}
              title={STEP_LABELS[step.step]}
              description={verdict === Verdict.Failed || verdict === Verdict.Warning ? detailOf(step) : undefined}
              meta={verdict}
            />
          );
        })}
      />
    </section>
  );
}
