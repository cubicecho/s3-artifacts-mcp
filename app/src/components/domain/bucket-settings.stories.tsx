import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import {
  B2_BUCKET,
  bucketServer,
  MINIO_BUCKET,
  MIXED_BUCKETS,
  S3_BUCKET,
  SCAN_ADDED,
  TEST_FAILED,
  TEST_PASSED,
  TEST_WARNED,
} from './bucket-fixtures';
import { BucketSettings } from './bucket-settings';

/**
 * Settings' Buckets card against a mock server built from the real SDL. The mutations change
 * the server's list, so a story sees a bucket arrive and leave.
 */

const meta = {
  title: 'Domain/BucketSettings',
  component: BucketSettings,
  parameters: { apolloClient: { resolvers: bucketServer(MIXED_BUCKETS).resolvers } },
} satisfies Meta<typeof BucketSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The rows, as a list in the card. */
async function rows(canvasElement: HTMLElement) {
  const list = await within(canvasElement).findByRole('list', { name: 'Buckets' });
  return within(list).getAllByRole('listitem');
}

/** No buckets yet: one line that invites the first, with the button to add it. */
export const Empty: Story = {
  parameters: { apolloClient: { resolvers: bucketServer([]).resolvers } },
  play: async ({ canvas, canvasElement }) => {
    await expect(await canvas.findByText(/No buckets yet/)).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Add bucket' }));
    const page = within(canvasElement.ownerDocument.body);
    await expect(await page.findByRole('dialog', { name: 'Add a bucket' })).toBeInTheDocument();
  },
};

/** Before the answer lands: placeholder rows rather than an empty card. */
export const Loading: Story = {
  parameters: { apolloClient: { resolvers: bucketServer(MIXED_BUCKETS).resolvers, delay: 100_000 } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('status')).toHaveAccessibleName('Loading');
    await expect(canvas.queryByText(/No buckets yet/)).not.toBeInTheDocument();
  },
};

/** The server failed: the reason and a way to ask again, never "no buckets". */
export const Failed: Story = {
  parameters: {
    apolloClient: {
      resolvers: {
        Query: {
          ...bucketServer([]).resolvers.Query,
          buckets: () => {
            throw new Error('The database is not answering');
          },
        },
      },
    },
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText(/Could not load your buckets/)).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    await expect(canvas.queryByText(/No buckets yet/)).not.toBeInTheDocument();
  },
};

/**
 * One of each provider on different accounts, sorted by name. Every row names its provider and
 * where it is, so buckets of the same kind can be told apart.
 */
export const Filled: Story = {
  play: async ({ canvas, canvasElement }) => {
    const listed = await rows(canvasElement);
    await expect(listed).toHaveLength(MIXED_BUCKETS.length);
    const [first, second] = listed;
    await expect(first).toHaveTextContent('Artifacts');
    await expect(second).toHaveTextContent('Backups');
    // There is no default bucket: an upload always names where it goes.
    await expect(canvas.queryByText('Default')).not.toBeInTheDocument();

    await expect(canvas.getByText('MinIO · minio.lan:9000 · artifacts')).toBeInTheDocument();
    // AWS on its regional default has no endpoint, so the row names the region instead.
    await expect(canvas.getByText('AWS S3 · eu-west-1 · acme-reports')).toBeInTheDocument();
    await expect(canvas.getByText('Backblaze B2 · s3.us-west-004.backblazeb2.com · acme-backups')).toBeInTheDocument();
    await expect(canvas.getByText('RustFS · rustfs.lan:9000 · scratch')).toBeInTheDocument();
    await expect(canvas.getByText(`Key ${B2_BUCKET.accessKeyId}`)).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Add bucket' })).toBeInTheDocument();
  },
};

/** A secret sealed under an old BETTER_AUTH_SECRET: the row says so and asks for it again. */
export const UnreadableSecret: Story = {
  parameters: {
    apolloClient: { resolvers: bucketServer([MINIO_BUCKET, { ...S3_BUCKET, secretReadable: false }]).resolvers },
  },
  play: async ({ canvas, canvasElement }) => {
    const [, reports] = await rows(canvasElement);
    await expect(within(reports).getByText('Secret unreadable')).toBeVisible();
    await expect(within(reports).queryByRole('button', { name: 'Test Reports' })).not.toBeInTheDocument();
    await userEvent.click(within(reports).getByRole('button', { name: 'Re-enter secret' }));

    // Only the secret: the other fields stay as stored.
    const dialog = within(await within(canvasElement.ownerDocument.body).findByRole('dialog'));
    await expect(dialog.queryByLabelText(/^Name/)).not.toBeInTheDocument();
    const secret = dialog.getByLabelText(/^Secret access key/);
    await expect(secret).toBeRequired();
    await userEvent.type(secret, 'the-new-secret');
    await userEvent.click(dialog.getByRole('button', { name: 'Save secret' }));

    await waitFor(() => expect(within(reports).queryByText('Secret unreadable')).not.toBeInTheDocument());
    await expect(within(reports).getByRole('button', { name: 'Test Reports' })).toBeVisible();
    await expect(canvas.getByText('Artifacts')).toBeInTheDocument();
  },
};

/** The secret is tested before it is saved; a wrong one is refused in the dialog, which stays open. */
export const ReenterSecretRefused: Story = {
  parameters: {
    apolloClient: {
      resolvers: bucketServer([{ ...S3_BUCKET, secretReadable: false }], {
        saveRefusal: 'The test failed at HeadBucket (HTTP_403): access denied. Check the access key and secret.',
      }).resolvers,
    },
  },
  play: async ({ canvas, canvasElement }) => {
    await userEvent.click(await canvas.findByRole('button', { name: 'Re-enter secret' }));
    const dialog = within(await within(canvasElement.ownerDocument.body).findByRole('dialog'));
    await userEvent.type(dialog.getByLabelText(/^Secret access key/), 'wrong');
    await userEvent.click(dialog.getByRole('button', { name: 'Save secret' }));
    await expect(await dialog.findByText('Could not save the secret')).toBeInTheDocument();
    await expect(dialog.getByText(/HeadBucket/)).toBeInTheDocument();
  },
};

/** Test on a row: every step passed, and the report opens under it. */
export const TestPasses: Story = {
  parameters: { apolloClient: { resolvers: bucketServer(MIXED_BUCKETS, { test: TEST_PASSED }).resolvers } },
  play: async ({ canvas }) => {
    await userEvent.click(await canvas.findByRole('button', { name: 'Test Backups' }));
    const report = within(await canvas.findByRole('region', { name: 'Connection test' }));
    await expect(report.getByText('Connection works')).toBeInTheDocument();
    await expect(report.getAllByText('Passed')).toHaveLength(TEST_PASSED.steps.length);
  },
};

/** Test on a row that fails: the step, the S3 error code and its message, and what was skipped. */
export const TestFails: Story = {
  parameters: { apolloClient: { resolvers: bucketServer(MIXED_BUCKETS, { test: TEST_FAILED }).resolvers } },
  play: async ({ canvas }) => {
    await userEvent.click(await canvas.findByRole('button', { name: 'Test Reports' }));
    const report = within(await canvas.findByRole('region', { name: 'Connection test' }));
    await expect(report.getByRole('alert')).toHaveTextContent('Failed: reach the bucket');
    await expect(report.getAllByText(/SignatureDoesNotMatch/).length).toBeGreaterThan(0);
    await expect(report.getAllByText('Skipped')).toHaveLength(TEST_FAILED.steps.length - 1);
  },
};

/** Test that passes with a share-link warning: the bucket works, but links may not open. */
export const TestWarns: Story = {
  parameters: { apolloClient: { resolvers: bucketServer(MIXED_BUCKETS, { test: TEST_WARNED }).resolvers } },
  play: async ({ canvas }) => {
    await userEvent.click(await canvas.findByRole('button', { name: 'Test Artifacts' }));
    const report = within(await canvas.findByRole('region', { name: 'Connection test' }));
    await expect(report.getByText('Works, but share links may not open')).toBeInTheDocument();
    await expect(report.getByText('Warning')).toBeInTheDocument();
    await expect(report.queryByText('Failed')).not.toBeInTheDocument();
  },
};

/** Scanning from the row's menu: the report opens under that row and names what was added and what was not. */
export const Scans: Story = {
  parameters: { apolloClient: { resolvers: bucketServer(MIXED_BUCKETS, { scan: SCAN_ADDED }).resolvers } },
  play: async ({ canvas, canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'More for Backups' }));
    await userEvent.click(await page.findByRole('menuitem', { name: 'Scan for files' }));
    const report = within(await canvas.findByRole('region', { name: 'Scan of Backups' }));
    await expect(report.getByText('Added 12 files from “Backups”')).toBeInTheDocument();
    await expect(report.getByRole('list', { name: 'Files not added' })).toBeInTheDocument();
  },
};

/** A bucket whose secret is unreadable cannot be scanned until the secret is entered again. */
export const ScanNeedsTheSecret: Story = {
  parameters: {
    apolloClient: { resolvers: bucketServer([MINIO_BUCKET, { ...S3_BUCKET, secretReadable: false }]).resolvers },
  },
  play: async ({ canvas, canvasElement }) => {
    await userEvent.click(await canvas.findByRole('button', { name: 'More for Reports' }));
    const item = await within(canvasElement.ownerDocument.body).findByRole('menuitem', { name: 'Scan for files' });
    await expect(item).toHaveAttribute('aria-disabled', 'true');
    // Closed again, so the page is not left hidden behind an open menu.
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(item).not.toBeInTheDocument());
  },
};

/** A bucket that will not be listed: the refusal, under its row. */
export const ScanRefused: Story = {
  parameters: {
    apolloClient: {
      resolvers: bucketServer(MIXED_BUCKETS, {
        scan: 'The bucket refused to list its files (AccessDenied). The access key needs permission to list the bucket.',
      }).resolvers,
    },
  },
  play: async ({ canvas, canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'More for Backups' }));
    await userEvent.click(await page.findByRole('menuitem', { name: 'Scan for files' }));
    const alert = await canvas.findByRole('alert');
    await expect(alert).toHaveTextContent('Could not scan “Backups”');
    await expect(alert).toHaveTextContent(/permission to list/);
  },
};

/** Removing asks first, saying the objects stay at the provider, and the row leaves. */
export const Removes: Story = {
  parameters: { apolloClient: { resolvers: bucketServer(MIXED_BUCKETS).resolvers } },
  play: async ({ canvas, canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'More for Scratch' }));
    await userEvent.click(await page.findByRole('menuitem', { name: 'Remove' }));
    const question = within(await page.findByRole('alertdialog'));
    await expect(question.getByText(/stay as they are at the provider/)).toBeInTheDocument();
    await userEvent.click(question.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(canvas.queryByText('Scratch')).not.toBeInTheDocument());
    await expect(await rows(canvasElement)).toHaveLength(MIXED_BUCKETS.length - 1);
  },
};

/** A bucket with documents is refused; forgetting them, after a second question, removes it. */
export const RemoveNeedsForgetting: Story = {
  parameters: { apolloClient: { resolvers: bucketServer(MIXED_BUCKETS, { hasDocuments: true }).resolvers } },
  play: async ({ canvas, canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'More for Backups' }));
    await userEvent.click(await page.findByRole('menuitem', { name: 'Remove' }));
    await userEvent.click(within(await page.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }));

    const refusal = await canvas.findByRole('alert');
    await expect(refusal).toHaveTextContent('Could not remove “Backups”');
    await expect(refusal).toHaveTextContent(/still in this bucket/);
    await userEvent.click(within(refusal).getByRole('button', { name: 'Forget its documents' }));
    const second = within(await page.findByRole('alertdialog'));
    await expect(second.getByText(/objects stay in the bucket/)).toBeInTheDocument();
    await userEvent.click(second.getByRole('button', { name: 'Forget and remove' }));
    await waitFor(() => expect(canvas.queryByText('Backups')).not.toBeInTheDocument());
    await expect(canvas.queryByRole('alert')).not.toBeInTheDocument();
  },
};

/** Phone width: the rows, their badges and buttons fit, and nothing pushes the page sideways. */
export const Narrow: Story = {
  globals: { viewport: { value: 'mobile1' } },
  play: async ({ canvas, canvasElement }) => {
    await rows(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Test Artifacts' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'More for Artifacts' })).toBeVisible();
    // Every row's buttons stay inside the list rather than being pushed past its edge.
    const list = canvas.getByRole('list', { name: 'Buckets' });
    const edge = list.getBoundingClientRect().right;
    for (const button of within(list).getAllByRole('button')) {
      await expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(edge + 1);
    }
    await expect(canvasElement.ownerDocument.documentElement.scrollWidth).toBeLessThanOrEqual(
      canvasElement.ownerDocument.documentElement.clientWidth,
    );
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};
