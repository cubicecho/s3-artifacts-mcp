import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { TEST_FAILED, TEST_PASSED, TEST_WARNED } from './bucket-fixtures';
import { BucketTestReport } from './bucket-test-report';

/** A connection test's report in its three outcomes: passed, failed at a step, and passed with a warning. */

const meta = {
  title: 'Domain/BucketTestReport',
  component: BucketTestReport,
  args: { outcome: TEST_PASSED },
} satisfies Meta<typeof BucketTestReport>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every step passed. Each says so in words, not only in green. */
export const Passed: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByText('Connection works')).toBeInTheDocument();
    await expect(canvas.getAllByText('Passed')).toHaveLength(TEST_PASSED.steps.length);
    await expect(canvas.queryByRole('alert')).not.toBeInTheDocument();
  },
};

/** Failed at the first step: the S3 error code and message, and the rest skipped. */
export const Failed: Story = {
  args: { outcome: TEST_FAILED },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('alert')).toHaveTextContent('Failed: reach the bucket');
    await expect(canvas.getByRole('alert')).toHaveTextContent(/SignatureDoesNotMatch: The request signature/);
    await expect(canvas.getAllByText('Skipped')).toHaveLength(TEST_FAILED.steps.length - 1);
  },
};

/** The bucket works, but the share link would not open from the server: a warning, not a failure. */
export const ShareLinkWarning: Story = {
  args: { outcome: TEST_WARNED },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('Works, but share links may not open')).toBeInTheDocument();
    await expect(canvas.getByText('Warning')).toBeInTheDocument();
    await expect(canvas.getByText(/ENOTFOUND files.example.com/)).toBeInTheDocument();
    await expect(canvas.queryByRole('alert')).not.toBeInTheDocument();
  },
};
