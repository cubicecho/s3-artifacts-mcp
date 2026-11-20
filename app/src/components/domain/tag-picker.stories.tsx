import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { FINANCE_TAG, MIXED_TAGS, Q4_TAG } from './tag-fixtures';
import { TagPicker } from './tag-picker';

/** The tag picker on its own: the chosen tags on its trigger, a search over the rest, and making a tag by name. */

const meta = {
  title: 'Domain/TagPicker',
  component: TagPicker,
  args: {
    tags: MIXED_TAGS,
    chosen: [FINANCE_TAG],
    onValueChange: fn(),
    onCreateTag: fn(),
    label: 'Tags of Quarterly report',
  },
  render: (args) => (
    <div className="max-w-sm">
      <TagPicker {...args} />
    </div>
  ),
} satisfies Meta<typeof TagPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Opens the picker's menu.
 *
 * @param canvasElement - The story's root.
 * @returns The menu, in the page's portal.
 */
async function openMenu(canvasElement: HTMLElement) {
  await userEvent.click(within(canvasElement).getByRole('combobox', { name: 'Tags of Quarterly report' }));
  return within(await within(canvasElement.ownerDocument.body).findByRole('dialog', { name: 'Choose tags' }));
}

/** Closes the menu, so it leaves nothing hidden from the stories after it. */
async function closeMenu(canvasElement: HTMLElement) {
  await userEvent.keyboard('{Escape}');
  await waitFor(() =>
    expect(within(canvasElement.ownerDocument.body).queryByRole('dialog', { name: 'Choose tags' })).toBeNull(),
  );
}

/** The chosen tag is a chip on the trigger. */
export const Filled: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('combobox', { name: 'Tags of Quarterly report' })).toHaveTextContent(
      FINANCE_TAG.name,
    );
  },
};

/** Nothing chosen: the trigger says so. */
export const Empty: Story = {
  args: { chosen: [] },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('combobox', { name: 'Tags of Quarterly report' })).toHaveTextContent('No tags');
  },
};

/** While the tags load, it cannot be opened. */
export const Loading: Story = {
  args: { tags: [], chosen: [], disabled: true, placeholder: 'Loading tags…' },
  play: async ({ canvas }) => {
    const trigger = canvas.getByRole('combobox', { name: 'Tags of Quarterly report' });
    await expect(trigger).toBeDisabled();
    await expect(trigger).toHaveTextContent('Loading tags…');
  },
};

/** Picking another tag hands back every chosen id. */
export const Picks: Story = {
  play: async ({ args, canvasElement }) => {
    const menu = await openMenu(canvasElement);
    await userEvent.click(menu.getByRole('option', { name: Q4_TAG.name }));
    await expect(args.onValueChange).toHaveBeenCalledWith([FINANCE_TAG.id, Q4_TAG.id]);
    await closeMenu(canvasElement);
  },
};

/** A name no tag has is offered as a new tag, and pressing it asks for it to be made. */
export const MakesATag: Story = {
  play: async ({ args, canvasElement }) => {
    const menu = await openMenu(canvasElement);
    await userEvent.type(menu.getByRole('combobox', { name: 'Find a tag' }), 'Contracts');
    await userEvent.click(await menu.findByRole('option', { name: /Make the tag “Contracts”/ }));
    await expect(args.onCreateTag).toHaveBeenCalledWith('Contracts');
    await closeMenu(canvasElement);
  },
};
