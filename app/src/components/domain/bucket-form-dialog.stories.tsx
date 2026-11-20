import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import {
  B2_BUCKET,
  BUCKET_PRESETS,
  bucketServer,
  MINIO_BUCKET,
  TEST_FAILED,
  TEST_PASSED,
  TEST_WARNED,
} from './bucket-fixtures';
import { BucketFormDialog } from './bucket-form-dialog';

/**
 * The add/edit dialog against a mock server built from the real SDL: the presets come from
 * `bucketPresets`, and Test connection and Save go through `testBucket`, `createBucket` and
 * `updateBucket`.
 */

const meta = {
  title: 'Domain/BucketFormDialog',
  component: BucketFormDialog,
  args: { onSaved: fn(async () => undefined), onClose: fn() },
  parameters: { apolloClient: { resolvers: bucketServer([]).resolvers } },
} satisfies Meta<typeof BucketFormDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The open dialog, which is portalled to the document body. */
async function dialogOf(canvasElement: HTMLElement, name: string | RegExp) {
  return within(await within(canvasElement.ownerDocument.body).findByRole('dialog', { name }));
}

/** Types the fields every provider needs, past the provider and endpoint. */
async function fillAccount(dialog: ReturnType<typeof within>) {
  await userEvent.type(dialog.getByRole('textbox', { name: /^Bucket/ }), 'acme-reports');
  await userEvent.type(dialog.getByRole('textbox', { name: /Access key ID/ }), 'AKIAIOSFODNN7EXAMPLE');
  await userEvent.type(dialog.getByLabelText(/^Secret access key/), 'wJalrXUtnFEMI/K7MDENG');
}

/**
 * Picks a provider in the preset select, and waits for its list to close: while it is open the
 * rest of the dialog is hidden from assistive technology, and so from queries by role.
 */
async function pickProvider(canvasElement: HTMLElement, dialog: ReturnType<typeof within>, label: string) {
  const page = within(canvasElement.ownerDocument.body);
  await userEvent.click(dialog.getByRole('combobox', { name: /Provider/ }));
  await userEvent.click(await page.findByRole('option', { name: label }));
  await waitFor(() => expect(page.queryAllByRole('option')).toHaveLength(0));
}

/** Before the presets land: the dialog is there with its title, and a placeholder for the form. */
export const PresetsLoading: Story = {
  parameters: { apolloClient: { resolvers: bucketServer([]).resolvers, delay: 100_000 } },
  play: async ({ canvasElement }) => {
    const dialog = await dialogOf(canvasElement, 'Add a bucket');
    await expect(dialog.queryByRole('combobox', { name: /Provider/ })).not.toBeInTheDocument();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  },
};

/** The presets could not be fetched: the reason and a retry, not an empty form. */
export const PresetsFailed: Story = {
  parameters: {
    apolloClient: {
      resolvers: {
        Query: {
          bucketPresets: () => {
            throw new Error('The server is restarting');
          },
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const dialog = await dialogOf(canvasElement, 'Add a bucket');
    await expect(await dialog.findByRole('alert')).toHaveTextContent(/Could not load the providers/);
    await expect(dialog.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  },
};

/**
 * A new bucket starts on the first preset. Every provider the server offers is in the picker,
 * and choosing MinIO turns path-style on, fills its region and makes the endpoint required.
 */
export const Create: Story = {
  play: async ({ args, canvasElement }) => {
    const dialog = await dialogOf(canvasElement, 'Add a bucket');
    const page = within(canvasElement.ownerDocument.body);
    await expect(dialog.getByRole('textbox', { name: /Endpoint/ })).not.toBeRequired();
    await expect(dialog.getByRole('switch', { name: /Path-style/ })).not.toBeChecked();

    await userEvent.click(dialog.getByRole('combobox', { name: /Provider/ }));
    await expect((await page.findAllByRole('option')).map((option) => option.textContent)).toEqual(
      BUCKET_PRESETS.map((preset) => preset.label),
    );
    await userEvent.click(page.getByRole('option', { name: 'MinIO' }));
    await waitFor(() => expect(page.queryAllByRole('option')).toHaveLength(0));
    await expect(dialog.getByRole('switch', { name: /Path-style/ })).toBeChecked();
    await expect(dialog.getByRole('textbox', { name: /Region/ })).toHaveValue('us-east-1');
    await expect(dialog.getByRole('textbox', { name: /^Endpoint/ })).toBeRequired();

    await userEvent.type(dialog.getByRole('textbox', { name: /Name/ }), 'Home lab');
    await expect(dialog.getByRole('textbox', { name: /Slug/ })).toHaveAttribute('placeholder', 'home-lab');
    await userEvent.type(dialog.getByRole('textbox', { name: /^Endpoint/ }), 'http://minio.lan:9000');
    await expect(dialog.getByRole('textbox', { name: /Public endpoint/ })).toHaveAttribute(
      'placeholder',
      'http://minio.lan:9000',
    );
    await fillAccount(dialog);
    await userEvent.click(dialog.getByRole('button', { name: 'Add bucket' }));
    await waitFor(() => expect(args.onSaved).toHaveBeenCalled());
    await expect(args.onClose).toHaveBeenCalled();
  },
};

/** Backblaze B2: path-style off, an endpoint required, and the region read out of the endpoint. */
export const CreateB2: Story = {
  play: async ({ args, canvasElement }) => {
    const dialog = await dialogOf(canvasElement, 'Add a bucket');
    await pickProvider(canvasElement, dialog, 'Backblaze B2');
    const endpoint = dialog.getByRole('textbox', { name: /^Endpoint/ });
    await expect(endpoint).toBeRequired();
    await expect(endpoint).toHaveAttribute('placeholder', 'https://s3.us-west-004.backblazeb2.com');
    await expect(dialog.getByRole('textbox', { name: /Region/ })).toBeRequired();
    await expect(dialog.getByText(/The part of the endpoint after “s3.”/)).toBeInTheDocument();
    await expect(dialog.getByRole('switch', { name: /Path-style/ })).not.toBeChecked();

    await userEvent.type(dialog.getByRole('textbox', { name: /Name/ }), 'Backups');
    await userEvent.type(endpoint, 'https://s3.eu-central-003.backblazeb2.com');
    await expect(dialog.getByRole('textbox', { name: /Region/ })).toHaveValue('eu-central-003');
    await fillAccount(dialog);
    await userEvent.click(dialog.getByRole('button', { name: 'Add bucket' }));
    await waitFor(() => expect(args.onSaved).toHaveBeenCalled());
  },
};

/** Saving with a required field empty: each says what it needs, and nothing is sent. */
export const CreateIncomplete: Story = {
  play: async ({ args, canvasElement }) => {
    const dialog = await dialogOf(canvasElement, 'Add a bucket');
    await pickProvider(canvasElement, dialog, 'RustFS');
    await userEvent.click(dialog.getByRole('button', { name: 'Add bucket' }));
    await expect(await dialog.findByText('Give the bucket a name')).toBeInTheDocument();
    await expect(dialog.getByText('This provider needs an endpoint')).toBeInTheDocument();
    await expect(dialog.getByText('Enter the secret access key')).toBeInTheDocument();
    await expect(args.onSaved).not.toHaveBeenCalled();
  },
};

/** The server tested the bucket on save and refused it: its words, naming the step, under the form. */
export const CreateRefused: Story = {
  parameters: {
    apolloClient: {
      resolvers: bucketServer([], {
        saveRefusal: 'The bucket failed its test at HEAD_BUCKET: NoSuchBucket (The specified bucket does not exist).',
      }).resolvers,
    },
  },
  play: async ({ args, canvasElement }) => {
    const dialog = await dialogOf(canvasElement, 'Add a bucket');
    await userEvent.type(dialog.getByRole('textbox', { name: /Name/ }), 'Reports');
    await userEvent.type(dialog.getByRole('textbox', { name: /Region/ }), 'eu-west-1');
    await fillAccount(dialog);
    await userEvent.click(dialog.getByRole('button', { name: 'Add bucket' }));
    const refusal = await dialog.findByRole('alert');
    await expect(refusal).toHaveTextContent('Could not save the bucket');
    await expect(refusal).toHaveTextContent(/HEAD_BUCKET: NoSuchBucket/);
    await expect(args.onSaved).not.toHaveBeenCalled();
    await expect(dialog.getByRole('textbox', { name: /Name/ })).toHaveValue('Reports');
  },
};

/** Test connection before saving: every step passed, shown inline. */
export const TestPasses: Story = {
  parameters: { apolloClient: { resolvers: bucketServer([], { test: TEST_PASSED }).resolvers } },
  play: async ({ canvasElement }) => {
    const dialog = await dialogOf(canvasElement, 'Add a bucket');
    await userEvent.click(dialog.getByRole('button', { name: 'Test connection' }));
    const report = within(await dialog.findByRole('region', { name: 'Connection test' }));
    await expect(report.getByText('Connection works')).toBeInTheDocument();
    await expect(report.getAllByText('Passed')).toHaveLength(TEST_PASSED.steps.length);
    // A change makes the report stale, so it goes.
    await userEvent.type(dialog.getByRole('textbox', { name: /Name/ }), 'R');
    await expect(dialog.queryByRole('region', { name: 'Connection test' })).not.toBeInTheDocument();
  },
};

/** Test connection that fails: the failed step with its S3 error code and message. */
export const TestFails: Story = {
  parameters: { apolloClient: { resolvers: bucketServer([], { test: TEST_FAILED }).resolvers } },
  play: async ({ canvasElement }) => {
    const dialog = await dialogOf(canvasElement, 'Add a bucket');
    await userEvent.click(dialog.getByRole('button', { name: 'Test connection' }));
    const report = within(await dialog.findByRole('region', { name: 'Connection test' }));
    await expect(report.getByRole('alert')).toHaveTextContent('Failed: reach the bucket');
    await expect(report.getByRole('alert')).toHaveTextContent('SignatureDoesNotMatch');
    await expect(report.getByText('Failed')).toBeInTheDocument();
  },
};

/** Test connection that passes with a share-link warning: the bucket can be saved, links may not open. */
export const TestWarns: Story = {
  parameters: { apolloClient: { resolvers: bucketServer([], { test: TEST_WARNED }).resolvers } },
  play: async ({ canvasElement }) => {
    const dialog = await dialogOf(canvasElement, 'Add a bucket');
    await userEvent.click(dialog.getByRole('button', { name: 'Test connection' }));
    const report = within(await dialog.findByRole('region', { name: 'Connection test' }));
    await expect(report.getByText('Works, but share links may not open')).toBeInTheDocument();
    await expect(report.getByText(/could not reach https:\/\/files.example.com/)).toBeInTheDocument();
    await expect(report.queryByRole('alert')).not.toBeInTheDocument();
  },
};

/**
 * Editing: the saved values are in the form, the secret is blank and says it is kept, and Save
 * waits for a change.
 */
export const Edit: Story = {
  args: { bucket: B2_BUCKET },
  parameters: { apolloClient: { resolvers: bucketServer([B2_BUCKET]).resolvers } },
  play: async ({ args, canvasElement }) => {
    const dialog = await dialogOf(canvasElement, 'Edit “Backups”');
    await expect(dialog.getByRole('textbox', { name: /Name/ })).toHaveValue('Backups');
    await expect(dialog.getByRole('textbox', { name: /^Endpoint/ })).toHaveValue(B2_BUCKET.endpoint);
    await expect(dialog.getByRole('textbox', { name: /Region/ })).toHaveValue('us-west-004');
    await expect(dialog.getByLabelText(/^Secret access key/)).toHaveValue('');
    await expect(dialog.getByLabelText(/^Secret access key/)).not.toBeRequired();
    await expect(dialog.getByText('Leave blank to keep the current secret.')).toBeInTheDocument();

    const save = dialog.getByRole('button', { name: 'Save changes' });
    await expect(save).toBeDisabled();
    await userEvent.clear(dialog.getByRole('textbox', { name: /Name/ }));
    await userEvent.type(dialog.getByRole('textbox', { name: /Name/ }), 'Offsite backups');
    await userEvent.click(save);
    await waitFor(() => expect(args.onSaved).toHaveBeenCalled());
  },
};

/** Editing a bucket whose secret can no longer be read: it says why, and the secret is required. */
export const EditUnreadableSecret: Story = {
  args: { bucket: { ...MINIO_BUCKET, secretReadable: false } },
  parameters: { apolloClient: { resolvers: bucketServer([{ ...MINIO_BUCKET, secretReadable: false }]).resolvers } },
  play: async ({ canvasElement }) => {
    const dialog = await dialogOf(canvasElement, 'Edit “Artifacts”');
    await expect(dialog.getByText('Enter the secret again')).toBeInTheDocument();
    await expect(dialog.getByText(/BETTER_AUTH_SECRET changed/)).toBeInTheDocument();
    await expect(dialog.getByLabelText(/^Secret access key/)).toBeRequired();
  },
};

/** Phone width: the fields stack, the footer fits, and nothing scrolls sideways. */
export const Narrow: Story = {
  globals: { viewport: { value: 'mobile1' } },
  play: async ({ canvasElement }) => {
    const dialog = await dialogOf(canvasElement, 'Add a bucket');
    await waitFor(() => expect(dialog.getByRole('button', { name: 'Test connection' })).toBeVisible());
    const root = canvasElement.ownerDocument.documentElement;
    await expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
  },
};
