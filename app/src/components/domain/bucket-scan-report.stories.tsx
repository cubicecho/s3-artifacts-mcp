import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { SCAN_ADDED, SCAN_NOTHING_NEW } from './bucket-fixtures';
import { BucketScanReport } from './bucket-scan-report';

/** A bucket scan's report: running, refused, and what a finished one added, found listed and could not add. */

const meta = {
  title: 'Domain/BucketScanReport',
  component: BucketScanReport,
  args: { bucketName: 'Backups', scan: { running: false, result: SCAN_ADDED, failure: undefined } },
} satisfies Meta<typeof BucketScanReport>;

export default meta;
type Story = StoryObj<typeof meta>;

/** While it lists the bucket: a status, read out politely, not an error. */
export const Running: Story = {
  args: { scan: { running: true, result: null, failure: undefined } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('status')).toHaveTextContent('Scanning “Backups”…');
    await expect(canvas.queryByRole('alert')).not.toBeInTheDocument();
  },
};

/**
 * Files added, some listed already, and two that could not be: each named, with why, the control character
 * written out so the key can be found in the bucket.
 */
export const Added: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByText('Added 12 files from “Backups”')).toBeInTheDocument();
    await expect(canvas.getByText('3 files were listed already.')).toBeInTheDocument();
    await expect(canvas.getByText('2 files could not be added')).toBeInTheDocument();
    const skipped = within(canvas.getByRole('list', { name: 'Files not added' }));
    await expect(skipped.getAllByRole('listitem')).toHaveLength(2);
    await expect(skipped.getByText('"exports/bad\\nname.csv"')).toBeInTheDocument();
    await expect(skipped.getByText(/control characters/)).toBeInTheDocument();
  },
};

/** More skipped than the server names: the rest are counted on a last row. */
export const ManySkipped: Story = {
  args: {
    scan: { running: false, result: { ...SCAN_ADDED, skippedCount: 30 }, failure: undefined },
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('30 files could not be added')).toBeInTheDocument();
    await expect(canvas.getByText('And 28 more')).toBeInTheDocument();
  },
};

/** It stopped at its limit: the report says to scan again for the rest. */
export const StoppedAtTheLimit: Story = {
  args: {
    scan: {
      running: false,
      result: { ...SCAN_ADDED, imported: 5000, skippedCount: 0, skipped: [], truncated: true },
      failure: undefined,
    },
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('Added 5,000 files from “Backups”')).toBeInTheDocument();
    await expect(canvas.getByText(/Scan again to add the rest/)).toBeInTheDocument();
  },
};

/** An empty bucket: nothing new, and why. */
export const EmptyBucket: Story = {
  args: { scan: { running: false, result: SCAN_NOTHING_NEW, failure: undefined } },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('Nothing new in “Backups”')).toBeInTheDocument();
    await expect(canvas.getByText('The bucket holds no files.')).toBeInTheDocument();
  },
};

/** Everything was listed already: nothing new, and how many it looked at. */
export const AllListed: Story = {
  args: { scan: { running: false, result: { ...SCAN_NOTHING_NEW, alreadyListed: 1 }, failure: undefined } },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('Nothing new in “Backups”')).toBeInTheDocument();
    await expect(canvas.getByText('1 file was listed already.')).toBeInTheDocument();
  },
};

/** The bucket would not be listed: an alert with the server's reason. */
export const Refused: Story = {
  args: {
    scan: {
      running: false,
      result: null,
      failure:
        'The bucket refused to list its files (AccessDenied). The access key needs permission to list the bucket.',
    },
  },
  play: async ({ canvas }) => {
    const alert = canvas.getByRole('alert');
    await expect(alert).toHaveTextContent('Could not scan “Backups”');
    await expect(alert).toHaveTextContent(/AccessDenied/);
  },
};
