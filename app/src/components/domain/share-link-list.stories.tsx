import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import type { ShareLinkRowFragment } from '@/__generated__/graphql';
import { documentPath } from '@/lib/routes';
import { PDF_DOCUMENT } from './document-fixtures';
import { shareLinkFixture } from './share-link-fixtures';
import { ShareLinkList } from './share-link-list';

/** The rows on their own: one per state, each said in a word beside an icon, and what each row offers. */

/**
 * A row as the list's fragment has it.
 *
 * @param fields - What sets it apart.
 * @returns The row.
 */
function row(fields: Parameters<typeof shareLinkFixture>[1]): ShareLinkRowFragment {
  const link = shareLinkFixture(PDF_DOCUMENT, fields);
  return { ...link, document: { id: PDF_DOCUMENT.id, title: PDF_DOCUMENT.title } };
}

const LINKS = [
  row({ label: 'For Dana' }),
  row({ permission: 'view', state: 'expired', expiresAt: '2026-11-10T10:00:00.000Z' }),
  row({ label: 'Old draft', state: 'revoked', createdBy: 'mcp' }),
];

const meta = {
  title: 'Domain/ShareLinkList',
  component: ShareLinkList,
  args: { links: LINKS, onRemove: fn(), onCopyError: fn() },
} satisfies Meta<typeof ShareLinkList>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The row for a link, by its name. */
function rowOf(canvas: ReturnType<typeof within>, name: string) {
  const item = canvas.getAllByRole('listitem').find((entry: HTMLElement) => within(entry).queryByText(name) !== null);
  if (item === undefined) {
    throw new Error(`No row for ${name}`);
  }
  return within(item);
}

/** Each state as a word; only the active link can be copied, and a link with no label is named by permission. */
export const States: Story = {
  play: async ({ canvas }) => {
    await expect(rowOf(canvas, 'For Dana').getByText('Active')).toBeInTheDocument();
    await expect(rowOf(canvas, 'For Dana').getByRole('button', { name: 'Copy For Dana' })).toBeInTheDocument();
    await expect(rowOf(canvas, 'View link').getByText('Expired')).toBeInTheDocument();
    await expect(rowOf(canvas, 'View link').queryByRole('button', { name: /^Copy/ })).not.toBeInTheDocument();
    await expect(rowOf(canvas, 'Old draft').getByText('Revoked')).toBeInTheDocument();
    await expect(rowOf(canvas, 'Old draft').getByText(/Made by an MCP client/)).toBeInTheDocument();
    await expect(canvas.queryByRole('link', { name: /^Open/ })).not.toBeInTheDocument();
  },
};

/** With `showDocument`, each row names its document and links to it. */
export const WithDocuments: Story = {
  args: { showDocument: true },
  play: async ({ canvas }) => {
    const dana = rowOf(canvas, 'For Dana');
    await expect(dana.getByText(new RegExp(`^${PDF_DOCUMENT.title} · Download`))).toBeInTheDocument();
    await expect(dana.getByRole('link', { name: `Open ${PDF_DOCUMENT.title}` })).toHaveAttribute(
      'href',
      documentPath(PDF_DOCUMENT.id),
    );
  },
};

/** Remove from list confirms first, saying an active link keeps working, then hands the id on. */
export const Removes: Story = {
  play: async ({ args, canvas, canvasElement }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Remove For Dana from the list' }));
    const confirm = within(await within(canvasElement.ownerDocument.body).findByRole('alertdialog'));
    await expect(confirm.getByText(/keeps working until it expires/)).toBeInTheDocument();
    await userEvent.click(confirm.getByRole('button', { name: 'Remove from list' }));
    await waitFor(() => expect(args.onRemove).toHaveBeenCalledWith(LINKS[0]?.id));
  },
};

/** Phone width: each row's buttons fit, and nothing scrolls sideways. */
export const Narrow: Story = {
  args: { showDocument: true },
  globals: { viewport: { value: 'mobile1' } },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('button', { name: 'Copy For Dana' })).toBeVisible();
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};
