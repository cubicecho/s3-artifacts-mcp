import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { bucketDocumentsPath } from '@/lib/routes';
import { MINIO_BUCKET } from './bucket-fixtures';
import { DocumentDetailsCard } from './document-details-card';
import { PDF_DOCUMENT } from './document-fixtures';

/** The facts about a document that are not its content. */

const meta = {
  title: 'Domain/DocumentDetailsCard',
  component: DocumentDetailsCard,
  args: { document: { ...PDF_DOCUMENT, bucket: MINIO_BUCKET } },
  parameters: { layout: 'padded' },
} satisfies Meta<typeof DocumentDetailsCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every fact, with the key and the checksum copyable and the bucket a link to its documents. */
export const Filled: Story = {
  play: async ({ canvasElement }) => {
    const card = within(canvasElement);
    await expect(card.getByRole('heading', { level: 2, name: 'Details' })).toBeInTheDocument();
    await expect(card.getByText('quarterly-report.pdf')).toBeInTheDocument();
    await expect(card.getByText('470.8 KB')).toBeInTheDocument();
    await expect(card.getByText('482,113 bytes')).toBeInTheDocument();
    await expect(card.getByRole('link', { name: 'Artifacts' })).toHaveAttribute(
      'href',
      bucketDocumentsPath(MINIO_BUCKET.slug),
    );
    await expect(card.getByRole('button', { name: 'Copy object key' })).toBeInTheDocument();
    await expect(card.getByRole('button', { name: 'Copy SHA-256' })).toBeInTheDocument();
  },
};

/** Before the upload has finished there is no checksum: a dash, and nothing to copy. */
export const NoChecksum: Story = {
  args: { document: { ...PDF_DOCUMENT, sha256: null, bucket: MINIO_BUCKET } },
  play: async ({ canvasElement }) => {
    const card = within(canvasElement);
    await expect(card.getByText('—')).toBeInTheDocument();
    await expect(card.queryByRole('button', { name: 'Copy SHA-256' })).not.toBeInTheDocument();
  },
};
