import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent } from 'storybook/test';
import { TagChip, TagChips } from './tag-chip';
import { DRAFT_TAG, FINANCE_TAG, MIXED_TAGS, Q4_TAG } from './tag-fixtures';

/** A tag as a pill in its own colour, with ink picked for contrast, alone, with its ✕, and as a row. */

const meta = {
  title: 'Domain/TagChip',
  component: TagChip,
  args: { tag: FINANCE_TAG },
} satisfies Meta<typeof TagChip>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The name is on the chip, so the colour is never all that says which tag it is. */
export const Filled: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByText(FINANCE_TAG.name)).toBeVisible();
    await expect(canvas.queryByRole('button')).not.toBeInTheDocument();
  },
};

/** A pale colour gets dark ink, which the accessibility check holds to 4.5:1. */
export const PaleColour: Story = {
  args: { tag: DRAFT_TAG },
  play: async ({ canvas }) => {
    await expect(canvas.getByText(DRAFT_TAG.name)).toBeVisible();
  },
};

/** With a ✕ that takes it off, named after the tag. */
export const Removable: Story = {
  args: { tag: Q4_TAG, onRemove: fn() },
  play: async ({ args, canvas }) => {
    await userEvent.click(canvas.getByRole('button', { name: `Remove ${Q4_TAG.name}` }));
    await expect(args.onRemove).toHaveBeenCalledOnce();
  },
};

/** A row of them, as a table cell draws it: a named list, and nothing at all for none. */
export const Row: Story = {
  render: () => (
    <div className="grid gap-2">
      <TagChips tags={MIXED_TAGS} label="Tags of Quarterly report" />
      <TagChips tags={[]} label="Tags of Untagged" />
    </div>
  ),
  play: async ({ canvas }) => {
    const list = canvas.getByRole('list', { name: 'Tags of Quarterly report' });
    await expect(list.querySelectorAll('li')).toHaveLength(MIXED_TAGS.length);
    await expect(canvas.queryByRole('list', { name: 'Tags of Untagged' })).not.toBeInTheDocument();
  },
};
