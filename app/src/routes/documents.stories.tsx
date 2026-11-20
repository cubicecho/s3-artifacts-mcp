import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { B2_BUCKET, type BucketFixture, MINIO_BUCKET, S3_BUCKET } from '@/components/domain/bucket-fixtures';
import {
  type DocumentFixture,
  documentServer,
  IMAGE_DOCUMENT,
  MARKDOWN_DOCUMENT,
  MIXED_DOCUMENTS,
  PDF_DOCUMENT,
} from '@/components/domain/document-fixtures';
import { AppLayout } from '@/components/layouts/app-layout';
import { bucketDocumentsPath, documentPath, ROUTES } from '@/lib/routes';
import { settingsLink } from '@/lib/settings-tabs';
import { UploadSendContext } from '@/lib/upload';
import { DocumentsRoute } from './documents';

/**
 * The documents page against a mock server built from the real SDL: no buckets, buckets with
 * nothing in them, and a table of documents filtered by the bucket in the URL. The upload stories
 * run the page in its shell, so they show the table and the sidebar's tree both pick the new file up.
 */

type ServerOptions = Parameters<typeof documentServer>[2];

/**
 * A story's server, and the page wired to it.
 *
 * @param buckets - The buckets the server holds.
 * @param documents - The documents in them.
 * @param options - How its sends and mutations answer.
 * @returns The story's parameters and the server to inspect in `play`.
 */
function withServer(
  buckets: readonly BucketFixture[],
  documents: readonly DocumentFixture[] = [],
  options: ServerOptions = {},
) {
  const server = documentServer(buckets, documents, { stepMs: 10, ...options });
  return { server, parameters: { apolloClient: { resolvers: server.resolvers } } };
}

/** Bounded height, because `PageLayout` is a sticky chassis that scrolls its own body. */
function Framed() {
  return (
    <div className="h-screen">
      <DocumentsRoute />
    </div>
  );
}

/**
 * The upload dialog's drop-zone input, found by selector: it is hidden behind the zone.
 *
 * @param body - The document body, which the dialog's portal is in.
 * @returns The input.
 */
function dialogFileInput(body: HTMLElement): HTMLInputElement {
  const input = body.querySelector('[role="dialog"] input[type="file"]:not([webkitdirectory])');
  if (input instanceof HTMLInputElement) {
    return input;
  }
  throw new Error('The upload dialog has no file input');
}

const meta = {
  title: 'Routes/Documents',
  component: DocumentsRoute,
  render: () => <Framed />,
  parameters: {
    layout: 'fullscreen',
    router: { initialEntries: [ROUTES.documents] },
    ...withServer([]).parameters,
  },
} satisfies Meta<typeof DocumentsRoute>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The table's body rows. */
async function tableRows(canvasElement: HTMLElement) {
  const table = await within(canvasElement).findByRole('table', { name: 'Documents' });
  const [, ...rows] = within(table).getAllByRole('row');
  return rows;
}

/** No buckets yet: the empty state is the page's body, and its one action goes to Settings → Buckets. */
export const NoBuckets: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('heading', { level: 1, name: 'Documents' })).toBeInTheDocument();
    await expect(await canvas.findByRole('heading', { level: 2, name: 'No buckets yet' })).toBeVisible();
    await expect(canvas.getByText(/Backblaze B2/)).toBeInTheDocument();
    await expect(canvas.getByRole('link', { name: 'Add a bucket' })).toHaveAttribute('href', settingsLink('buckets'));
    await expect(canvas.queryByRole('button', { name: 'Upload' })).not.toBeInTheDocument();
  },
};

/** At phone width the empty state still fits, and nothing pushes the page sideways. */
export const NoBucketsNarrow: Story = {
  globals: { viewport: { value: 'mobile1' } },
  play: async ({ canvas, canvasElement }) => {
    await expect(await canvas.findByRole('link', { name: 'Add a bucket' })).toBeVisible();
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};

/** Before the answer lands: placeholder rows, never "no buckets". */
export const Loading: Story = {
  parameters: { apolloClient: { ...withServer([MINIO_BUCKET]).parameters.apolloClient, delay: 100_000 } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('status')).toHaveAccessibleName('Loading');
    await expect(canvas.queryByText('No buckets yet')).not.toBeInTheDocument();
  },
};

/** The server failed: the reason and a retry, never "no buckets". */
export const Failed: Story = {
  parameters: withServer([], [], { failBuckets: 'The database is not answering' }).parameters,
  play: async ({ canvas }) => {
    await expect(await canvas.findByText(/Could not load your documents/)).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    await expect(canvas.queryByText('No buckets yet')).not.toBeInTheDocument();
  },
};

/** Buckets, but nothing in them: the invitation is to upload. */
export const NoDocuments: Story = {
  parameters: withServer([MINIO_BUCKET, S3_BUCKET]).parameters,
  play: async ({ canvas, canvasElement }) => {
    await expect(await canvas.findByRole('heading', { level: 2, name: 'No documents yet' })).toBeVisible();
    const uploads = canvas.getAllByRole('button', { name: 'Upload' });
    // One in the header, one in the empty state.
    await expect(uploads).toHaveLength(2);
    await userEvent.click(uploads[1] as HTMLElement);
    const dialog = within(await within(canvasElement.ownerDocument.body).findByRole('dialog'));
    await expect(dialog.getByRole('heading', { name: 'Upload documents' })).toBeInTheDocument();
  },
};

/** Every document in every bucket, newest first, each a link to its page. */
export const Filled: Story = {
  parameters: withServer([MINIO_BUCKET, S3_BUCKET], MIXED_DOCUMENTS).parameters,
  play: async ({ canvasElement }) => {
    const rows = await tableRows(canvasElement);
    await expect(rows).toHaveLength(MIXED_DOCUMENTS.length);
    const [newest, second] = rows;
    const first = within(newest as HTMLElement);
    await expect(first.getByRole('link', { name: PDF_DOCUMENT.title })).toHaveAttribute(
      'href',
      documentPath(PDF_DOCUMENT.id),
    );
    await expect(first.getByText('Artifacts')).toBeInTheDocument();
    await expect(first.getByText('PDF')).toBeInTheDocument();
    await expect(first.getByText('470.8 KB')).toBeInTheDocument();
    await expect(within(second as HTMLElement).getByText('SVG image')).toBeInTheDocument();
  },
};

/** `?bucket=` filters the table to that bucket, and the filter says which. */
export const FilteredByBucket: Story = {
  parameters: {
    ...withServer([MINIO_BUCKET, S3_BUCKET], MIXED_DOCUMENTS).parameters,
    router: { initialEntries: [bucketDocumentsPath(S3_BUCKET.slug)] },
  },
  play: async ({ canvas, canvasElement }) => {
    const rows = await tableRows(canvasElement);
    const inReports = MIXED_DOCUMENTS.filter((document) => document.bucketId === S3_BUCKET.id);
    await expect(rows).toHaveLength(inReports.length);
    await expect(canvas.getByRole('combobox', { name: 'Bucket' })).toHaveTextContent('Reports');
    await expect(canvas.queryByRole('link', { name: PDF_DOCUMENT.title })).not.toBeInTheDocument();
  },
};

/** Choosing a bucket in the filter narrows the table, and "All buckets" widens it again. */
export const ChoosesABucket: Story = {
  parameters: withServer([MINIO_BUCKET, S3_BUCKET], MIXED_DOCUMENTS).parameters,
  play: async ({ canvas, canvasElement }) => {
    await tableRows(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('combobox', { name: 'Bucket' }));
    await userEvent.click(await page.findByRole('option', { name: 'Reports' }));
    // The rest of the page is hidden from the accessibility tree until the menu has gone.
    await waitFor(() => expect(page.queryByRole('listbox')).not.toBeInTheDocument());
    await expect(await canvas.findByRole('link', { name: MARKDOWN_DOCUMENT.title })).toBeInTheDocument();
    await expect(canvas.queryByRole('link', { name: PDF_DOCUMENT.title })).not.toBeInTheDocument();

    await userEvent.click(canvas.getByRole('combobox', { name: 'Bucket' }));
    await userEvent.click(await page.findByRole('option', { name: 'All buckets' }));
    await waitFor(() => expect(page.queryByRole('listbox')).not.toBeInTheDocument());
    await expect(await canvas.findByRole('link', { name: PDF_DOCUMENT.title })).toBeInTheDocument();
  },
};

/** A bucket with nothing in it, filtered to: one line, and an upload straight into it. */
export const FilteredToAnEmptyBucket: Story = {
  parameters: {
    ...withServer([MINIO_BUCKET, B2_BUCKET], [PDF_DOCUMENT]).parameters,
    router: { initialEntries: [bucketDocumentsPath(B2_BUCKET.slug)] },
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(await canvas.findByText('Nothing in “Backups” yet.')).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Upload into it' }));
    const dialog = within(await within(canvasElement.ownerDocument.body).findByRole('dialog'));
    // The filtered bucket is the one the panel starts on.
    await expect(dialog.getByRole('combobox', { name: /Upload into/ })).toHaveTextContent('Backups');
  },
};

/**
 * Nothing listed yet, but files already in a bucket: scanning adds them, the table shows them, and each
 * bucket's report stays over it.
 */
export const ScansForExistingFiles: Story = {
  parameters: withServer([MINIO_BUCKET, S3_BUCKET], [], {
    bucketFiles: { [MINIO_BUCKET.id]: ['2024/notes.txt', 'readme.txt'] },
  }).parameters,
  play: async ({ canvas, canvasElement }) => {
    await expect(await canvas.findByRole('heading', { level: 2, name: 'No documents yet' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Scan for files' }));
    await waitFor(async () => expect(await tableRows(canvasElement)).toHaveLength(2));
    await expect(canvas.getByRole('link', { name: '2024/notes' })).toBeInTheDocument();
    await expect(canvas.getByText(`Added 2 files from “${MINIO_BUCKET.name}”`)).toBeInTheDocument();
    await expect(canvas.getByText(`Nothing new in “${S3_BUCKET.name}”`)).toBeInTheDocument();
  },
};

/** An empty bucket in the filter: scanning it scans that bucket alone. */
export const ScansTheFilteredBucket: Story = {
  parameters: {
    ...withServer([MINIO_BUCKET, B2_BUCKET], [PDF_DOCUMENT], {
      bucketFiles: { [B2_BUCKET.id]: ['old-backup.txt'], [MINIO_BUCKET.id]: ['not-this-one.txt'] },
    }).parameters,
    router: { initialEntries: [bucketDocumentsPath(B2_BUCKET.slug)] },
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(await canvas.findByText('Nothing in “Backups” yet.')).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Scan it for files' }));
    await waitFor(async () => expect(await tableRows(canvasElement)).toHaveLength(1));
    await expect(canvas.getByRole('link', { name: 'old-backup' })).toBeInTheDocument();
    await expect(canvas.getByText('Added 1 file from “Backups”')).toBeInTheDocument();
    await expect(canvas.queryByText(new RegExp(MINIO_BUCKET.name))).not.toBeInTheDocument();
  },
};

/**
 * Phone width: there is no sidebar, so the table is the way to every document. It fits the
 * screen, with the type and date columns left out, and nothing scrolls sideways.
 */
export const Narrow: Story = {
  globals: { viewport: { value: 'mobile1' } },
  parameters: withServer([MINIO_BUCKET, S3_BUCKET], MIXED_DOCUMENTS).parameters,
  play: async ({ canvas, canvasElement }) => {
    const rows = await tableRows(canvasElement);
    for (const row of rows) {
      await expect(within(row).getByRole('link')).toBeVisible();
    }
    await expect(canvas.getByText('Type', { selector: 'th' })).not.toBeVisible();
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};

const uploading = withServer([MINIO_BUCKET, S3_BUCKET], [IMAGE_DOCUMENT]);
/**
 * The page in its shell: an upload into the filtered bucket lands in the table and in the
 * sidebar's count, and the tree stays shut — nothing opens a bucket but a press.
 */
export const UploadRefreshesTheListAndTree: Story = {
  parameters: { ...uploading.parameters, router: { initialEntries: [bucketDocumentsPath(MINIO_BUCKET.slug)] } },
  render: () => (
    <UploadSendContext.Provider value={uploading.server.send}>
      <AppLayout contentSlot={<DocumentsRoute />} />
    </UploadSendContext.Provider>
  ),
  play: async ({ canvas, canvasElement }) => {
    const tree = within(await canvas.findByRole('list', { name: 'Buckets and documents' }));
    const artifacts = tree.getByRole('button', { name: /^Artifacts/ });
    await expect(artifacts).toHaveTextContent('1');

    const main = within(canvas.getByRole('main'));
    await userEvent.click(await main.findByRole('button', { name: 'Upload' }));
    const body = canvasElement.ownerDocument.body;
    const dialog = within(await within(body).findByRole('dialog'));
    await userEvent.upload(dialogFileInput(body), new File(['# Hello'], 'hello.md', { type: 'text/markdown' }));
    await waitFor(() => expect(dialog.getByText('Uploaded')).toBeInTheDocument());
    await userEvent.click(dialog.getByRole('button', { name: 'Close' }));

    await expect(await main.findByRole('link', { name: 'hello' })).toBeInTheDocument();
    await waitFor(() => expect(artifacts).toHaveTextContent('2'));
    await expect(artifacts).toHaveAttribute('aria-expanded', 'false');
    await expect(tree.queryByRole('link', { name: 'hello' })).not.toBeInTheDocument();
  },
};

const keepsOpen = withServer([MINIO_BUCKET, S3_BUCKET], [IMAGE_DOCUMENT]);
/** A bucket the owner opened stays open through an upload into it, and shows the new file. */
export const UploadKeepsAnOpenBucketOpen: Story = {
  parameters: { ...keepsOpen.parameters, router: { initialEntries: [bucketDocumentsPath(MINIO_BUCKET.slug)] } },
  render: () => (
    <UploadSendContext.Provider value={keepsOpen.server.send}>
      <AppLayout contentSlot={<DocumentsRoute />} />
    </UploadSendContext.Provider>
  ),
  play: async ({ canvas, canvasElement }) => {
    const sidebar = () => within(canvas.getByRole('list', { name: 'Buckets and documents' }));
    await canvas.findByRole('list', { name: 'Buckets and documents' });
    await userEvent.click(sidebar().getByRole('button', { name: /^Artifacts/ }));
    await expect(sidebar().getByRole('button', { name: /^Artifacts/ })).toHaveAttribute('aria-expanded', 'true');

    const main = within(canvas.getByRole('main'));
    await userEvent.click(await main.findByRole('button', { name: 'Upload' }));
    const body = canvasElement.ownerDocument.body;
    const dialog = within(await within(body).findByRole('dialog'));
    await userEvent.upload(dialogFileInput(body), new File(['# Hello'], 'hello.md', { type: 'text/markdown' }));
    await waitFor(() => expect(dialog.getByText('Uploaded')).toBeInTheDocument());
    await userEvent.click(dialog.getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(sidebar().getByRole('link', { name: 'hello' })).toBeInTheDocument());
    await expect(sidebar().getByRole('button', { name: /^Artifacts/ })).toHaveAttribute('aria-expanded', 'true');
  },
};

const stopping = withServer([MINIO_BUCKET], [], { send: () => 'hang' });
/** Closing the dialog while a file is on its way asks first, because closing stops it. */
export const ClosingStopsUploads: Story = {
  parameters: stopping.parameters,
  render: () => (
    <UploadSendContext.Provider value={stopping.server.send}>
      <Framed />
    </UploadSendContext.Provider>
  ),
  play: async ({ canvas, canvasElement }) => {
    const body = canvasElement.ownerDocument.body;
    const page = within(body);
    const [headerUpload] = await canvas.findAllByRole('button', { name: 'Upload' });
    await userEvent.click(headerUpload as HTMLElement);
    const dialog = within(await page.findByRole('dialog'));
    await userEvent.upload(dialogFileInput(body), new File(['x'], 'big.pdf', { type: 'application/pdf' }));
    await waitFor(() => expect(dialog.getByText('50%')).toBeInTheDocument());
    await userEvent.click(dialog.getByRole('button', { name: 'Close' }));
    const question = within(await page.findByRole('alertdialog'));
    await expect(question.getByText('Stop the uploads?')).toBeInTheDocument();
    await userEvent.click(question.getByRole('button', { name: 'Stop uploads' }));
    await waitFor(() => expect(page.queryByRole('dialog')).not.toBeInTheDocument());
    // The send was stopped, and the server dropped the half-sent document.
    await waitFor(() => expect(stopping.server.documents).toHaveLength(0));
  },
};
