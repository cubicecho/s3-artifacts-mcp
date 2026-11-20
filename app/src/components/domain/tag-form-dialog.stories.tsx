import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ComponentProps, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { TAG_DEFAULTS } from '@/defaults';
import { FINANCE_TAG } from './tag-fixtures';
import { TagFormDialog } from './tag-form-dialog';

/** The tag form on its own: making a tag, renaming and recolouring one, and what it refuses. */

/**
 * The dialog as a page mounts it: it goes away when it asks to, so a story that ends closed leaves nothing open.
 *
 * @param args - The story's args.
 * @returns The dialog, until it closes.
 */
function Closing(args: ComponentProps<typeof TagFormDialog>) {
  const [open, setOpen] = useState(true);
  return open ? (
    <TagFormDialog
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
  title: 'Domain/TagFormDialog',
  component: TagFormDialog,
  args: { tag: null, onSave: fn(async () => undefined), onClose: fn() },
  render: (args) => <Closing {...args} />,
} satisfies Meta<typeof TagFormDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The dialog, in the page's portal, once it is showing.
 *
 * @param canvasElement - The story's root.
 * @param name - The dialog's title.
 * @returns Queries within it.
 */
async function dialogOf(canvasElement: HTMLElement, name: string) {
  const dialog = await within(canvasElement.ownerDocument.body).findByRole('dialog', { name });
  // On a slow runner the dialog may still be fading in.
  await waitFor(() => expect(dialog).toBeVisible());
  return within(dialog);
}

/** A new tag: a name, a swatch, and Make tag sends both. */
export const MakesATag: Story = {
  play: async ({ args, canvasElement }) => {
    const dialog = await dialogOf(canvasElement, 'New tag');
    await expect(dialog.getByRole('textbox', { name: /^Colour/ })).toHaveValue(TAG_DEFAULTS.newTagColor);
    await userEvent.type(dialog.getByLabelText(/^Name/), '  Contracts ');
    await userEvent.click(dialog.getByRole('radio', { name: '#22c55e' }));
    await userEvent.click(dialog.getByRole('button', { name: 'Make tag' }));
    await waitFor(() => expect(args.onSave).toHaveBeenCalledWith({ name: 'Contracts', color: '#22c55e' }));
    await waitFor(() => expect(args.onClose).toHaveBeenCalled());
  },
};

/** An edit opens on the tag as it is, and Save waits for a change. */
export const Edits: Story = {
  args: { tag: FINANCE_TAG },
  play: async ({ args, canvasElement }) => {
    const dialog = await dialogOf(canvasElement, 'Edit tag');
    const name = dialog.getByLabelText(/^Name/);
    await expect(name).toHaveValue(FINANCE_TAG.name);
    await expect(dialog.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await userEvent.clear(name);
    await userEvent.type(name, 'Money');
    await userEvent.click(dialog.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(args.onSave).toHaveBeenCalledWith({ name: 'Money', color: FINANCE_TAG.color }));
  },
};

/** An empty name, or a colour that is not one, is refused before anything is sent. */
export const RefusesWhatIsNotATag: Story = {
  play: async ({ args, canvasElement }) => {
    const dialog = await dialogOf(canvasElement, 'New tag');
    await userEvent.type(dialog.getByLabelText(/^Name/), '   ');
    const colour = dialog.getByRole('textbox', { name: /^Colour/ });
    await userEvent.clear(colour);
    await userEvent.type(colour, 'blue');
    await userEvent.click(dialog.getByRole('button', { name: 'Make tag' }));
    await expect(await dialog.findByText('Give the tag a name')).toBeInTheDocument();
    await expect(dialog.getByText(/Pick a swatch/)).toBeInTheDocument();
    await expect(args.onSave).not.toHaveBeenCalled();
    await cancel(canvasElement);
  },
};

/** A name the owner already has, in any case: the server's answer is said under the form, and it stays open. */
export const Refused: Story = {
  args: {
    onSave: fn(async () => {
      throw new Error('You already have a tag called “finance”. Tag names are unique, ignoring case.');
    }),
  },
  play: async ({ args, canvasElement }) => {
    const dialog = await dialogOf(canvasElement, 'New tag');
    await userEvent.type(dialog.getByLabelText(/^Name/), 'finance');
    await userEvent.click(dialog.getByRole('button', { name: 'Make tag' }));
    await expect(await dialog.findByText(/already have a tag called “finance”/)).toBeInTheDocument();
    await expect(args.onClose).not.toHaveBeenCalled();
    await cancel(canvasElement);
  },
};
