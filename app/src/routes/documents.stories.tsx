import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { ROUTES } from '@/lib/routes';
import { DocumentsRoute } from './documents';
import { settingsLink } from './settings';

/**
 * The documents page before any bucket exists: nowhere to upload to, so it says so and links to
 * Settings → Buckets, where they are added.
 */

/** Bounded height, because `PageLayout` is a sticky chassis that scrolls its own body. */
function Framed() {
  return (
    <div className="h-screen">
      <DocumentsRoute />
    </div>
  );
}

const meta = {
  title: 'Routes/Documents',
  component: DocumentsRoute,
  render: () => <Framed />,
  parameters: { layout: 'fullscreen', router: { initialEntries: [ROUTES.documents] } },
} satisfies Meta<typeof DocumentsRoute>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No buckets yet: the empty state is the page's body, and its one action goes to Settings → Buckets. */
export const NoBuckets: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('heading', { level: 1, name: 'Documents' })).toBeInTheDocument();
    await expect(canvas.getByRole('heading', { level: 2, name: 'No buckets yet' })).toBeVisible();
    await expect(canvas.getByText(/Backblaze B2/)).toBeInTheDocument();
    await expect(canvas.getByRole('link', { name: 'Add a bucket' })).toHaveAttribute('href', settingsLink('buckets'));
  },
};

/** At phone width the empty state still fits, and nothing pushes the page sideways. */
export const NoBucketsNarrow: Story = {
  globals: { viewport: { value: 'mobile1' } },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('link', { name: 'Add a bucket' })).toBeVisible();
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};
