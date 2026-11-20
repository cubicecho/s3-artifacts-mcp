import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { MINIO_BUCKET, S3_BUCKET } from './bucket-fixtures';
import {
  AUDIO_DOCUMENT,
  BROKEN_PICTURE,
  CSV_DOCUMENT,
  type DocumentFixture,
  documentServer,
  HTML_DOCUMENT,
  IMAGE_DOCUMENT,
  JSON_DOCUMENT,
  LARGE_TEXT_DOCUMENT,
  MARKDOWN_DOCUMENT,
  PDF_DOCUMENT,
  TEXT_DOCUMENT,
  VIDEO_DOCUMENT,
  ZIP_DOCUMENT,
} from './document-fixtures';
import { DocumentPreviewCard } from './document-preview-card';

/**
 * The preview, one story per kind of file. The content URL is a `data:` URL holding the bytes,
 * from a mock server built from the real SDL, so nothing crosses the network.
 */

type ServerOptions = Parameters<typeof documentServer>[2];

/**
 * A story previewing one document.
 *
 * @param document - The document.
 * @param options - How the server's content URL answers.
 * @returns The story's args and parameters, and the server to inspect.
 */
function preview(document: DocumentFixture, options: ServerOptions = {}) {
  const server = documentServer([MINIO_BUCKET, S3_BUCKET], [document], options);
  return {
    server,
    story: { args: { document }, parameters: { apolloClient: { resolvers: server.resolvers } } },
  };
}

const meta = {
  title: 'Domain/DocumentPreviewCard',
  component: DocumentPreviewCard,
  args: { document: PDF_DOCUMENT },
  parameters: { layout: 'padded' },
} satisfies Meta<typeof DocumentPreviewCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** While the content URL is asked for, the card waits rather than showing nothing. */
export const Loading: Story = {
  args: { document: PDF_DOCUMENT },
  parameters: {
    apolloClient: { resolvers: documentServer([MINIO_BUCKET], [PDF_DOCUMENT]).resolvers, delay: 100_000 },
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('heading', { name: 'Preview' })).toBeInTheDocument();
    await expect(canvas.queryByTitle(/Preview of/)).not.toBeInTheDocument();
  },
};

const pdf = preview(PDF_DOCUMENT);
/** A PDF in a frame, pointed at its content URL. */
export const Pdf: Story = {
  ...pdf.story,
  play: async ({ canvas }) => {
    const frame = await canvas.findByTitle('Preview of Quarterly report');
    await expect(frame.tagName).toBe('IFRAME');
    await expect(frame).toHaveAttribute('src', PDF_DOCUMENT.content);
    await expect(pdf.server.calls.contentUrl).toEqual([{ id: PDF_DOCUMENT.id, download: false }]);
  },
};

const image = preview(IMAGE_DOCUMENT);
/** A picture, drawn by the browser. */
export const Image: Story = {
  ...image.story,
  play: async ({ canvas }) => {
    const picture = await canvas.findByRole('img', { name: 'Architecture diagram' });
    await waitFor(() => expect((picture as HTMLImageElement).naturalWidth).toBeGreaterThan(0));
  },
};

const expired = preview(IMAGE_DOCUMENT, {
  contentUrl: (document, asked) => (asked === 1 ? BROKEN_PICTURE : document.content),
});
/** The first URL no longer loads (it expired): a fresh one is asked for, once, and the picture shows. */
export const ExpiredUrlIsRefreshed: Story = {
  ...expired.story,
  play: async ({ canvas }) => {
    await waitFor(() => expect(expired.server.calls.contentUrl).toHaveLength(2));
    const picture = await canvas.findByRole('img', { name: 'Architecture diagram' });
    await waitFor(() => expect((picture as HTMLImageElement).naturalWidth).toBeGreaterThan(0));
    await expect(canvas.queryByText('Could not load the preview')).not.toBeInTheDocument();
  },
};

const broken = preview(IMAGE_DOCUMENT, { contentUrl: () => BROKEN_PICTURE });
/** A file that fails twice says so, with a way to try again. */
export const LoadFails: Story = {
  ...broken.story,
  play: async ({ canvas }) => {
    await expect(await canvas.findByText('Could not load the preview')).toBeInTheDocument();
    await expect(broken.server.calls.contentUrl).toHaveLength(2);
    await userEvent.click(canvas.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(broken.server.calls.contentUrl.length).toBeGreaterThan(2));
  },
};

const audio = preview(AUDIO_DOCUMENT);
/** Audio in the browser's own player. It loads nothing until played. */
export const Audio: Story = {
  ...audio.story,
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelector('audio')).not.toBeNull());
    const player = canvasElement.querySelector('audio');
    await expect(player).toHaveAttribute('src', AUDIO_DOCUMENT.content);
    await expect(player).toHaveAttribute('controls');
    await expect(player).toHaveAttribute('preload', 'none');
  },
};

const video = preview(VIDEO_DOCUMENT);
/** Video in the browser's own player. */
export const Video: Story = {
  ...video.story,
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelector('video')).not.toBeNull());
    const player = canvasElement.querySelector('video');
    await expect(player).toHaveAttribute('src', VIDEO_DOCUMENT.content);
    await expect(player).toHaveAttribute('preload', 'none');
  },
};

const markdown = preview(MARKDOWN_DOCUMENT);
/** Markdown, fetched and drawn as a document. */
export const Markdown: Story = {
  ...markdown.story,
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole('heading', { name: 'Release 1.4' })).toBeInTheDocument();
    await expect(canvas.getByText('Folders')).toBeInTheDocument();
  },
};

const text = preview(TEXT_DOCUMENT);
/** Plain text, as it is, in a block. */
export const Text: Story = {
  ...text.story,
  play: async ({ canvas }) => {
    await expect(await canvas.findByText(/step 3: test — 42 passed/)).toBeInTheDocument();
  },
};

const json = preview(JSON_DOCUMENT);
/** JSON, indented to read. */
export const Json: Story = {
  ...json.story,
  play: async ({ canvas }) => {
    await expect(await canvas.findByText(/"run": 17,/)).toBeInTheDocument();
  },
};

const csv = preview(CSV_DOCUMENT);
/** A CSV, as its text. */
export const Csv: Story = {
  ...csv.story,
  play: async ({ canvas }) => {
    await expect(await canvas.findByText(/day,uploads/)).toBeInTheDocument();
  },
};

const large = preview(LARGE_TEXT_DOCUMENT);
/** Text past the cap is not fetched at all: the card says why and points at the download. */
export const TooLargeToShow: Story = {
  ...large.story,
  play: async ({ canvas }) => {
    await expect(canvas.getByText(/too large to show here/)).toBeInTheDocument();
    await expect(large.server.calls.contentUrl).toHaveLength(0);
  },
};

const html = preview(HTML_DOCUMENT);
/** A web page is never drawn in the app, and its URL is never asked for. */
export const WebPageNeverRendered: Story = {
  ...html.story,
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByText(/Web pages are never opened inside the app/)).toBeInTheDocument();
    await expect(canvasElement.querySelector('iframe')).toBeNull();
    await expect(html.server.calls.contentUrl).toHaveLength(0);
  },
};

const zip = preview(ZIP_DOCUMENT);
/** Anything else: the details and the download do the work. */
export const NoPreview: Story = {
  ...zip.story,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText(/ZIP files have no preview here/)).toBeInTheDocument();
  },
};
