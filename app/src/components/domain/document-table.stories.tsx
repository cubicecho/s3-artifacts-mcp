import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { MINIO_BUCKET, S3_BUCKET } from './bucket-fixtures';
import { MARKDOWN_DOCUMENT, PDF_DOCUMENT } from './document-fixtures';
import { type DocumentRow, DocumentTable } from './document-table';
import { FINANCE_TAG, Q4_TAG } from './tag-fixtures';

/** The documents table on its own: a link, the tags and the facts on each row, and choosing rows. */

const ROWS: DocumentRow[] = [
  { document: { ...PDF_DOCUMENT, tags: [FINANCE_TAG, Q4_TAG] }, bucket: MINIO_BUCKET },
  { document: { ...MARKDOWN_DOCUMENT, tags: [] }, bucket: S3_BUCKET },
];

/**
 * The table as the page holds it: the choice is kept here, and every change is reported too.
 *
 * @param props - The rows, and what hears each change.
 * @returns The table.
 */
function Choosing({
  rows,
  onSelectedChange,
}: {
  rows: readonly DocumentRow[];
  onSelectedChange: (ids: Set<string>) => void;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  return (
    <DocumentTable
      rows={rows}
      selected={selected}
      onSelectedChange={(next) => {
        onSelectedChange(next);
        setSelected(next);
      }}
    />
  );
}

const meta = {
  title: 'Domain/DocumentTable',
  component: DocumentTable,
  args: { rows: ROWS, selected: new Set<string>(), onSelectedChange: fn() },
  render: (args) => <Choosing rows={args.rows} onSelectedChange={args.onSelectedChange} />,
} satisfies Meta<typeof DocumentTable>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Each row links to its document and shows its tags, its bucket, its type and its size. */
export const Filled: Story = {
  play: async ({ canvas }) => {
    const table = canvas.getByRole('table', { name: 'Documents' });
    const [, first, second] = within(table).getAllByRole('row');
    await expect(within(first as HTMLElement).getByRole('link', { name: PDF_DOCUMENT.title })).toBeVisible();
    await expect(
      within(first as HTMLElement).getByRole('list', { name: `Tags of ${PDF_DOCUMENT.title}` }),
    ).toBeVisible();
    await expect(within(second as HTMLElement).queryByRole('list')).not.toBeInTheDocument();
  },
};

/** A row's box chooses it; the header's chooses the rest, and then none. */
export const Chooses: Story = {
  play: async ({ args, canvas }) => {
    await userEvent.click(canvas.getByRole('checkbox', { name: `Choose ${PDF_DOCUMENT.title}` }));
    await expect(args.onSelectedChange).toHaveBeenLastCalledWith(new Set([PDF_DOCUMENT.id]));
    const all = canvas.getByRole('checkbox', { name: 'Choose every document shown' });
    await expect(all).toHaveAttribute('aria-checked', 'mixed');
    await userEvent.click(all);
    await expect(args.onSelectedChange).toHaveBeenLastCalledWith(new Set([PDF_DOCUMENT.id, MARKDOWN_DOCUMENT.id]));
    await userEvent.click(all);
    await expect(args.onSelectedChange).toHaveBeenLastCalledWith(new Set());
  },
};

/** Phone width: the tags, the type and the date step aside, and nothing scrolls sideways. */
export const Narrow: Story = {
  globals: { viewport: { value: 'mobile1' } },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByText('Tags', { selector: 'th' })).not.toBeVisible();
    await expect(canvas.getByRole('link', { name: PDF_DOCUMENT.title })).toBeVisible();
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};
