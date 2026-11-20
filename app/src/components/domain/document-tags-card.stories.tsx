import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import { PDF_DOCUMENT } from './document-fixtures';
import { DocumentTagsCard } from './document-tags-card';
import { FINANCE_TAG, MIXED_TAGS, Q4_TAG, tagServer } from './tag-fixtures';

/**
 * A document's tags card on its own: the chosen tags on the picker, waiting for the tag list, a list that failed,
 * and none chosen. Picking, making a tag and a refused save are on the document page's stories.
 */

type TagOptions = Parameters<typeof tagServer>[2];

/**
 * A story's server over one document.
 *
 * @param options - How the tag server answers.
 * @returns The parameters.
 */
function withTags(options: TagOptions = {}) {
  const documents = [{ ...PDF_DOCUMENT, tags: [FINANCE_TAG, Q4_TAG] }];
  return { apolloClient: { resolvers: tagServer(documents, MIXED_TAGS, options).resolvers } };
}

const meta = {
  title: 'Domain/DocumentTagsCard',
  component: DocumentTagsCard,
  args: { document: { id: PDF_DOCUMENT.id, title: PDF_DOCUMENT.title, tags: [FINANCE_TAG, Q4_TAG] } },
  parameters: withTags(),
} satisfies Meta<typeof DocumentTagsCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const TRIGGER = { name: `Tags of ${PDF_DOCUMENT.title}` };

/** Its tags are chips on the picker, which opens once the tag list is in. */
export const Filled: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('heading', { level: 2, name: 'Tags' })).toBeInTheDocument();
    const trigger = canvas.getByRole('combobox', TRIGGER);
    await waitFor(() => expect(trigger).toBeEnabled());
    await expect(trigger).toHaveTextContent(`${FINANCE_TAG.name}${Q4_TAG.name}`);
  },
};

/** No tags on it yet. */
export const Empty: Story = {
  args: { document: { id: PDF_DOCUMENT.id, title: PDF_DOCUMENT.title, tags: [] } },
  play: async ({ canvas }) => {
    await waitFor(() => expect(canvas.getByRole('combobox', TRIGGER)).toHaveTextContent('No tags'));
  },
};

/** While the tag list loads, the picker waits and says so. */
export const Loading: Story = {
  args: { document: { id: PDF_DOCUMENT.id, title: PDF_DOCUMENT.title, tags: [] } },
  parameters: { apolloClient: { ...withTags().apolloClient, delay: 100_000 } },
  play: async ({ canvas }) => {
    const trigger = canvas.getByRole('combobox', TRIGGER);
    await expect(trigger).toBeDisabled();
    await expect(trigger).toHaveTextContent('Loading tags…');
  },
};

/** The tag list failed: the card says so, with a retry, rather than offering no tags. */
export const Failed: Story = {
  parameters: withTags({ failTags: 'The database is not answering' }),
  play: async ({ canvas }) => {
    await expect(await canvas.findByText(/Could not load your tags/)).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    await expect(canvas.queryByRole('combobox', TRIGGER)).not.toBeInTheDocument();
  },
};
