import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { PDF_DOCUMENT } from './document-fixtures';
import { ShareLinkDialog } from './share-link-dialog';
import { LIMITS, sharingServer } from './share-link-fixtures';

/**
 * The share dialog against a mock server built from the real SDL: what the link lets its holder do, how long it
 * lasts and a label, then the URL with a Copy button. It opens on the owner's defaults.
 */

type SharingOptions = Parameters<typeof sharingServer>[2];

/**
 * A story's server.
 *
 * @param options - How the share-link half answers.
 * @returns The story's parameters and the server to inspect in `play`.
 */
function served(options: SharingOptions = {}) {
  const server = sharingServer([PDF_DOCUMENT], [], options);
  return { server, parameters: { apolloClient: { resolvers: server.resolvers } } };
}

const meta = {
  title: 'Domain/ShareLinkDialog',
  component: ShareLinkDialog,
  args: {
    documentId: PDF_DOCUMENT.id,
    title: PDF_DOCUMENT.title,
    defaults: { permission: 'download', expiresInHours: 24 },
    limits: LIMITS,
    onCreated: fn(async () => undefined),
    onClose: fn(),
  },
  parameters: served().parameters,
} satisfies Meta<typeof ShareLinkDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The dialog, in the page's portal. */
async function dialogOf(canvasElement: HTMLElement, name: string | RegExp) {
  return within(await within(canvasElement.ownerDocument.body).findByRole('dialog', { name }));
}

/**
 * Picks the custom amount's unit, and waits for its list to close: while it is open the rest of the dialog is
 * hidden from assistive technology, and so from queries by role.
 */
async function chooseUnit(canvasElement: HTMLElement, dialog: ReturnType<typeof within>, unit: string) {
  const page = within(canvasElement.ownerDocument.body);
  await userEvent.click(dialog.getByRole('combobox', { name: 'Custom expiry unit' }));
  await userEvent.click(await page.findByRole('option', { name: unit }));
  await waitFor(() => expect(page.queryAllByRole('option')).toHaveLength(0));
}

/** It opens on the defaults: download, a day, no label, and says what each permission means. */
export const Opens: Story = {
  play: async ({ canvasElement }) => {
    const dialog = await dialogOf(canvasElement, `Share “${PDF_DOCUMENT.title}”`);
    await expect(dialog.getByRole('radio', { name: /Download/ })).toBeChecked();
    await expect(dialog.getByText(/This is not copy protection/)).toBeInTheDocument();
    await expect(dialog.getByRole('button', { name: '1 day' })).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByText(/Stops working .* \(1 day from now\)/)).toBeInTheDocument();
    await expect(dialog.getByText(/7 days is the most S3 allows/)).toBeInTheDocument();
    await expect(dialog.getByRole('textbox', { name: /Label/ })).toHaveValue('');
  },
};

/** Defaults from Settings → General that are not the shipped ones open the form on them. */
export const OtherDefaults: Story = {
  args: { defaults: { permission: 'view', expiresInHours: 72 } },
  play: async ({ canvasElement }) => {
    const dialog = await dialogOf(canvasElement, /Share/);
    await expect(dialog.getByRole('radio', { name: /View/ })).toBeChecked();
    await expect(dialog.getByRole('button', { name: '3 days' })).toHaveAttribute('aria-pressed', 'true');
  },
};

const making = served();
/** A link for 36 hours, labelled: what is sent, then the URL with its Copy button. */
export const Makes: Story = {
  parameters: making.parameters,
  play: async ({ args, canvasElement }) => {
    const dialog = await dialogOf(canvasElement, /Share/);
    await userEvent.click(dialog.getByRole('radio', { name: /View/ }));
    await userEvent.click(dialog.getByRole('button', { name: 'Custom' }));
    // Custom opens on the day already chosen, in days.
    await expect(dialog.getByRole('spinbutton', { name: 'Custom expiry' })).toHaveValue(1);
    await chooseUnit(canvasElement, dialog, 'Hours');
    const amount = dialog.getByRole('spinbutton', { name: 'Custom expiry' });
    await userEvent.clear(amount);
    await userEvent.type(amount, '36');
    await userEvent.type(dialog.getByRole('textbox', { name: /Label/ }), '  For Dana ');
    await userEvent.click(dialog.getByRole('button', { name: 'Make link' }));
    const shown = await dialogOf(canvasElement, 'Your share link');
    const [link] = making.server.sharing.links;
    await expect(making.server.sharing.calls.createShareLink).toEqual([
      { documentId: PDF_DOCUMENT.id, permission: 'view', expiresInHours: 36, label: 'For Dana' },
    ]);
    await expect(shown.getAllByText(link.url ?? '').length).toBeGreaterThan(0);
    await expect(shown.getByRole('button', { name: 'Copy share link' })).toBeInTheDocument();
    await expect(shown.getByText(/without signing in/)).toBeInTheDocument();
    await waitFor(() => expect(args.onCreated).toHaveBeenCalled());
    await userEvent.click(shown.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(args.onClose).toHaveBeenCalled());
  },
};

const tooLong = served();
/** Eight days is past what S3 signs for: refused under the field, and nothing is sent. */
export const TooLong: Story = {
  parameters: tooLong.parameters,
  play: async ({ canvasElement }) => {
    const dialog = await dialogOf(canvasElement, /Share/);
    await userEvent.click(dialog.getByRole('button', { name: 'Custom' }));
    await expect(dialog.getByRole('combobox', { name: 'Custom expiry unit' })).toHaveTextContent('Days');
    const amount = dialog.getByRole('spinbutton', { name: 'Custom expiry' });
    await userEvent.clear(amount);
    await userEvent.type(amount, '8');
    await userEvent.click(dialog.getByRole('button', { name: 'Make link' }));
    await expect(await dialog.findByText('Choose from 1 hour to 7 days')).toBeInTheDocument();
    await expect(tooLong.server.sharing.calls.createShareLink).toEqual([]);
  },
};

/** The server refuses: the dialog stays on the form and says why. */
export const Refused: Story = {
  parameters: served({ createRefusal: 'The upload has not finished, so there is nothing to share yet.' }).parameters,
  play: async ({ args, canvasElement }) => {
    const dialog = await dialogOf(canvasElement, /Share/);
    await userEvent.click(dialog.getByRole('button', { name: 'Make link' }));
    await expect(await dialog.findByText('Could not make the link')).toBeInTheDocument();
    await expect(dialog.getByText(/nothing to share yet/)).toBeInTheDocument();
    await expect(args.onCreated).not.toHaveBeenCalled();
  },
};

/** Phone width: the options, the pills and the footer fit, and nothing scrolls sideways. */
export const Narrow: Story = {
  globals: { viewport: { value: 'mobile1' } },
  play: async ({ canvasElement }) => {
    const dialog = await dialogOf(canvasElement, /Share/);
    await userEvent.click(dialog.getByRole('button', { name: 'Custom' }));
    await expect(dialog.getByRole('button', { name: 'Make link' })).toBeVisible();
    const root = canvasElement.ownerDocument.documentElement;
    await expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
  },
};
