import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { bucketServer, S3_BUCKET } from './bucket-fixtures';
import { BucketSecretDialog } from './bucket-secret-dialog';

/** The secret-only dialog, saving through `setBucketSecret` on a mock server built from the real SDL. */

const UNREADABLE = { ...S3_BUCKET, secretReadable: false };

const meta = {
  title: 'Domain/BucketSecretDialog',
  component: BucketSecretDialog,
  args: { bucket: UNREADABLE, onSaved: fn(async () => undefined), onClose: fn() },
  parameters: { apolloClient: { resolvers: bucketServer([UNREADABLE]).resolvers } },
} satisfies Meta<typeof BucketSecretDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The open dialog, which is portalled to the document body. */
async function dialogOf(canvasElement: HTMLElement) {
  return within(await within(canvasElement.ownerDocument.body).findByRole('dialog'));
}

/** The secret is the only field, and the key it goes with is named. Saving it closes the dialog. */
export const Saves: Story = {
  play: async ({ args, canvasElement }) => {
    const dialog = await dialogOf(canvasElement);
    await expect(dialog.getByText(new RegExp(S3_BUCKET.accessKeyId))).toBeInTheDocument();
    await expect(dialog.queryAllByRole('textbox')).toHaveLength(0);
    await userEvent.type(dialog.getByLabelText(/^Secret access key/), 'the-new-secret');
    await userEvent.click(dialog.getByRole('button', { name: 'Save secret' }));
    await waitFor(() => expect(args.onClose).toHaveBeenCalled());
    await expect(args.onSaved).toHaveBeenCalled();
  },
};

/** Left blank, it asks for the secret instead of sending nothing. */
export const Blank: Story = {
  play: async ({ args, canvasElement }) => {
    const dialog = await dialogOf(canvasElement);
    await userEvent.click(dialog.getByRole('button', { name: 'Save secret' }));
    await expect(await dialog.findByText('Enter the secret access key')).toBeInTheDocument();
    await expect(args.onSaved).not.toHaveBeenCalled();
  },
};

/** A secret the bucket refuses: the server's reason shows, and the dialog stays open to try again. */
export const Refused: Story = {
  parameters: {
    apolloClient: {
      resolvers: bucketServer([UNREADABLE], {
        saveRefusal: 'The test failed at HeadBucket (HTTP_403): access denied. Check the access key and secret.',
      }).resolvers,
    },
  },
  play: async ({ args, canvasElement }) => {
    const dialog = await dialogOf(canvasElement);
    await userEvent.type(dialog.getByLabelText(/^Secret access key/), 'wrong');
    await userEvent.click(dialog.getByRole('button', { name: 'Save secret' }));
    await expect(await dialog.findByText('Could not save the secret')).toBeInTheDocument();
    await expect(args.onClose).not.toHaveBeenCalled();
  },
};
