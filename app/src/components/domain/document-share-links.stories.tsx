import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { MINIO_BUCKET } from './bucket-fixtures';
import { type DocumentFixture, PDF_DOCUMENT } from './document-fixtures';
import { DocumentShareLinks } from './document-share-links';
import { type ShareLinkFixture, shareLinkFixture, sharingServer } from './share-link-fixtures';

/**
 * A document's share links on its page, against a mock server built from the real SDL: making one, the list with
 * each link's state as a word and an icon, Remove from list, and Revoke all links.
 */

const LINKS: readonly ShareLinkFixture[] = [
  shareLinkFixture(PDF_DOCUMENT, { label: 'For the design review' }),
  shareLinkFixture(PDF_DOCUMENT, {
    permission: 'view',
    state: 'expired',
    expiresAt: '2026-11-10T10:00:00.000Z',
    createdBy: 'mcp',
  }),
  shareLinkFixture(PDF_DOCUMENT, { label: 'Old draft', state: 'revoked', objectKey: 'an-older-key.pdf' }),
];

/** A scanned file: its key is where the owner put it, not one the app made. */
const SCANNED_DOCUMENT: DocumentFixture = { ...PDF_DOCUMENT, objectKey: 'reports/2026/q3.pdf', sha256: null };

type SharingOptions = Parameters<typeof sharingServer>[2];

/**
 * A story's server and the card for one of its documents.
 *
 * @param document - The document the card is for.
 * @param links - Its links, newest first.
 * @param options - How the share-link half answers.
 * @returns The story's args and parameters, and the server to inspect in `play`.
 */
function served(
  document: DocumentFixture = PDF_DOCUMENT,
  links: readonly ShareLinkFixture[] = [],
  options: SharingOptions = {},
) {
  const server = sharingServer([document], links, options);
  return {
    server,
    story: {
      args: { document: { ...document, bucket: { name: MINIO_BUCKET.name } } },
      parameters: { apolloClient: { resolvers: server.resolvers } },
    },
  };
}

const meta = {
  title: 'Domain/DocumentShareLinks',
  component: DocumentShareLinks,
  ...served().story,
} satisfies Meta<typeof DocumentShareLinks>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The page's portal, where the dialogs open. */
const page = (canvasElement: HTMLElement) => within(canvasElement.ownerDocument.body);

/** The list's row for a link, by its name. */
async function rowOf(canvas: ReturnType<typeof within>, name: string) {
  const list = within(await canvas.findByRole('list', { name: 'Share links' }));
  const row = list.getAllByRole('listitem').find((item) => within(item).queryByText(name) !== null);
  if (row === undefined) {
    throw new Error(`No row for ${name}`);
  }
  return within(row);
}

/** No links yet: it says so, and offers Share. */
export const Empty: Story = {
  play: async ({ canvas }) => {
    await expect(await canvas.findByText('No share links yet.')).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Share' })).toBeEnabled();
    await expect(canvas.getByText(/at most 7 days after they are made/)).toBeInTheDocument();
  },
};

/** Links in each state: the state is a word with an icon, never a colour alone; only an active one copies. */
export const Filled: Story = {
  ...served(PDF_DOCUMENT, LINKS).story,
  play: async ({ canvas }) => {
    const active = await rowOf(canvas, 'For the design review');
    await expect(active.getByText('Active')).toBeInTheDocument();
    await expect(active.getByText(/Download · Expires .* · Made by you/)).toBeInTheDocument();
    await expect(active.getByRole('button', { name: 'Copy For the design review' })).toBeInTheDocument();

    const expired = await rowOf(canvas, 'View link');
    await expect(expired.getByText('Expired')).toBeInTheDocument();
    await expect(expired.getByText(/Expired .* · Made by an MCP client/)).toBeInTheDocument();
    await expect(expired.queryByRole('button', { name: /^Copy/ })).not.toBeInTheDocument();

    const revoked = await rowOf(canvas, 'Old draft');
    await expect(revoked.getByText('Revoked')).toBeInTheDocument();
    await expect(revoked.getByText(/No longer opens/)).toBeInTheDocument();
  },
};

const sharing = served();
/** Share opens the dialog on the owner's defaults, and the new link lands in the list. */
export const Shares: Story = {
  ...sharing.story,
  play: async ({ canvas, canvasElement }) => {
    await userEvent.click(await canvas.findByRole('button', { name: 'Share' }));
    const dialog = within(await page(canvasElement).findByRole('dialog', { name: /Share/ }));
    await expect(dialog.getByRole('radio', { name: /Download/ })).toBeChecked();
    await userEvent.click(dialog.getByRole('button', { name: '7 days' }));
    await userEvent.click(dialog.getByRole('button', { name: 'Make link' }));
    const shown = within(await page(canvasElement).findByRole('dialog', { name: 'Your share link' }));
    await userEvent.click(shown.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(page(canvasElement).queryByRole('dialog')).not.toBeInTheDocument());

    await expect(sharing.server.sharing.calls.createShareLink).toEqual([
      expect.objectContaining({ expiresInHours: 168, permission: 'download' }),
    ]);
    const row = await rowOf(canvas, 'Download link');
    await expect(row.getByText('Active')).toBeInTheDocument();
  },
};

const removing = served(PDF_DOCUMENT, LINKS);
/** Remove from list asks first, saying the URL keeps working, then the row goes. */
export const RemovesFromList: Story = {
  ...removing.story,
  play: async ({ canvas, canvasElement }) => {
    const row = await rowOf(canvas, 'For the design review');
    await userEvent.click(row.getByRole('button', { name: 'Remove For the design review from the list' }));
    const confirm = within(await page(canvasElement).findByRole('alertdialog'));
    await expect(confirm.getByText(/keeps working until it expires/)).toBeInTheDocument();
    await userEvent.click(confirm.getByRole('button', { name: 'Remove from list' }));
    await waitFor(() => expect(canvas.queryByText('For the design review')).not.toBeInTheDocument());
    await expect(removing.server.sharing.calls.deleteShareLink).toEqual([LINKS[0].id]);
  },
};

const revoking = served(PDF_DOCUMENT, LINKS);
/** Revoke all links says what happens, moves the file, and every link reads revoked. */
export const RevokesAll: Story = {
  ...revoking.story,
  play: async ({ canvas, canvasElement }) => {
    await rowOf(canvas, 'For the design review');
    await userEvent.click(canvas.getByRole('button', { name: 'Revoke all links' }));
    const confirm = within(await page(canvasElement).findByRole('alertdialog'));
    await expect(confirm.getByText(/moves to a new key in “Artifacts”/)).toBeInTheDocument();
    await expect(confirm.queryByText(/found by a scan/)).not.toBeInTheDocument();
    await userEvent.click(confirm.getByRole('button', { name: 'Revoke all links' }));
    await waitFor(() => expect(revoking.server.sharing.calls.rekeyDocument).toEqual([PDF_DOCUMENT.id]));
    const row = await rowOf(canvas, 'For the design review');
    await waitFor(() => expect(row.getByText('Revoked')).toBeInTheDocument());
  },
};

/** A scanned file's confirm says it leaves the path the owner put it at. */
export const RevokeScanned: Story = {
  ...served(SCANNED_DOCUMENT, [shareLinkFixture(SCANNED_DOCUMENT)]).story,
  play: async ({ canvas, canvasElement }) => {
    await userEvent.click(await canvas.findByRole('button', { name: 'Revoke all links' }));
    const confirm = within(await page(canvasElement).findByRole('alertdialog'));
    await expect(confirm.getByText(/found by a scan at “reports\/2026\/q3\.pdf”/)).toBeInTheDocument();
    // Closed again, so the dialog's hiding of the page does not outlive the story.
    await userEvent.click(confirm.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(page(canvasElement).queryByRole('alertdialog')).not.toBeInTheDocument());
  },
};

/** The bucket refuses the copy: the card says why, and the links are as they were. */
export const RevokeRefused: Story = {
  ...served(PDF_DOCUMENT, LINKS, { rekeyRefusal: 'The bucket refused to copy the file (AccessDenied).' }).story,
  play: async ({ canvas, canvasElement }) => {
    await userEvent.click(await canvas.findByRole('button', { name: 'Revoke all links' }));
    const confirm = within(await page(canvasElement).findByRole('alertdialog'));
    await userEvent.click(confirm.getByRole('button', { name: 'Revoke all links' }));
    await expect(await canvas.findByText('Could not revoke the links')).toBeInTheDocument();
    await expect(canvas.getByText(/AccessDenied/)).toBeInTheDocument();
    await expect((await rowOf(canvas, 'For the design review')).getByText('Active')).toBeInTheDocument();
  },
};

/** A document still uploading cannot be shared yet, and says why. */
export const StillUploading: Story = {
  ...served({ ...PDF_DOCUMENT, status: 'pending_upload' }).story,
  play: async ({ canvas }) => {
    await expect(await canvas.findByText('No share links yet.')).toBeInTheDocument();
    // Disabled with a reason, so it stays focusable for its hint to be read.
    await expect(canvas.getByRole('button', { name: 'Share' })).toHaveAttribute('aria-disabled', 'true');
    await expect(canvas.getByRole('button', { name: 'Revoke all links' })).toBeDisabled();
  },
};

/** Before the answer lands. */
export const Loading: Story = {
  parameters: { apolloClient: { resolvers: served().server.resolvers, delay: 100_000 } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('status')).toHaveAccessibleName('Loading');
    await expect(canvas.queryByText('No share links yet.')).not.toBeInTheDocument();
  },
};

/** The server failed: the reason and a retry, never "no links". */
export const Failed: Story = {
  ...served(PDF_DOCUMENT, [], { failLinks: 'The database is not answering' }).story,
  play: async ({ canvas }) => {
    await expect(await canvas.findByText(/Could not load the share links/)).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    await expect(canvas.queryByText('No share links yet.')).not.toBeInTheDocument();
  },
};

/** Phone width: the header's buttons and the rows fit, and nothing scrolls sideways. */
export const Narrow: Story = {
  ...served(PDF_DOCUMENT, LINKS).story,
  globals: { viewport: { value: 'mobile1' } },
  play: async ({ canvas, canvasElement }) => {
    await rowOf(canvas, 'For the design review');
    await expect(canvas.getByRole('button', { name: 'Revoke all links' })).toBeVisible();
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};
