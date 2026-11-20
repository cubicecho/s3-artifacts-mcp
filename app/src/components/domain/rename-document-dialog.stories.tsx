import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { RenameDocumentDialog } from './rename-document-dialog';

/** The rename form, on its own: it opens on the title, saves only a change, and refuses an empty one. */

const meta = {
  title: 'Domain/RenameDocumentDialog',
  component: RenameDocumentDialog,
  args: { title: 'Quarterly report', onRename: fn(async () => undefined), onClose: fn() },
} satisfies Meta<typeof RenameDocumentDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The dialog, in the page's portal. */
async function dialogOf(canvasElement: HTMLElement) {
  return within(await within(canvasElement.ownerDocument.body).findByRole('dialog', { name: 'Rename document' }));
}

/** It opens on the title as it stands, and Save waits for a change. */
export const Opens: Story = {
  play: async ({ canvasElement }) => {
    const dialog = await dialogOf(canvasElement);
    await expect(dialog.getByLabelText(/^Title/)).toHaveValue('Quarterly report');
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
    await expect(dialog.getByText(/keeps the name it was uploaded as/)).toBeInTheDocument();
  },
};

/** A new title is trimmed, saved, and the dialog closes. */
export const Saves: Story = {
  play: async ({ args, canvasElement }) => {
    const dialog = await dialogOf(canvasElement);
    const field = dialog.getByLabelText(/^Title/);
    await userEvent.clear(field);
    await userEvent.type(field, '  Q3 report  ');
    await userEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(args.onRename).toHaveBeenCalledWith('Q3 report'));
    await waitFor(() => expect(args.onClose).toHaveBeenCalled());
  },
};

/** An empty title is refused before anything is sent. */
export const EmptyTitle: Story = {
  play: async ({ args, canvasElement }) => {
    const dialog = await dialogOf(canvasElement);
    const field = dialog.getByLabelText(/^Title/);
    await userEvent.clear(field);
    await userEvent.type(field, '   ');
    await userEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await expect(await dialog.findByText('Give the document a title')).toBeInTheDocument();
    await expect(args.onRename).not.toHaveBeenCalled();
  },
};

/** The server refuses: the dialog stays open and says why. */
export const Refused: Story = {
  args: {
    onRename: fn(async () => {
      throw new Error('A title is at most 200 characters');
    }),
  },
  play: async ({ args, canvasElement }) => {
    const dialog = await dialogOf(canvasElement);
    await userEvent.type(dialog.getByLabelText(/^Title/), '!');
    await userEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await expect(await dialog.findByText('A title is at most 200 characters')).toBeInTheDocument();
    await expect(args.onClose).not.toHaveBeenCalled();
  },
};
