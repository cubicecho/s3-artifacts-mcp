import type { Meta, StoryObj } from '@storybook/react-vite';
import { Route, Routes } from 'react-router';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { MINIO_BUCKET, S3_BUCKET } from '@/components/domain/bucket-fixtures';
import {
  type DocumentFixture,
  documentServer,
  MARKDOWN_DOCUMENT,
  MIXED_DOCUMENTS,
  PDF_DOCUMENT,
} from '@/components/domain/document-fixtures';
import { mergeResolvers, shareLinkFixture, shareLinkServer } from '@/components/domain/share-link-fixtures';
import { bucketDocumentsPath, documentPath, ROUTES } from '@/lib/routes';
import { DocumentRoute } from './document';

/**
 * A document's page against a mock server built from the real SDL: its preview and details,
 * Rename, Download and Delete, and the not-found and failed rungs. Each preview type has its own
 * story on `DocumentPreviewCard`; this one shows a PDF and Markdown in place.
 */

type ServerOptions = Parameters<typeof documentServer>[2];

/**
 * A story's server, at a document's page.
 *
 * @param path - Where the story opens.
 * @param documents - The documents the server holds.
 * @param options - How its mutations answer.
 * @returns The story's parameters and the server to inspect in `play`.
 */
function at(path: string, documents: readonly DocumentFixture[] = MIXED_DOCUMENTS, options: ServerOptions = {}) {
  const server = documentServer([MINIO_BUCKET, S3_BUCKET], documents, options);
  // The PDF has one link, so the share card has something to show and a re-key something to revoke.
  const pdf = server.documents.find((document) => document.id === PDF_DOCUMENT.id);
  const sharing = shareLinkServer(
    server.documents,
    pdf === undefined ? [] : [shareLinkFixture(pdf, { label: 'For Dana' })],
  );
  return {
    server,
    sharing,
    parameters: {
      apolloClient: { resolvers: mergeResolvers(server.resolvers, sharing.resolvers) },
      router: { initialEntries: [path] },
    },
  };
}

/** The page at its route, beside a stand-in for the documents page that a delete goes back to. */
function Routed() {
  return (
    <div className="h-screen">
      <Routes>
        <Route path={ROUTES.document} element={<DocumentRoute />} />
        <Route path={ROUTES.documents} element={<h1>All documents</h1>} />
      </Routes>
    </div>
  );
}

const meta = {
  title: 'Routes/Document',
  component: DocumentRoute,
  render: () => <Routed />,
  parameters: { layout: 'fullscreen', ...at(documentPath(PDF_DOCUMENT.id)).parameters },
} satisfies Meta<typeof DocumentRoute>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A PDF: its title, where it is, the frame, the details, and the three actions. */
export const Pdf: Story = {
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole('heading', { level: 1, name: PDF_DOCUMENT.title })).toBeInTheDocument();
    await expect(canvas.getByText('Artifacts · quarterly-report.pdf')).toBeInTheDocument();
    await expect(await canvas.findByTitle(`Preview of ${PDF_DOCUMENT.title}`)).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Rename' })).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Download' })).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Delete' })).toBeInTheDocument();

    const heading = canvas.getByRole('heading', { level: 2, name: 'Details' });
    const card = heading.closest('[data-slot="card-layout"]');
    if (card instanceof HTMLElement === false) {
      throw new Error('The details are not in a card');
    }
    const details = within(card);
    await expect(details.getByText(PDF_DOCUMENT.objectKey)).toBeInTheDocument();
    await expect(details.getByText(PDF_DOCUMENT.sha256 ?? '')).toBeInTheDocument();
    await expect(details.getByText('application/pdf')).toBeInTheDocument();
    await expect(details.getByRole('link', { name: 'Artifacts' })).toHaveAttribute(
      'href',
      bucketDocumentsPath(MINIO_BUCKET.slug),
    );
    await expect(canvas.getByRole('link', { name: 'Documents' })).toHaveAttribute('href', ROUTES.documents);
  },
};

const rekeying = at(documentPath(PDF_DOCUMENT.id));
/**
 * The page's share links: revoking them all moves the file, every link reads revoked, and the preview asks for a
 * URL signed for the new key.
 */
export const RevokesAllLinks: Story = {
  parameters: rekeying.parameters,
  play: async ({ canvas, canvasElement }) => {
    await expect(await canvas.findByRole('heading', { level: 2, name: 'Share links' })).toBeInTheDocument();
    await expect(await canvas.findByText('For Dana')).toBeInTheDocument();
    await canvas.findByTitle(`Preview of ${PDF_DOCUMENT.title}`);
    const asked = rekeying.server.calls.contentUrl.length;
    await userEvent.click(canvas.getByRole('button', { name: 'Revoke all links' }));
    const confirm = within(await within(canvasElement.ownerDocument.body).findByRole('alertdialog'));
    await userEvent.click(confirm.getByRole('button', { name: 'Revoke all links' }));
    await expect(await canvas.findByText('Revoked')).toBeInTheDocument();
    await waitFor(() => expect(rekeying.server.calls.contentUrl.length).toBeGreaterThan(asked));
    const moved = rekeying.server.documents.find((document) => document.id === PDF_DOCUMENT.id);
    await expect(await canvas.findByText(moved?.objectKey ?? '')).toBeInTheDocument();
  },
};

/** Markdown, drawn as a document under the header. */
export const Markdown: Story = {
  parameters: at(documentPath(MARKDOWN_DOCUMENT.id)).parameters,
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole('heading', { name: 'Release 1.4' })).toBeInTheDocument();
    await expect(canvas.getByText('Reports · release-notes.md')).toBeInTheDocument();
  },
};

const downloading = at(documentPath(PDF_DOCUMENT.id));
/** Download asks for a fresh attachment URL when pressed, not before. */
export const Download: Story = {
  parameters: downloading.parameters,
  play: async ({ canvas }) => {
    await canvas.findByTitle(`Preview of ${PDF_DOCUMENT.title}`);
    await expect(downloading.server.calls.contentUrl.filter((call) => call.download)).toHaveLength(0);
    await userEvent.click(canvas.getByRole('button', { name: 'Download' }));
    await waitFor(() =>
      expect(downloading.server.calls.contentUrl).toContainEqual({ id: PDF_DOCUMENT.id, download: true }),
    );
  },
};

const renaming = at(documentPath(PDF_DOCUMENT.id));
/** Rename is a dialog with a Save; the new title is the page's once it is saved. */
export const Rename: Story = {
  parameters: renaming.parameters,
  play: async ({ canvas, canvasElement }) => {
    await userEvent.click(await canvas.findByRole('button', { name: 'Rename' }));
    const dialog = within(await within(canvasElement.ownerDocument.body).findByRole('dialog'));
    const field = dialog.getByLabelText(/^Title/);
    await expect(field).toHaveValue(PDF_DOCUMENT.title);
    await userEvent.clear(field);
    await userEvent.type(field, 'Q3 report');
    await userEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Q3 report' })).toBeInTheDocument();
    await expect(renaming.server.documents.find((document) => document.id === PDF_DOCUMENT.id)?.title).toBe(
      'Q3 report',
    );
  },
};

/** A refused rename keeps the dialog open and says why. */
export const RenameRefused: Story = {
  parameters: at(documentPath(PDF_DOCUMENT.id), MIXED_DOCUMENTS, { renameRefusal: 'A title is at most 200 characters' })
    .parameters,
  play: async ({ canvas, canvasElement }) => {
    await userEvent.click(await canvas.findByRole('button', { name: 'Rename' }));
    const dialog = within(await within(canvasElement.ownerDocument.body).findByRole('dialog'));
    await userEvent.type(dialog.getByLabelText(/^Title/), ' again');
    await userEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await expect(await dialog.findByText('A title is at most 200 characters')).toBeInTheDocument();
    // The page behind the open dialog is hidden from the accessibility tree, so it is read by text.
    await expect(canvas.getByText(PDF_DOCUMENT.title, { selector: 'h1' })).toBeInTheDocument();
  },
};

const deleting = at(documentPath(PDF_DOCUMENT.id));
/** Delete asks first, saying the object leaves the bucket too, then goes back to the list. */
export const Delete: Story = {
  parameters: deleting.parameters,
  play: async ({ canvas, canvasElement }) => {
    await userEvent.click(await canvas.findByRole('button', { name: 'Delete' }));
    const question = within(await within(canvasElement.ownerDocument.body).findByRole('alertdialog'));
    await expect(question.getByText(/removed from the bucket “Artifacts”/)).toBeInTheDocument();
    await userEvent.click(question.getByRole('button', { name: 'Delete' }));
    await expect(await canvas.findByRole('heading', { name: 'All documents' })).toBeInTheDocument();
    await expect(deleting.server.documents.some((document) => document.id === PDF_DOCUMENT.id)).toBe(false);
  },
};

/** The bucket refuses the delete: the document stays, and the page says why. */
export const DeleteRefused: Story = {
  parameters: at(documentPath(PDF_DOCUMENT.id), MIXED_DOCUMENTS, {
    deleteRefusal: 'The bucket refused the delete: AccessDenied',
  }).parameters,
  play: async ({ canvas, canvasElement }) => {
    await userEvent.click(await canvas.findByRole('button', { name: 'Delete' }));
    const question = within(await within(canvasElement.ownerDocument.body).findByRole('alertdialog'));
    await userEvent.click(question.getByRole('button', { name: 'Delete' }));
    await expect(await canvas.findByText(`Could not delete “${PDF_DOCUMENT.title}”`)).toBeInTheDocument();
    await expect(canvas.getByText('The bucket refused the delete: AccessDenied')).toBeInTheDocument();
    await expect(await canvas.findByRole('heading', { level: 1, name: PDF_DOCUMENT.title })).toBeInTheDocument();
  },
};

/** An id that names nothing: a not-found page, not an error. */
export const NotFound: Story = {
  parameters: at(documentPath('00000000-0000-4000-8000-000000000000')).parameters,
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Document not found' })).toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  },
};

/** An id that is not even a UUID answers NOT_FOUND, which is the same not-found page. */
export const NotAnId: Story = {
  parameters: at(documentPath('not-an-id')).parameters,
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Document not found' })).toBeInTheDocument();
  },
};

/** Before the answer lands. */
export const Loading: Story = {
  parameters: {
    ...at(documentPath(PDF_DOCUMENT.id)).parameters,
    apolloClient: { resolvers: at(documentPath(PDF_DOCUMENT.id)).server.resolvers, delay: 100_000 },
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('status')).toHaveAccessibleName('Loading');
    await expect(canvas.queryByText('Document not found')).not.toBeInTheDocument();
  },
};

/** The server failed: the reason and a retry, never "not found". */
export const Failed: Story = {
  parameters: {
    router: { initialEntries: [documentPath(PDF_DOCUMENT.id)] },
    apolloClient: {
      resolvers: {
        Query: {
          document: () => {
            throw new Error('The database is not answering');
          },
        },
      },
    },
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText(/Could not load this document/)).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    await expect(canvas.queryByText('Document not found')).not.toBeInTheDocument();
  },
};

/** An upload still on its way has no preview yet, and says so. */
export const StillUploading: Story = {
  parameters: at(documentPath(PDF_DOCUMENT.id), [{ ...PDF_DOCUMENT, status: 'pending_upload', sha256: null }])
    .parameters,
  play: async ({ canvas }) => {
    await expect(await canvas.findByText('This upload has not finished')).toBeInTheDocument();
    await expect(canvas.queryByTitle(`Preview of ${PDF_DOCUMENT.title}`)).not.toBeInTheDocument();
  },
};

/** Phone width: the header's buttons wrap, the details fit, and nothing scrolls sideways. */
export const Narrow: Story = {
  globals: { viewport: { value: 'mobile1' } },
  play: async ({ canvas, canvasElement }) => {
    await expect(await canvas.findByRole('button', { name: 'Delete' })).toBeVisible();
    await expect(canvas.getByText(PDF_DOCUMENT.sha256 ?? '')).toBeVisible();
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};
