import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { GeneralSettings } from './general-settings';
import { shareLinkServer } from './share-link-fixtures';

/**
 * Settings' General tab against a mock server built from the real SDL: the upload limit and a new link's default
 * expiry and permission, as one form with a Save.
 */

type ServerOptions = Parameters<typeof shareLinkServer>[2];

/** The upload limit a new instance has, as the form shows it. */
const SHIPPED_LIMIT_MIB = 100;
/** The limit a story raises it to, and what that is in bytes. */
const RAISED_LIMIT_MIB = 2048;
const RAISED_LIMIT_BYTES = 2_147_483_648;
/** The bound, 50 GiB, in bytes and as the field shows it. */
const BOUND_BYTES = 53_687_091_200;
const BOUND_MIB = 51_200;
/** A default expiry no preset covers. */
const CUSTOM_HOURS = 36;

/**
 * A story's server.
 *
 * @param options - The settings it holds and how it answers.
 * @returns The story's parameters and the server to inspect in `play`.
 */
function served(options: ServerOptions = {}) {
  const server = shareLinkServer([], [], options);
  return { server, parameters: { apolloClient: { resolvers: server.resolvers } } };
}

const meta = {
  title: 'Domain/GeneralSettings',
  component: GeneralSettings,
  parameters: served().parameters,
} satisfies Meta<typeof GeneralSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The upload limit field. */
const uploadField = (canvas: ReturnType<typeof within>) => canvas.getByRole('spinbutton', { name: /Largest upload/ });

/** It opens on what is saved, with the bounds said, and Save waits for a change. */
export const Opens: Story = {
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole('spinbutton', { name: /Largest upload/ })).toHaveValue(SHIPPED_LIMIT_MIB);
    await expect(canvas.getByText(/From 1 MiB to 50 GiB/)).toBeInTheDocument();
    const expiry = within(canvas.getByRole('group', { name: 'Default link expiry' }));
    await expect(expiry.getByRole('button', { name: '1 day' })).toHaveAttribute('aria-pressed', 'true');
    await expect(canvas.getByText(/7 days is the most S3 allows/)).toBeInTheDocument();
    await expect(canvas.getByRole('radio', { name: /Download/ })).toBeChecked();
    await expect(canvas.getByRole('button', { name: 'Save' })).toBeDisabled();
  },
};

const saving = served();
/** A change is saved, sent in bytes and hours, and Save waits for the next one. */
export const Saves: Story = {
  parameters: saving.parameters,
  play: async ({ canvas }) => {
    const upload = await canvas.findByRole('spinbutton', { name: /Largest upload/ });
    await userEvent.clear(upload);
    await userEvent.type(upload, String(RAISED_LIMIT_MIB));
    await userEvent.click(
      within(canvas.getByRole('group', { name: 'Default link expiry' })).getByRole('button', { name: '3 days' }),
    );
    await userEvent.click(canvas.getByRole('radio', { name: /View/ }));
    await userEvent.click(canvas.getByRole('button', { name: 'Save' }));

    await expect(await canvas.findByText('Saved')).toBeInTheDocument();
    await expect(saving.server.calls.updateAppSettings).toEqual([
      { maxUploadBytes: RAISED_LIMIT_BYTES, defaultLinkExpiryHours: 72, defaultLinkPermission: 'view' },
    ]);
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Save' })).toBeDisabled());
    await expect(uploadField(canvas)).toHaveValue(RAISED_LIMIT_MIB);
  },
};

const outside = served();
/** An upload limit outside the bounds is refused under the field, and nothing is sent. */
export const UploadLimitOutOfRange: Story = {
  parameters: outside.parameters,
  play: async ({ canvas }) => {
    const upload = await canvas.findByRole('spinbutton', { name: /Largest upload/ });
    await userEvent.clear(upload);
    await userEvent.type(upload, '60000');
    await expect(await canvas.findByText('Choose from 1 MiB to 50 GiB')).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Save' }));
    await expect(outside.server.calls.updateAppSettings).toEqual([]);
  },
};

/** A default expiry past seven days is refused under the field. */
export const ExpiryOutOfRange: Story = {
  play: async ({ canvas }) => {
    const expiry = within(await canvas.findByRole('group', { name: 'Default link expiry' }));
    await userEvent.click(expiry.getByRole('button', { name: 'Custom' }));
    const amount = canvas.getByRole('spinbutton', { name: 'Custom expiry' });
    await userEvent.clear(amount);
    await userEvent.type(amount, '169');
    await expect(await canvas.findByText('Choose from 1 hour to 7 days')).toBeInTheDocument();
  },
};

/** Saved values that are not the shipped ones open the form on them. */
export const Customised: Story = {
  parameters: served({
    settings: { maxUploadBytes: BOUND_BYTES, defaultLinkExpiryHours: CUSTOM_HOURS, defaultLinkPermission: 'view' },
  }).parameters,
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole('spinbutton', { name: /Largest upload/ })).toHaveValue(BOUND_MIB);
    await expect(canvas.getByRole('spinbutton', { name: 'Custom expiry' })).toHaveValue(CUSTOM_HOURS);
    await expect(canvas.getByRole('radio', { name: /View/ })).toBeChecked();
  },
};

/** The server refuses: the form stays as typed and says why. */
export const Refused: Story = {
  parameters: served({ updateRefusal: 'The upload limit is at most 50 GiB.' }).parameters,
  play: async ({ canvas }) => {
    await userEvent.click(await canvas.findByRole('radio', { name: /View/ }));
    await userEvent.click(canvas.getByRole('button', { name: 'Save' }));
    await expect(await canvas.findByText('Could not save the settings')).toBeInTheDocument();
    await expect(canvas.queryByText('Saved')).not.toBeInTheDocument();
    await expect(canvas.getByRole('radio', { name: /View/ })).toBeChecked();
  },
};

/** Before the answer lands. */
export const Loading: Story = {
  parameters: { apolloClient: { resolvers: served().server.resolvers, delay: 100_000 } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('status')).toHaveAccessibleName('Loading');
  },
};

/** The server failed: the reason and a retry, never an empty form. */
export const Failed: Story = {
  parameters: served({ failSettings: 'The database is not answering' }).parameters,
  play: async ({ canvas }) => {
    await expect(await canvas.findByText(/Could not load the general settings/)).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    await expect(canvas.queryByRole('spinbutton', { name: /Largest upload/ })).not.toBeInTheDocument();
  },
};

/** Phone width: the fields stack and nothing scrolls sideways. */
export const Narrow: Story = {
  globals: { viewport: { value: 'mobile1' } },
  play: async ({ canvas, canvasElement }) => {
    await expect(await canvas.findByRole('button', { name: 'Save' })).toBeVisible();
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};
