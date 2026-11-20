import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { documentPath } from '@/lib/routes';
import { BucketTree } from './bucket-tree';

/**
 * The bucket tree on its own: buckets as folders, their documents flat beneath. Every bucket
 * starts shut, and only a press opens one.
 */

const ARTIFACTS = {
  id: 'b1',
  name: 'Artifacts',
  secretReadable: true,
  documents: [
    { id: 'd1', title: 'Quarterly report' },
    { id: 'd2', title: 'notes' },
    { id: 'd3', title: 'notes' },
    { id: 'd4', title: 'a/b split' },
  ],
};
const REPORTS = { id: 'b2', name: 'Reports', secretReadable: true, documents: [{ id: 'd5', title: 'Summary' }] };
const SCRATCH = { id: 'b3', name: 'Scratch', secretReadable: true, documents: [] };
const LOCKED = { id: 'b4', name: 'Backups', secretReadable: false, documents: [{ id: 'd6', title: 'dump' }] };

const meta = {
  title: 'Domain/BucketTree',
  component: BucketTree,
  args: { buckets: [ARTIFACTS, REPORTS, SCRATCH, LOCKED] },
  parameters: { layout: 'padded' },
  render: (args) => (
    <div className="w-80">
      <BucketTree {...args} />
    </div>
  ),
} satisfies Meta<typeof BucketTree>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The bucket rows, by their names. */
function bucketRow(canvasElement: HTMLElement, name: string) {
  return within(canvasElement).getByRole('button', { name: new RegExp(`^${name}`) });
}

/** First render: every bucket is shut, so no document is on screen. */
export const CollapsedFirstRender: Story = {
  play: async ({ canvas, canvasElement }) => {
    for (const name of ['Artifacts', 'Reports', 'Scratch', 'Backups']) {
      await expect(bucketRow(canvasElement, name)).toHaveAttribute('aria-expanded', 'false');
    }
    await expect(canvas.queryAllByRole('link')).toHaveLength(0);
    await expect(canvas.queryByText('Quarterly report')).not.toBeInTheDocument();
    // How many documents each holds, so a shut bucket still says what is in it.
    await expect(bucketRow(canvasElement, 'Artifacts')).toHaveTextContent('4');
  },
};

/** A press opens one bucket, and only that one; its documents are links to their pages. */
export const ExpandedAfterAClick: Story = {
  play: async ({ canvas, canvasElement }) => {
    await userEvent.click(bucketRow(canvasElement, 'Artifacts'));
    await expect(bucketRow(canvasElement, 'Artifacts')).toHaveAttribute('aria-expanded', 'true');
    await expect(bucketRow(canvasElement, 'Reports')).toHaveAttribute('aria-expanded', 'false');
    await expect(canvas.getByRole('link', { name: 'Quarterly report' })).toHaveAttribute('href', documentPath('d1'));
    // Two documents with one title are told apart; a `/` in a title nests nothing.
    await expect(canvas.getByRole('link', { name: 'notes' })).toHaveAttribute('href', documentPath('d2'));
    await expect(canvas.getByRole('link', { name: 'notes (2)' })).toHaveAttribute('href', documentPath('d3'));
    await expect(canvas.getByRole('link', { name: 'a∕b split' })).toBeVisible();
    await expect(canvas.queryByRole('link', { name: 'Summary' })).not.toBeInTheDocument();

    await userEvent.click(bucketRow(canvasElement, 'Artifacts'));
    await expect(canvas.queryByRole('link', { name: 'Quarterly report' })).not.toBeInTheDocument();
  },
};

/** An empty bucket opens onto a line that says so, which is not a link. */
export const EmptyBucket: Story = {
  play: async ({ canvas, canvasElement }) => {
    await userEvent.click(bucketRow(canvasElement, 'Scratch'));
    await expect(canvas.getByText('No documents yet')).toBeVisible();
    await expect(canvas.queryAllByRole('link')).toHaveLength(0);
    await expect(bucketRow(canvasElement, 'Scratch')).toHaveTextContent('0');
  },
};

/** A bucket whose secret no longer opens says so on its row. */
export const SecretUnreadable: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(bucketRow(canvasElement, 'Backups')).getByText('Secret unreadable')).toBeVisible();
  },
};

/**
 * The open document is marked, but its bucket is not opened for it: nothing opens on its own.
 * Opened by hand, the row says it is the current page.
 */
export const SelectedStaysShut: Story = {
  args: { selectedDocumentId: 'd5' },
  play: async ({ canvas, canvasElement }) => {
    await expect(bucketRow(canvasElement, 'Reports')).toHaveAttribute('aria-expanded', 'false');
    await expect(canvas.queryByRole('link', { name: 'Summary' })).not.toBeInTheDocument();
    await userEvent.click(bucketRow(canvasElement, 'Reports'));
    await expect(canvas.getByRole('link', { name: 'Summary' })).toHaveAttribute('aria-current', 'page');
  },
};
