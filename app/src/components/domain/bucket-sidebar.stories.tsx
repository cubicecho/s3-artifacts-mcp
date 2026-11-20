import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Sidebar } from '@/components/sidebar';
import { documentPath } from '@/lib/routes';
import { settingsLink } from '@/lib/settings-tabs';
import { MINIO_BUCKET, S3_BUCKET } from './bucket-fixtures';
import { BucketSidebarSection } from './bucket-sidebar';
import { documentServer, MARKDOWN_DOCUMENT, MIXED_DOCUMENTS, PDF_DOCUMENT } from './document-fixtures';

/**
 * The tree as the sidebar holds it, against a mock server built from the real SDL: the loading,
 * failed, empty and filled rungs, and the open document marked without its bucket opened.
 */

const meta = {
  title: 'Domain/BucketSidebarSection',
  component: BucketSidebarSection,
  parameters: {
    layout: 'fullscreen',
    apolloClient: { resolvers: documentServer([MINIO_BUCKET, S3_BUCKET], MIXED_DOCUMENTS).resolvers },
  },
  render: () => (
    <div className="h-screen">
      <Sidebar className="w-80" contentSlot={<BucketSidebarSection />} />
    </div>
  ),
} satisfies Meta<typeof BucketSidebarSection>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Before the answer lands: placeholder rows, never "no buckets". */
export const Loading: Story = {
  parameters: {
    apolloClient: { resolvers: documentServer([MINIO_BUCKET], MIXED_DOCUMENTS).resolvers, delay: 100_000 },
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('status')).toHaveAccessibleName('Loading');
    await expect(canvas.queryByText(/No buckets yet/)).not.toBeInTheDocument();
  },
};

/** The server failed: two lines and a retry, small enough for the rail. */
export const Failed: Story = {
  parameters: {
    apolloClient: { resolvers: documentServer([], [], { failBuckets: 'The database is not answering' }).resolvers },
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText(/Could not load your buckets/)).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    await expect(canvas.queryByText(/No buckets yet/)).not.toBeInTheDocument();
  },
};

/** No buckets: one line, and the way to add one. */
export const Empty: Story = {
  parameters: { apolloClient: { resolvers: documentServer([]).resolvers } },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText(/No buckets yet/)).toBeInTheDocument();
    await expect(canvas.getByRole('link', { name: 'Add one' })).toHaveAttribute('href', settingsLink('buckets'));
  },
};

/** Buckets by name, every one shut on the first render. */
export const Filled: Story = {
  play: async ({ canvas }) => {
    const tree = await canvas.findByRole('list', { name: 'Buckets and documents' });
    const rows = within(tree).getAllByRole('button');
    await expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^Artifacts/),
      expect.stringMatching(/^Reports/),
    ]);
    for (const row of rows) {
      await expect(row).toHaveAttribute('aria-expanded', 'false');
    }
    await expect(within(tree).queryAllByRole('link')).toHaveLength(0);
  },
};

/**
 * On a document's page the tree marks it, and leaves its bucket shut: opened by hand, the row is
 * the current page.
 */
export const OnADocumentPage: Story = {
  parameters: { router: { initialEntries: [documentPath(MARKDOWN_DOCUMENT.id)] } },
  play: async ({ canvas }) => {
    const tree = within(await canvas.findByRole('list', { name: 'Buckets and documents' }));
    const reports = tree.getByRole('button', { name: /^Reports/ });
    await expect(reports).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(reports);
    await expect(tree.getByRole('link', { name: MARKDOWN_DOCUMENT.title })).toHaveAttribute('aria-current', 'page');
    await expect(tree.queryByRole('link', { name: PDF_DOCUMENT.title })).not.toBeInTheDocument();
  },
};
