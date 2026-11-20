import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { documentPath } from '@/lib/routes';
import { MARKDOWN_DOCUMENT, PDF_DOCUMENT } from './document-fixtures';
import { type ShareLinkFixture, shareLinkFixture, sharingServer } from './share-link-fixtures';
import { ShareLinkSettings } from './share-link-settings';

/**
 * Settings' Share links tab against a mock server built from the real SDL: every document's links, filtered by
 * state, each with Copy, a way to its document, and Remove from list.
 */

const LINKS: readonly ShareLinkFixture[] = [
  shareLinkFixture(PDF_DOCUMENT, { label: 'For the design review' }),
  shareLinkFixture(MARKDOWN_DOCUMENT, { label: 'Release notes for the team', createdBy: 'mcp' }),
  shareLinkFixture(PDF_DOCUMENT, { label: 'Last quarter', state: 'expired', expiresAt: '2026-11-01T10:00:00.000Z' }),
  shareLinkFixture(PDF_DOCUMENT, { label: 'Old draft', state: 'revoked' }),
];

type SharingOptions = Parameters<typeof sharingServer>[2];

/**
 * A story's server.
 *
 * @param links - The links it holds, newest first.
 * @param options - How it answers.
 * @returns The story's parameters and the server to inspect in `play`.
 */
function served(links: readonly ShareLinkFixture[] = LINKS, options: SharingOptions = {}) {
  const server = sharingServer([PDF_DOCUMENT, MARKDOWN_DOCUMENT], links, options);
  return { server, parameters: { apolloClient: { resolvers: server.resolvers } } };
}

const meta = {
  title: 'Domain/ShareLinkSettings',
  component: ShareLinkSettings,
  parameters: served().parameters,
} satisfies Meta<typeof ShareLinkSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The list's rows. */
async function rowsOf(canvas: ReturnType<typeof within>) {
  return within(await canvas.findByRole('list', { name: 'Share links' })).getAllByRole('listitem');
}

/** Every link, each naming its document and linking to it, with counts on the filters. */
export const Filled: Story = {
  play: async ({ canvas }) => {
    await expect(await rowsOf(canvas)).toHaveLength(LINKS.length);
    const filters = within(canvas.getByRole('group', { name: 'Show' }));
    await expect(filters.getAllByRole('button').map((pill) => pill.textContent)).toEqual([
      'All (4)',
      'Active (2)',
      'Expired (1)',
      'Revoked (1)',
    ]);
    await expect(canvas.getByText(/Release notes · Download · Expires .* · Made by an MCP client/)).toBeInTheDocument();
    const [open] = canvas.getAllByRole('link', { name: `Open ${PDF_DOCUMENT.title}` });
    await expect(open).toHaveAttribute('href', documentPath(PDF_DOCUMENT.id));
  },
};

/** A filter shows one state only, and one with nothing in it says so. */
export const Filters: Story = {
  parameters: served(LINKS.filter((link) => link.state !== 'revoked')).parameters,
  play: async ({ canvas }) => {
    await rowsOf(canvas);
    const filters = within(canvas.getByRole('group', { name: 'Show' }));
    await userEvent.click(filters.getByRole('button', { name: 'Expired (1)' }));
    await expect(filters.getByRole('button', { name: 'Expired (1)' })).toHaveAttribute('aria-pressed', 'true');
    const rows = await rowsOf(canvas);
    await expect(rows).toHaveLength(1);
    await expect(within(rows[0]).getByText('Last quarter')).toBeInTheDocument();

    await userEvent.click(filters.getByRole('button', { name: 'Revoked (0)' }));
    await expect(await canvas.findByText('No link has been revoked.')).toBeInTheDocument();
  },
};

const removing = served();
/** Remove from list asks first, then the row goes; the link itself is untouched at the bucket. */
export const RemovesFromList: Story = {
  parameters: removing.parameters,
  play: async ({ canvas, canvasElement }) => {
    await rowsOf(canvas);
    await userEvent.click(canvas.getByRole('button', { name: 'Remove Old draft from the list' }));
    const confirm = within(await within(canvasElement.ownerDocument.body).findByRole('alertdialog'));
    await expect(confirm.getByText(/already no longer opens/)).toBeInTheDocument();
    await userEvent.click(confirm.getByRole('button', { name: 'Remove from list' }));
    await waitFor(() => expect(canvas.queryByText('Old draft')).not.toBeInTheDocument());
    const removed = LINKS.find((link) => link.label === 'Old draft');
    await expect(removing.server.sharing.calls.deleteShareLink).toEqual([removed?.id]);
  },
};

/** No links at all: it says where they are made. */
export const Empty: Story = {
  parameters: served([]).parameters,
  play: async ({ canvas }) => {
    await expect(await canvas.findByText(/No share links yet. Share a document from its page./)).toBeInTheDocument();
    await expect(canvas.queryByRole('group', { name: 'Show' })).not.toBeInTheDocument();
  },
};

/** Before the answer lands. */
export const Loading: Story = {
  parameters: { apolloClient: { resolvers: served().server.resolvers, delay: 100_000 } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('status')).toHaveAccessibleName('Loading');
  },
};

/** The server failed: the reason and a retry, never "no links". */
export const Failed: Story = {
  parameters: served(LINKS, { failLinks: 'The database is not answering' }).parameters,
  play: async ({ canvas }) => {
    await expect(await canvas.findByText(/Could not load your share links/)).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    await expect(canvas.queryByText(/No share links yet/)).not.toBeInTheDocument();
  },
};

/** Phone width: the filters wrap and the rows fit, and nothing scrolls sideways. */
export const Narrow: Story = {
  globals: { viewport: { value: 'mobile1' } },
  play: async ({ canvas, canvasElement }) => {
    await rowsOf(canvas);
    await expect(canvas.getByRole('group', { name: 'Show' })).toBeVisible();
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};
