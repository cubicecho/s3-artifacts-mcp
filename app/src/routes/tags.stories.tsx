import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { MINIO_BUCKET, S3_BUCKET } from '@/components/domain/bucket-fixtures';
import { MARKDOWN_DOCUMENT, MIXED_DOCUMENTS, PDF_DOCUMENT } from '@/components/domain/document-fixtures';
import {
  AGENT_TAG,
  DRAFT_TAG,
  FINANCE_TAG,
  MIXED_TAGS,
  Q4_TAG,
  type TagFixture,
  taggingServer,
} from '@/components/domain/tag-fixtures';
import { ROUTES, tagDocumentsPath } from '@/lib/routes';
import { TagsRoute } from './tags';

/**
 * The tags page against a mock server built from the real SDL: none yet, loading, failed, a list with counts, and
 * making, editing and deleting a tag, each through a dialog or a confirm.
 */

type TagOptions = Parameters<typeof taggingServer>[4];

/**
 * A story's server: the documents, the tags, and who carries what. Finance is on two documents and Q4 on one.
 *
 * @param tags - The tags it holds.
 * @param options - How the tag half answers.
 * @returns The story's parameters and the servers to inspect in `play`.
 */
function withTags(tags: readonly TagFixture[] = MIXED_TAGS, options: TagOptions = {}) {
  const server = taggingServer(
    [MINIO_BUCKET, S3_BUCKET],
    MIXED_DOCUMENTS,
    tags,
    { [PDF_DOCUMENT.id]: [FINANCE_TAG, Q4_TAG], [MARKDOWN_DOCUMENT.id]: [FINANCE_TAG] },
    options,
  );
  return {
    server,
    parameters: { apolloClient: { resolvers: server.resolvers }, router: { initialEntries: [ROUTES.tags] } },
  };
}

/** Bounded height, because `PageLayout` is a sticky chassis that scrolls its own body. */
function Framed() {
  return (
    <div className="h-screen">
      <TagsRoute />
    </div>
  );
}

const meta = {
  title: 'Routes/Tags',
  component: TagsRoute,
  render: () => <Framed />,
  parameters: { layout: 'fullscreen', ...withTags().parameters },
} satisfies Meta<typeof TagsRoute>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The row of one tag in the list.
 *
 * @param canvasElement - The story's root.
 * @param name - The tag's name.
 * @returns Queries within its row.
 */
async function rowOf(canvasElement: HTMLElement, name: string) {
  const link = await within(canvasElement).findByRole('link', { name: new RegExp(`^${name}`) });
  const row = link.closest('li');
  if (row === null) {
    throw new Error(`${name} has no row`);
  }
  return within(row);
}

/**
 * A dialog in the page's portal, once it is showing.
 *
 * @param canvasElement - The story's root.
 * @param name - Its title.
 * @returns Queries within it.
 */
async function dialogOf(canvasElement: HTMLElement, name: string) {
  const dialog = await within(canvasElement.ownerDocument.body).findByRole('dialog', { name });
  // On a slow runner the dialog may still be fading in.
  await waitFor(() => expect(dialog).toBeVisible());
  return within(dialog);
}

/** Every tag, sorted, with its count, each a link to the documents that carry it. */
export const Filled: Story = {
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('heading', { level: 1, name: 'Tags' })).toBeInTheDocument();
    const list = await canvas.findByRole('list', { name: 'Tags' });
    const links = within(list).getAllByRole('link');
    const order = [AGENT_TAG.name, DRAFT_TAG.name, FINANCE_TAG.name, Q4_TAG.name];
    await expect(links).toHaveLength(order.length);
    for (const [index, name] of order.entries()) {
      await expect(links[index]).toHaveTextContent(new RegExp(`^${name}`));
    }
    const finance = await rowOf(canvasElement, FINANCE_TAG.name);
    await expect(finance.getByText('2 documents')).toBeInTheDocument();
    await expect(finance.getByRole('link')).toHaveAttribute('href', tagDocumentsPath(FINANCE_TAG.id));
    await expect((await rowOf(canvasElement, Q4_TAG.name)).getByText('1 document')).toBeInTheDocument();
    await expect((await rowOf(canvasElement, DRAFT_TAG.name)).getByText('No documents')).toBeInTheDocument();
  },
};

/** No tags yet: the empty state is the body, and its one action makes the first. */
export const Empty: Story = {
  parameters: withTags([]).parameters,
  play: async ({ canvas, canvasElement }) => {
    await expect(await canvas.findByRole('heading', { level: 2, name: 'No tags yet' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'New tag' }));
    const dialog = await dialogOf(canvasElement, 'New tag');
    await userEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(within(canvasElement.ownerDocument.body).queryByRole('dialog')).toBeNull());
  },
};

/** Before the answer lands: placeholder rows, never "no tags". */
export const Loading: Story = {
  parameters: { apolloClient: { ...withTags().parameters.apolloClient, delay: 100_000 } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('status')).toHaveAccessibleName('Loading');
    await expect(canvas.queryByText('No tags yet')).not.toBeInTheDocument();
  },
};

/** The server failed: the reason and a retry, never "no tags". */
export const Failed: Story = {
  parameters: withTags(MIXED_TAGS, { failTags: 'The database is not answering' }).parameters,
  play: async ({ canvas }) => {
    await expect(await canvas.findByText(/Could not load your tags/)).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    await expect(canvas.queryByText('No tags yet')).not.toBeInTheDocument();
  },
};

const making = withTags();
/** New tag opens the form, and the tag it makes joins the list. */
export const MakesATag: Story = {
  parameters: making.parameters,
  play: async ({ canvas, canvasElement }) => {
    await userEvent.click(await canvas.findByRole('button', { name: 'New tag' }));
    const dialog = await dialogOf(canvasElement, 'New tag');
    await userEvent.type(dialog.getByLabelText(/^Name/), 'Contracts');
    await userEvent.click(dialog.getByRole('button', { name: 'Make tag' }));
    await expect(await canvas.findByRole('link', { name: /^Contracts/ })).toBeInTheDocument();
    await waitFor(() => expect(within(canvasElement.ownerDocument.body).queryByRole('dialog')).toBeNull());
    await expect(making.server.tagging.tags.map((tag) => tag.name)).toContain('Contracts');
  },
};

/** A name the owner has in another case is refused: the form says so, and stays open until cancelled. */
export const MakeRefused: Story = {
  play: async ({ canvas, canvasElement }) => {
    await userEvent.click(await canvas.findByRole('button', { name: 'New tag' }));
    const dialog = await dialogOf(canvasElement, 'New tag');
    await userEvent.type(dialog.getByLabelText(/^Name/), 'finance');
    await userEvent.click(dialog.getByRole('button', { name: 'Make tag' }));
    await expect(await dialog.findByText(/already have a tag called “finance”/)).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(await body.findByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(body.queryByRole('dialog')).toBeNull());
  },
};

const editing = withTags();
/** Edit opens the form on the tag; a new name and colour show in the list. */
export const RenamesAndRecolours: Story = {
  parameters: editing.parameters,
  play: async ({ canvasElement }) => {
    const row = await rowOf(canvasElement, DRAFT_TAG.name);
    await userEvent.click(row.getByRole('button', { name: `Edit ${DRAFT_TAG.name}` }));
    const dialog = await dialogOf(canvasElement, 'Edit tag');
    const name = dialog.getByLabelText(/^Name/);
    await userEvent.clear(name);
    await userEvent.type(name, 'Work in progress');
    await userEvent.click(dialog.getByRole('radio', { name: '#ef4444' }));
    await userEvent.click(dialog.getByRole('button', { name: 'Save changes' }));
    await expect(await within(canvasElement).findByRole('link', { name: /^Work in progress/ })).toBeInTheDocument();
    await waitFor(() => expect(within(canvasElement.ownerDocument.body).queryByRole('dialog')).toBeNull());
    const saved = editing.server.tagging.tags.find((tag) => tag.id === DRAFT_TAG.id);
    await expect(saved).toMatchObject({ name: 'Work in progress', color: '#ef4444' });
  },
};

const deleting = withTags();
/** Delete asks first, saying how many documents lose the tag, and the tag leaves the list. */
export const DeletesWithItsCount: Story = {
  parameters: deleting.parameters,
  play: async ({ canvasElement }) => {
    const row = await rowOf(canvasElement, FINANCE_TAG.name);
    await userEvent.click(row.getByRole('button', { name: `Delete ${FINANCE_TAG.name}` }));
    const confirm = within(await within(canvasElement.ownerDocument.body).findByRole('alertdialog'));
    await expect(confirm.getByText(/comes off the 2 documents that carry it/)).toBeInTheDocument();
    await userEvent.click(confirm.getByRole('button', { name: 'Delete' }));
    // The rest of the page is hidden from the accessibility tree until the confirm has gone.
    await waitFor(() => expect(within(canvasElement.ownerDocument.body).queryByRole('alertdialog')).toBeNull());
    await waitFor(() =>
      expect(within(canvasElement).queryByRole('link', { name: /^Finance/ })).not.toBeInTheDocument(),
    );
    const pdf = deleting.server.library.documents.find((document) => document.id === PDF_DOCUMENT.id);
    await expect(pdf?.tags.map((tag) => tag.name)).toEqual([Q4_TAG.name]);
  },
};

/** The server refuses a delete: the page says why, and the tag stays. */
export const DeleteRefused: Story = {
  parameters: withTags(MIXED_TAGS, { deleteRefusal: 'Tag not found.' }).parameters,
  play: async ({ canvas, canvasElement }) => {
    const row = await rowOf(canvasElement, Q4_TAG.name);
    await userEvent.click(row.getByRole('button', { name: `Delete ${Q4_TAG.name}` }));
    const confirm = within(await within(canvasElement.ownerDocument.body).findByRole('alertdialog'));
    await expect(confirm.getByText(/comes off the one document that carries it/)).toBeInTheDocument();
    await userEvent.click(confirm.getByRole('button', { name: 'Delete' }));
    // The rest of the page is hidden from the accessibility tree until the confirm has gone.
    await waitFor(() => expect(within(canvasElement.ownerDocument.body).queryByRole('alertdialog')).toBeNull());
    await expect(await canvas.findByText(`Could not delete “${Q4_TAG.name}”`)).toBeInTheDocument();
    await expect(canvas.getByRole('link', { name: /^Q4/ })).toBeInTheDocument();
  },
};

/** Phone width: every row keeps its name, its count and its buttons, and nothing scrolls sideways. */
export const Narrow: Story = {
  globals: { viewport: { value: 'mobile1' } },
  play: async ({ canvasElement }) => {
    const row = await rowOf(canvasElement, AGENT_TAG.name);
    await expect(row.getByRole('button', { name: `Delete ${AGENT_TAG.name}` })).toBeVisible();
    await expect(row.getByText('No documents')).toBeVisible();
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};
