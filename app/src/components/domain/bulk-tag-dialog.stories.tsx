import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ComponentProps, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { BulkTagDialog } from './bulk-tag-dialog';
import { DRAFT_TAG, FINANCE_TAG, MIXED_TAGS } from './tag-fixtures';

/** Tagging chosen documents at once: tags to add and to remove, in one save, and what it refuses. */

/**
 * The dialog as a page mounts it: it goes away when it asks to, so a story that ends closed leaves nothing open.
 *
 * @param args - The story's args.
 * @returns The dialog, until it closes.
 */
function Closing(args: ComponentProps<typeof BulkTagDialog>) {
  const [open, setOpen] = useState(true);
  return open ? (
    <BulkTagDialog
      {...args}
      onClose={() => {
        args.onClose();
        setOpen(false);
      }}
    />
  ) : null;
}

/**
 * Cancels the dialog, throwing away what was typed, and waits for it to go.
 *
 * @param canvasElement - The story's root.
 */
async function cancel(canvasElement: HTMLElement) {
  const body = within(canvasElement.ownerDocument.body);
  await userEvent.click(body.getByRole('button', { name: 'Cancel' }));
  const discard = await body.findByRole('button', { name: 'Discard' });
  await userEvent.click(discard);
  await waitFor(() => expect(body.queryByRole('dialog')).toBeNull());
}

const meta = {
  title: 'Domain/BulkTagDialog',
  component: BulkTagDialog,
  args: { count: 3, tags: MIXED_TAGS, onSave: fn(async () => undefined), onClose: fn() },
  render: (args) => <Closing {...args} />,
} satisfies Meta<typeof BulkTagDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The dialog, in the page's portal, once it is showing.
 *
 * @param canvasElement - The story's root.
 * @returns Queries within it.
 */
async function dialogOf(canvasElement: HTMLElement) {
  const dialog = await within(canvasElement.ownerDocument.body).findByRole('dialog', { name: 'Tag 3 documents' });
  await waitFor(() => expect(dialog).toBeVisible());
  return within(dialog);
}

/**
 * Picks a tag in one of the two fields, and closes its menu again.
 *
 * @param canvasElement - The story's root.
 * @param field - "Add" or "Remove".
 * @param tag - The tag's name.
 */
async function pick(canvasElement: HTMLElement, field: string, tag: string) {
  const body = within(canvasElement.ownerDocument.body);
  await userEvent.click(body.getByRole('combobox', { name: field }));
  await userEvent.click(await body.findByRole('option', { name: tag }));
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(body.queryByRole('dialog', { name: `Tags to ${field.toLowerCase()}` })).toBeNull());
}

/** One tag on, one tag off, in one save. */
export const AddsAndRemoves: Story = {
  play: async ({ args, canvasElement }) => {
    const dialog = await dialogOf(canvasElement);
    await pick(canvasElement, 'Add', FINANCE_TAG.name);
    await pick(canvasElement, 'Remove', DRAFT_TAG.name);
    await userEvent.click(dialog.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(args.onSave).toHaveBeenCalledWith({ add: [FINANCE_TAG.id], remove: [DRAFT_TAG.id] }));
    await waitFor(() => expect(args.onClose).toHaveBeenCalled());
  },
};

/** Nothing chosen, or one tag both ways: refused before anything is sent. */
export const RefusesNothingAndBothWays: Story = {
  play: async ({ args, canvasElement }) => {
    const dialog = await dialogOf(canvasElement);
    await userEvent.click(dialog.getByRole('button', { name: 'Apply' }));
    await expect(await dialog.findByText('Choose a tag to add or to remove')).toBeInTheDocument();
    await pick(canvasElement, 'Add', FINANCE_TAG.name);
    await pick(canvasElement, 'Remove', FINANCE_TAG.name);
    await userEvent.click(dialog.getByRole('button', { name: 'Apply' }));
    await expect(await dialog.findByText('A tag cannot be added and removed at once')).toBeInTheDocument();
    await expect(args.onSave).not.toHaveBeenCalled();
    await cancel(canvasElement);
  },
};

/** The server refuses: the dialog says why and stays open. */
export const Refused: Story = {
  args: {
    onSave: fn(async () => {
      throw new Error('Document not found.');
    }),
  },
  play: async ({ args, canvasElement }) => {
    const dialog = await dialogOf(canvasElement);
    await pick(canvasElement, 'Add', FINANCE_TAG.name);
    await userEvent.click(dialog.getByRole('button', { name: 'Apply' }));
    await expect(await dialog.findByText('Document not found.')).toBeInTheDocument();
    await expect(args.onClose).not.toHaveBeenCalled();
    await cancel(canvasElement);
  },
};
