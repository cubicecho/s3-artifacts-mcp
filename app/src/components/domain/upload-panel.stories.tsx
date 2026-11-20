import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { UPLOAD_DEFAULTS } from '@/defaults';
import { rememberBucket } from '@/lib/last-bucket';
import { UploadSendContext } from '@/lib/upload';
import { B2_BUCKET, type BucketFixture, MINIO_BUCKET, RUSTFS_BUCKET, S3_BUCKET } from './bucket-fixtures';
import { documentServer, type SendOutcome, UPLOAD_LIMIT_BYTES } from './document-fixtures';
import { UploadPanel } from './upload-panel';

/**
 * The upload panel against a mock server built from the real SDL, with the PUT answered by the
 * same mock (`documentServer().send`, handed in through `UploadSendContext`), so nothing crosses
 * the network. Each file is created as a document, then its bytes are sent; the branches worth
 * watching are between those two calls.
 */

type ServerOptions = Parameters<typeof documentServer>[2];

/**
 * A story's server and the panel wired to it.
 *
 * @param buckets - The buckets the server holds and the picker offers.
 * @param options - How its sends and mutations answer.
 * @returns The story's parameters and render, and the server to inspect in `play`.
 */
function withServer(buckets: readonly BucketFixture[], options: ServerOptions = {}) {
  const server = documentServer(buckets, [], { stepMs: 20, ...options });
  return {
    server,
    story: {
      args: { buckets },
      parameters: { apolloClient: { resolvers: server.resolvers } },
      render: (args: Parameters<typeof UploadPanel>[0]) => (
        <UploadSendContext.Provider value={server.send}>
          <UploadPanel {...args} />
        </UploadSendContext.Provider>
      ),
    },
  };
}

/** Sends answered by filename. */
function outcomes(byName: Record<string, SendOutcome>) {
  return (filename: string) => byName[filename] ?? 'ok';
}

/** How long a picked file is, when its length is not the subject. */
const SMALL_FILE_BYTES = 1024;

function file(name: string, bytes = SMALL_FILE_BYTES, type = 'application/pdf'): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

/** A file that says it is `bytes` long without holding them, for a size past the limit. */
function hugeFile(name: string, bytes: number): File {
  const huge = file(name, 1, 'video/mp4');
  Object.defineProperty(huge, 'size', { value: bytes });
  return huge;
}

/** A file as a folder pick hands it over, with its place in the folder. */
function inFolder(path: string, type = 'image/jpeg'): File {
  const picked = file(path.split('/').pop() ?? path, SMALL_FILE_BYTES, type);
  Object.defineProperty(picked, 'webkitRelativePath', { value: path });
  return picked;
}

/**
 * The drop zone's file input, or the folder button's, found by selector: both are hidden behind
 * the control that opens them, so they are absent from the accessibility tree.
 */
function fileInput(canvasElement: HTMLElement, folder = false): HTMLInputElement {
  const inputs = Array.from(canvasElement.querySelectorAll('input[type="file"]'));
  const input = inputs.find((entry) => entry.hasAttribute('webkitdirectory') === folder);
  if (input instanceof HTMLInputElement) {
    return input;
  }
  throw new Error('The upload panel rendered no file input');
}

/** The rows of the upload list. */
async function jobRows(canvasElement: HTMLElement) {
  const list = await within(canvasElement).findByRole('list', { name: 'Uploads' });
  return within(list).getAllByRole('listitem');
}

/** The row for one file. */
async function jobRow(canvasElement: HTMLElement, name: string) {
  const rows = await jobRows(canvasElement);
  const row = rows.find((entry) => within(entry).queryByText(name) !== null);
  if (row === undefined) {
    throw new Error(`No upload row for ${name}`);
  }
  return within(row);
}

const meta = {
  title: 'Domain/UploadPanel',
  component: UploadPanel,
  args: { buckets: [MINIO_BUCKET], onUploaded: fn(), onBusyChange: fn() },
  parameters: { layout: 'padded' },
  beforeEach: () => {
    // The last bucket used lives in this browser; a story that relies on it sets it itself.
    window.localStorage.removeItem('s3am_last_bucket');
  },
} satisfies Meta<typeof UploadPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

const single = withServer([MINIO_BUCKET]);
/** One bucket: it is chosen already, and nothing is uploading yet. */
export const Idle: Story = {
  ...single.story,
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('combobox', { name: /Upload into/ })).toHaveTextContent('Artifacts');
    await expect(canvas.getByRole('button', { name: /Drop files or a folder here/ })).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Upload a folder' })).toBeInTheDocument();
    await expect(canvas.queryByRole('list', { name: 'Uploads' })).not.toBeInTheDocument();
  },
};

const several = withServer([MINIO_BUCKET, S3_BUCKET, B2_BUCKET]);
/** Several buckets and nothing to go on: none is chosen, and files picked anyway are not sent. */
export const NoBucketChosen: Story = {
  ...several.story,
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('combobox', { name: /Upload into/ })).toHaveTextContent('Choose a bucket');
    await userEvent.upload(fileInput(canvasElement), file('scan.pdf'));
    await expect(await canvas.findByText(/Choose a bucket to upload into first/)).toBeInTheDocument();
    await expect(several.server.calls.createDocumentUpload).toHaveLength(0);
  },
};

const filtered = withServer([MINIO_BUCKET, S3_BUCKET, B2_BUCKET]);
/** The documents page is filtered to a bucket, so the picker starts there. */
export const PreselectsTheFilteredBucket: Story = {
  ...filtered.story,
  args: { ...filtered.story.args, preferredSlug: S3_BUCKET.slug },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('combobox', { name: /Upload into/ })).toHaveTextContent('Reports');
  },
};

const remembered = withServer([MINIO_BUCKET, S3_BUCKET, B2_BUCKET]);
/** With no filter, the bucket last uploaded to in this browser. */
export const PreselectsTheLastUsed: Story = {
  ...remembered.story,
  beforeEach: () => {
    rememberBucket(B2_BUCKET.id);
    return () => window.localStorage.removeItem('s3am_last_bucket');
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('combobox', { name: /Upload into/ })).toHaveTextContent('Backups');
  },
};

const locked = withServer([MINIO_BUCKET, { ...RUSTFS_BUCKET, secretReadable: false }]);
/** A bucket whose secret cannot be read is listed, says why, and cannot be chosen. */
export const UnreadableBucketCannotBeChosen: Story = {
  ...locked.story,
  play: async ({ canvas, canvasElement }) => {
    // The other one is the only bucket that can take files, so it is chosen.
    const picker = canvas.getByRole('combobox', { name: /Upload into/ });
    await expect(picker).toHaveTextContent('Artifacts');
    await userEvent.click(picker);
    const page = within(canvasElement.ownerDocument.body);
    const scratch = await page.findByRole('option', { name: /Scratch/ });
    await expect(scratch).toHaveAttribute('aria-disabled', 'true');
    await expect(scratch).toHaveTextContent('Scratch (secret unreadable)');
    // Closed by choosing the one that can be chosen: the open menu is not what this story checks.
    await userEvent.click(page.getByRole('option', { name: 'Artifacts' }));
    await waitFor(() => expect(page.queryByRole('listbox')).not.toBeInTheDocument());
  },
};

const sending = withServer([MINIO_BUCKET], { send: () => 'hang' });
/** A file on its way: its own bar, its percentage, and a cancel that stops it. */
export const InProgress: Story = {
  ...sending.story,
  play: async ({ args, canvasElement }) => {
    await userEvent.upload(fileInput(canvasElement), file('scan.pdf'));
    const row = await jobRow(canvasElement, 'scan.pdf');
    await waitFor(() => expect(row.getByText('50%')).toBeInTheDocument());
    await expect(row.getByRole('progressbar', { name: 'scan.pdf upload progress' })).toHaveAttribute(
      'aria-valuenow',
      '50',
    );
    await expect(args.onBusyChange).toHaveBeenLastCalledWith(true);

    await userEvent.click(row.getByRole('button', { name: 'Cancel scan.pdf' }));
    await waitFor(() => expect(row.getByText('Cancelled')).toBeInTheDocument());
    await expect(row.getByRole('button', { name: 'Retry scan.pdf' })).toBeInTheDocument();
    await expect(args.onBusyChange).toHaveBeenLastCalledWith(false);
    await expect(args.onUploaded).not.toHaveBeenCalled();
  },
};

const succeeding = withServer([MINIO_BUCKET]);
/** A batch of mixed files lands, each with its own row, and the lists are told once at the end. */
export const Succeeded: Story = {
  ...succeeding.story,
  play: async ({ args, canvasElement }) => {
    await userEvent.upload(fileInput(canvasElement), [
      file('scan.pdf'),
      file('photo.png', SMALL_FILE_BYTES, 'image/png'),
      file('notes.md', SMALL_FILE_BYTES, ''),
    ]);
    for (const name of ['scan.pdf', 'photo.png', 'notes.md']) {
      const row = await jobRow(canvasElement, name);
      await waitFor(() => expect(row.getByText('Uploaded')).toBeInTheDocument());
      await expect(row.getByRole('link', { name: `Open ${name}` })).toBeInTheDocument();
    }
    await waitFor(() => expect(args.onUploaded).toHaveBeenCalledTimes(1));
    // A type the browser left blank is named from the extension.
    await expect(succeeding.server.calls.createDocumentUpload).toContainEqual(
      expect.objectContaining({ filename: 'notes.md', contentType: 'text/markdown', bucketId: MINIO_BUCKET.id }),
    );
    await expect(succeeding.server.documents.every((document) => document.status === 'ready')).toBe(true);
  },
};

const capped = withServer([MINIO_BUCKET]);
/** A file over the server's limit is refused on its own row; the rest of the batch still goes. */
export const CapExceeded: Story = {
  ...capped.story,
  play: async ({ canvasElement }) => {
    await userEvent.upload(fileInput(canvasElement), [
      hugeFile('recording.mp4', UPLOAD_LIMIT_BYTES + 1),
      file('a.pdf'),
    ]);
    const huge = await jobRow(canvasElement, 'recording.mp4');
    await waitFor(() => expect(huge.getByText('Failed')).toBeInTheDocument());
    await expect(huge.getByText(/larger than the 100 MiB upload limit/)).toBeInTheDocument();
    const small = await jobRow(canvasElement, 'a.pdf');
    await waitFor(() => expect(small.getByText('Uploaded')).toBeInTheDocument());
    // Refused before any bytes were sent.
    await expect(capped.server.calls.sends).toEqual(['a.pdf']);
  },
};

const refused = withServer([MINIO_BUCKET], {
  send: (filename, attempt) => (filename === 'scan.pdf' && attempt === 1 ? 'refuse' : 'ok'),
});
/** The server refuses the bytes with its own message; Retry starts the file over, and it lands. */
export const FailedThenRetried: Story = {
  ...refused.story,
  play: async ({ args, canvasElement }) => {
    await userEvent.upload(fileInput(canvasElement), file('scan.pdf'));
    const row = await jobRow(canvasElement, 'scan.pdf');
    await waitFor(() => expect(row.getByText('Failed')).toBeInTheDocument());
    await expect(row.getByText('The bucket refused the object: AccessDenied')).toBeInTheDocument();

    await userEvent.click(row.getByRole('button', { name: 'Retry scan.pdf' }));
    await waitFor(() => expect(row.getByText('Uploaded')).toBeInTheDocument());
    // A refused upload leaves no document behind, so the retry made a new one.
    await expect(refused.server.calls.createDocumentUpload).toHaveLength(2);
    await expect(refused.server.documents).toHaveLength(1);
    await waitFor(() => expect(args.onUploaded).toHaveBeenCalledTimes(1));
  },
};

const offline = withServer([MINIO_BUCKET], { send: outcomes({ 'scan.pdf': 'network' }) });
/** The server cannot be reached mid-send: said in words a person can act on. */
export const NetworkFailure: Story = {
  ...offline.story,
  play: async ({ args, canvasElement }) => {
    await userEvent.upload(fileInput(canvasElement), file('scan.pdf'));
    const row = await jobRow(canvasElement, 'scan.pdf');
    await waitFor(() => expect(row.getByText('Failed')).toBeInTheDocument());
    await expect(row.getByText('Could not reach the server')).toBeInTheDocument();
    await expect(args.onUploaded).not.toHaveBeenCalled();
  },
};

const queued = withServer([MINIO_BUCKET], { send: () => 'hang' });
/** Five files at once: three are sent, two wait for a free slot. */
export const ThreeAtATime: Story = {
  ...queued.story,
  play: async ({ canvasElement }) => {
    await userEvent.upload(
      fileInput(canvasElement),
      ['1.pdf', '2.pdf', '3.pdf', '4.pdf', '5.pdf'].map((name) => file(name)),
    );
    await waitFor(() => expect(queued.server.calls.sends).toHaveLength(UPLOAD_DEFAULTS.concurrency));
    const rows = await jobRows(canvasElement);
    await expect(rows.filter((row) => within(row).queryByText('Waiting') !== null)).toHaveLength(2);

    // A waiting file can be cancelled before it starts, and is never sent.
    const fifth = await jobRow(canvasElement, '5.pdf');
    await userEvent.click(fifth.getByRole('button', { name: 'Cancel 5.pdf' }));
    await expect(fifth.getByText('Cancelled')).toBeInTheDocument();
    const first = await jobRow(canvasElement, '1.pdf');
    await userEvent.click(first.getByRole('button', { name: 'Cancel 1.pdf' }));
    // The freed slot goes to the fourth, not the cancelled fifth.
    await waitFor(() => expect(queued.server.calls.sends).toEqual(['1.pdf', '2.pdf', '3.pdf', '4.pdf']));
  },
};

const folder = withServer([MINIO_BUCKET]);
/** A picked folder uploads its files side by side, under their own names; system files stay behind. */
export const FolderFlattened: Story = {
  ...folder.story,
  play: async ({ canvas, canvasElement }) => {
    const input = fileInput(canvasElement, true);
    // user-event hands a non-`multiple` input only the first file; a real folder pick hands over all.
    input.multiple = true;
    await userEvent.upload(input, [
      inFolder('Trip/beach.jpg'),
      inFolder('Trip/2026/day-two/dunes.jpg'),
      inFolder('Trip/.DS_Store', ''),
      inFolder('Trip/@eaDir/beach.jpg'),
    ]);
    await waitFor(async () => expect(await jobRows(canvasElement)).toHaveLength(2));
    for (const name of ['beach.jpg', 'dunes.jpg']) {
      const row = await jobRow(canvasElement, name);
      await waitFor(() => expect(row.getByText('Uploaded')).toBeInTheDocument());
    }
    await expect(folder.server.calls.createDocumentUpload.map((call) => call.filename)).toEqual([
      'beach.jpg',
      'dunes.jpg',
    ]);
    await expect(canvas.getByText('2 files left out')).toBeInTheDocument();
  },
};
