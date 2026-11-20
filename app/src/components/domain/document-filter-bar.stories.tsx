import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent } from 'storybook/test';
import { TagMatch } from '@/lib/document-filters';
import { MINIO_BUCKET, S3_BUCKET } from './bucket-fixtures';
import { DocumentFilterBar } from './document-filter-bar';
import { FINANCE_TAG, MIXED_TAGS, Q4_TAG } from './tag-fixtures';

/** The documents list's filters on their own: nothing set, every filter set, and what each control hands back. */

const meta = {
  title: 'Domain/DocumentFilterBar',
  component: DocumentFilterBar,
  args: {
    filters: { bucket: null, tagIds: [], match: TagMatch.Any, title: '', type: null },
    buckets: [MINIO_BUCKET, S3_BUCKET],
    tags: MIXED_TAGS,
    types: [
      { value: 'application/pdf', label: 'PDF' },
      { value: 'text/markdown', label: 'Markdown' },
    ],
    onChange: fn(),
    onClear: fn(),
  },
} satisfies Meta<typeof DocumentFilterBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Nothing set: every control says "all", and there is nothing to clear. */
export const Empty: Story = {
  play: async ({ args, canvas }) => {
    await expect(canvas.getByRole('combobox', { name: 'Bucket' })).toHaveTextContent('All buckets');
    await expect(canvas.getByRole('combobox', { name: 'Type' })).toHaveTextContent('All types');
    await expect(canvas.getByRole('combobox', { name: 'Tags' })).toHaveTextContent('Any tags');
    await expect(canvas.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
    await userEvent.type(canvas.getByRole('searchbox', { name: 'Title' }), 'r');
    await expect(args.onChange).toHaveBeenCalledWith({ title: 'r' });
  },
};

/** Every filter set: two tags offer any or all, and Clear filters is there. */
export const Filled: Story = {
  args: {
    filters: {
      bucket: MINIO_BUCKET.slug,
      tagIds: [FINANCE_TAG.id, Q4_TAG.id],
      match: TagMatch.All,
      title: 'report',
      type: 'application/pdf',
    },
  },
  play: async ({ args, canvas }) => {
    await expect(canvas.getByRole('combobox', { name: 'Bucket' })).toHaveTextContent(MINIO_BUCKET.name);
    await expect(canvas.getByRole('combobox', { name: 'Type' })).toHaveTextContent('PDF');
    await expect(canvas.getByRole('searchbox', { name: 'Title' })).toHaveValue('report');
    await expect(canvas.getByRole('button', { name: 'All of them' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(canvas.getByRole('button', { name: 'Any of them' }));
    await expect(args.onChange).toHaveBeenCalledWith({ match: TagMatch.Any });
    await userEvent.click(canvas.getByRole('button', { name: 'Clear filters' }));
    await expect(args.onClear).toHaveBeenCalledOnce();
  },
};

/** Phone width: the controls stack, each the width of the screen, and nothing scrolls sideways. */
export const Narrow: Story = {
  globals: { viewport: { value: 'mobile1' } },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('combobox', { name: 'Tags' })).toBeVisible();
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};
