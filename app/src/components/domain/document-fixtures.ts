import { GraphQLError } from 'graphql';
import type { DocumentStatus } from '@/__generated__/graphql';
import { BUCKET_PRESETS, type BucketFixture, MINIO_BUCKET, S3_BUCKET } from '@/components/domain/bucket-fixtures';
import { clientId } from '@/lib/id';
import type { SendUpload } from '@/lib/upload';

// Documents as the server answers them, a mock server whose mutations really change them, and a
// stand-in for the PUT that sends a file's bytes. The mock executes against the real SDL, so a
// field the server renames fails the stories that use these. Nothing here crosses the network:
// a document's content URL is a `data:` URL holding its bytes.

/** A document as `documents` answers it, plus the bytes its content URL serves. */
export interface DocumentFixture {
  id: string;
  userId: string;
  bucketId: string;
  title: string;
  filename: string;
  objectKey: string;
  contentType: string;
  size: number;
  sha256: string | null;
  status: DocumentStatus;
  createdAt: string;
  updatedAt: string;
  /** What `contentUrl` answers. */
  content: string;
}

const USER_ID = '9f0e1d2c-3b4a-4596-8877-665544332211';
const SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** A `data:` URL holding text, as a content URL for a text document. */
function textUrl(contentType: string, text: string): string {
  return `data:${contentType};charset=utf-8,${encodeURIComponent(text)}`;
}

/** A small picture, drawn by the browser from the URL alone. */
const PICTURE = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#2a9d8f"/><circle cx="80" cy="45" r="24" fill="#e9c46a"/></svg>',
)}`;

/** Bytes no image decoder accepts, standing in for a URL that has expired. */
export const BROKEN_PICTURE = 'data:image/png;base64,AAAA';

let made = 0;
// The counter's digits in a made-up id, so `5a000012-…` is still a UUID's eight.
const ID_DIGITS = 6;

/**
 * A ready document in a bucket.
 *
 * @param bucket - The bucket it is in.
 * @param fields - What sets it apart: at least a title, a filename and a type.
 * @returns The fixture.
 */
export function documentFixture(
  bucket: Pick<BucketFixture, 'id'>,
  fields: Partial<DocumentFixture> & Pick<DocumentFixture, 'title' | 'filename' | 'contentType'>,
): DocumentFixture {
  made += 1;
  const id = fields.id ?? `5a${String(made).padStart(ID_DIGITS, '0')}-1b2c-4d3e-8f40-516273849506`;
  const createdAt = fields.createdAt ?? '2026-11-01T10:00:00.000Z';
  return {
    id,
    userId: USER_ID,
    bucketId: bucket.id,
    objectKey: `${id}-${fields.filename}`,
    size: 2048,
    sha256: SHA,
    status: 'ready',
    createdAt,
    updatedAt: createdAt,
    content: textUrl('text/plain', 'Hello.'),
    ...fields,
  };
}

/** A PDF report. */
export const PDF_DOCUMENT = documentFixture(MINIO_BUCKET, {
  id: '5a000001-1b2c-4d3e-8f40-516273849506',
  title: 'Quarterly report',
  filename: 'quarterly-report.pdf',
  contentType: 'application/pdf',
  size: 482_113,
  createdAt: '2026-11-18T09:30:00.000Z',
  // Enough of a PDF for the frame to point somewhere; the browser's viewer is not the subject.
  content: 'data:application/pdf;base64,JVBERi0xLjQKJSVFT0YK',
});

/** A picture. */
export const IMAGE_DOCUMENT = documentFixture(MINIO_BUCKET, {
  id: '5a000002-1b2c-4d3e-8f40-516273849506',
  title: 'Architecture diagram',
  filename: 'architecture.svg',
  contentType: 'image/svg+xml',
  size: 3_420,
  createdAt: '2026-11-17T14:00:00.000Z',
  content: PICTURE,
});

/** Notes in Markdown. */
export const MARKDOWN_DOCUMENT = documentFixture(S3_BUCKET, {
  id: '5a000003-1b2c-4d3e-8f40-516273849506',
  title: 'Release notes',
  filename: 'release-notes.md',
  contentType: 'text/markdown',
  size: 812,
  createdAt: '2026-11-16T08:00:00.000Z',
  content: textUrl(
    'text/markdown',
    '# Release 1.4\n\nWhat changed:\n\n- Uploads stream through the server\n- **Folders** upload flat\n',
  ),
});

/** A log file. */
export const TEXT_DOCUMENT = documentFixture(S3_BUCKET, {
  id: '5a000004-1b2c-4d3e-8f40-516273849506',
  title: 'build',
  filename: 'build.log',
  contentType: 'text/plain',
  size: 96,
  createdAt: '2026-11-15T08:00:00.000Z',
  content: textUrl('text/plain', 'step 1: install\nstep 2: build\nstep 3: test — 42 passed\n'),
});

/** A JSON payload, written on one line. */
export const JSON_DOCUMENT = documentFixture(MINIO_BUCKET, {
  id: '5a000005-1b2c-4d3e-8f40-516273849506',
  title: 'run-output',
  filename: 'run-output.json',
  contentType: 'application/json',
  size: 64,
  createdAt: '2026-11-14T08:00:00.000Z',
  content: textUrl('application/json', '{"run":17,"ok":true,"steps":["fetch","render"]}'),
});

/** A CSV export. */
export const CSV_DOCUMENT = documentFixture(MINIO_BUCKET, {
  id: '5a000006-1b2c-4d3e-8f40-516273849506',
  title: 'metrics',
  filename: 'metrics.csv',
  contentType: 'text/csv',
  size: 40,
  createdAt: '2026-11-13T08:00:00.000Z',
  content: textUrl('text/csv', 'day,uploads\nmon,12\ntue,30\n'),
});

/** A recording. */
export const AUDIO_DOCUMENT = documentFixture(MINIO_BUCKET, {
  id: '5a000007-1b2c-4d3e-8f40-516273849506',
  title: 'Standup recording',
  filename: 'standup.mp3',
  contentType: 'audio/mpeg',
  size: 1_048_576,
  createdAt: '2026-11-12T08:00:00.000Z',
  content: 'data:audio/mpeg;base64,',
});

/** A screen capture. */
export const VIDEO_DOCUMENT = documentFixture(MINIO_BUCKET, {
  id: '5a000008-1b2c-4d3e-8f40-516273849506',
  title: 'Demo',
  filename: 'demo.mp4',
  contentType: 'video/mp4',
  size: 7_340_032,
  createdAt: '2026-11-11T08:00:00.000Z',
  content: 'data:video/mp4;base64,',
});

/** A saved web page, which the app never draws. */
export const HTML_DOCUMENT = documentFixture(MINIO_BUCKET, {
  id: '5a000009-1b2c-4d3e-8f40-516273849506',
  title: 'Receipt',
  filename: 'receipt.html',
  contentType: 'text/html',
  size: 5_120,
  createdAt: '2026-11-10T08:00:00.000Z',
  content: textUrl('text/html', '<h1>Receipt</h1><img src="https://tracker.example/pixel.gif">'),
});

/** An archive, which has no preview. */
export const ZIP_DOCUMENT = documentFixture(S3_BUCKET, {
  id: '5a00000a-1b2c-4d3e-8f40-516273849506',
  title: 'site-export',
  filename: 'site-export.zip',
  contentType: 'application/zip',
  size: 12_582_912,
  createdAt: '2026-11-09T08:00:00.000Z',
});

/** A log too large to draw in the page. */
export const LARGE_TEXT_DOCUMENT = documentFixture(S3_BUCKET, {
  id: '5a00000b-1b2c-4d3e-8f40-516273849506',
  title: 'server',
  filename: 'server.log',
  contentType: 'text/plain',
  size: 52_428_800,
  createdAt: '2026-11-08T08:00:00.000Z',
});

/** One of each kind the page previews, across two buckets. */
export const MIXED_DOCUMENTS: readonly DocumentFixture[] = [
  PDF_DOCUMENT,
  IMAGE_DOCUMENT,
  MARKDOWN_DOCUMENT,
  TEXT_DOCUMENT,
  JSON_DOCUMENT,
  CSV_DOCUMENT,
];

/** The server's upload limit: 100 MiB, until Settings → General can change it. */
export const UPLOAD_LIMIT_BYTES = 104_857_600;

/** How a fake send answers a file, by its filename. */
export type SendOutcome =
  /** The bytes land, after a few steps of progress. */
  | 'ok'
  /** The server refuses the PUT with its own message. */
  | 'refuse'
  /** The server cannot be reached. */
  | 'network'
  /** It never finishes: it sits at half way until cancelled. */
  | 'hang';

/** What the mock server is told to do. */
interface DocumentServerOptions {
  /** When set, `buckets` fails with this message. */
  failBuckets?: string;
  /** How the PUT answers each file. Left out, every file lands. */
  send?: (filename: string, attempt: number) => SendOutcome;
  /** Milliseconds between two steps of a send's progress. */
  stepMs?: number;
  /** When set, `deleteDocument` refuses with this message. */
  deleteRefusal?: string;
  /** When set, `renameDocument` refuses with this message. */
  renameRefusal?: string;
  /** What `contentUrl` answers for a document, overriding its `content`, by how many times it was asked. */
  contentUrl?: (document: DocumentFixture, asked: number, download: boolean) => string;
}

// A UUID, as the generated `document(where: { id })` read requires of its argument.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEND_STEPS = 4;
const DEFAULT_STEP_MS = 30;

/** `where` as the generated reads receive it, as far as these resolvers look into it. */
interface DocumentWhere {
  id?: { eq?: string | null } | null;
  status?: { eq?: string | null } | null;
  bucketId?: { eq?: string | null } | null;
}

/**
 * A server holding buckets and documents that its mutations really change, and the PUT that
 * sends a file's bytes, so a story sees an upload arrive in the list and the tree.
 *
 * @param startBuckets - The buckets it starts with.
 * @param startDocuments - The documents it starts with.
 * @param options - How its sends and mutations answer.
 * @returns The resolvers, the fake send, and the live lists and call logs for a story to inspect.
 */
export function documentServer(
  startBuckets: readonly BucketFixture[],
  startDocuments: readonly DocumentFixture[] = [],
  options: DocumentServerOptions = {},
) {
  const buckets = startBuckets.map((bucket) => ({ ...bucket }));
  const documents = startDocuments.map((document) => ({ ...document }));
  const calls = {
    createDocumentUpload: [] as { bucketId: string; filename: string; contentType?: string | null; size: number }[],
    contentUrl: [] as { id: string; download: boolean }[],
    sends: [] as string[],
  };
  const attempts = new Map<string, number>();

  const findDocument = (id: string) => {
    const document = documents.find((entry) => entry.id === id);
    if (document === undefined) {
      throw new GraphQLError('No such document', { extensions: { code: 'NOT_FOUND' } });
    }
    return document;
  };

  const forget = (id: string) => {
    const index = documents.findIndex((entry) => entry.id === id);
    if (index !== -1) {
      documents.splice(index, 1);
    }
  };

  const matches = (document: DocumentFixture, where: DocumentWhere | null | undefined) =>
    (where?.id?.eq == null || document.id === where.id.eq) &&
    (where?.status?.eq == null || document.status === where.status.eq) &&
    (where?.bucketId?.eq == null || document.bucketId === where.bucketId.eq);

  const resolvers = {
    Query: {
      buckets: () => {
        if (options.failBuckets) {
          throw new Error(options.failBuckets);
        }
        return buckets;
      },
      bucketPresets: () => BUCKET_PRESETS,
      documents: (_parent: unknown, args: { where?: DocumentWhere | null }) =>
        documents.filter((document) => matches(document, args.where)),
      document: (_parent: unknown, args: { where?: DocumentWhere | null }) => {
        const id = args.where?.id?.eq;
        if (id != null && UUID.test(id) === false) {
          throw new GraphQLError('No such document', { extensions: { code: 'NOT_FOUND' } });
        }
        return documents.find((document) => matches(document, args.where)) ?? null;
      },
    },
    Bucket: {
      documents: (bucket: BucketFixture, args: { where?: DocumentWhere | null }) =>
        documents.filter((document) => document.bucketId === bucket.id && matches(document, args.where)),
    },
    Document: {
      bucket: (document: DocumentFixture) => buckets.find((bucket) => bucket.id === document.bucketId),
      contentUrl: (document: DocumentFixture, args: { download?: boolean | null }) => {
        const download = args.download === true;
        calls.contentUrl.push({ id: document.id, download });
        const asked = calls.contentUrl.filter((call) => call.id === document.id && call.download === download).length;
        return options.contentUrl?.(document, asked, download) ?? document.content;
      },
    },
    Mutation: {
      createDocumentUpload: (
        _parent: unknown,
        args: { bucketId: string; filename: string; contentType?: string | null; size: number },
      ) => {
        calls.createDocumentUpload.push(args);
        const bucket = buckets.find((entry) => entry.id === args.bucketId);
        if (bucket === undefined) {
          throw new GraphQLError('No such bucket', { extensions: { code: 'NOT_FOUND' } });
        }
        if (args.size > UPLOAD_LIMIT_BYTES) {
          throw new GraphQLError(`${args.filename} is larger than the 100 MiB upload limit`, {
            extensions: { code: 'BAD_USER_INPUT' },
          });
        }
        const id = clientId();
        const now = new Date().toISOString();
        const document: DocumentFixture = {
          id,
          userId: USER_ID,
          bucketId: bucket.id,
          title: args.filename.replace(/\.[^.]*$/, ''),
          filename: args.filename,
          objectKey: `${id}-${args.filename}`,
          contentType: args.contentType ?? 'application/octet-stream',
          size: args.size,
          sha256: null,
          status: 'pending_upload',
          createdAt: now,
          updatedAt: now,
          content: textUrl('text/plain', 'Uploaded in a story.'),
        };
        documents.push(document);
        return { document, uploadPath: `/api/documents/${id}/content` };
      },
      renameDocument: (_parent: unknown, args: { id: string; title: string }) => {
        if (options.renameRefusal) {
          throw new GraphQLError(options.renameRefusal, { extensions: { code: 'BAD_USER_INPUT' } });
        }
        const document = findDocument(args.id);
        document.title = args.title;
        return document;
      },
      deleteDocument: (_parent: unknown, args: { id: string }) => {
        if (options.deleteRefusal) {
          throw new GraphQLError(options.deleteRefusal, { extensions: { code: 'STORAGE_ERROR' } });
        }
        findDocument(args.id);
        forget(args.id);
        return true;
      },
    },
  };

  const stepMs = options.stepMs ?? DEFAULT_STEP_MS;

  /** The PUT, answered here: a few steps of progress, then the document is `ready`, or the outcome asked for. */
  const send: SendUpload = ({ path, onProgress, signal }) =>
    new Promise((resolve, reject) => {
      const id = path.split('/')[3] ?? '';
      const document = documents.find((entry) => entry.id === id);
      const filename = document?.filename ?? '';
      calls.sends.push(filename);
      const attempt = (attempts.get(filename) ?? 0) + 1;
      attempts.set(filename, attempt);
      const outcome = options.send?.(filename, attempt) ?? 'ok';
      const timers: ReturnType<typeof setTimeout>[] = [];
      const abort = () => {
        for (const timer of timers) {
          clearTimeout(timer);
        }
        // As the server does with a body that never finished: the pending row goes.
        forget(id);
        reject(new DOMException('Upload cancelled', 'AbortError'));
      };
      signal.addEventListener('abort', abort, { once: true });

      const finish = () => {
        signal.removeEventListener('abort', abort);
        if (outcome === 'refuse') {
          forget(id);
          reject(new Error('The bucket refused the object: AccessDenied'));
          return;
        }
        if (outcome === 'network') {
          reject(new Error('Could not reach the server'));
          return;
        }
        if (document) {
          document.status = 'ready';
          document.sha256 = SHA;
        }
        onProgress(1);
        resolve();
      };

      const lastStep = outcome === 'hang' ? SEND_STEPS / 2 : SEND_STEPS;
      for (let step = 1; step <= lastStep; step += 1) {
        timers.push(
          setTimeout(() => {
            onProgress(step / SEND_STEPS);
            if (step === SEND_STEPS) {
              finish();
            }
          }, step * stepMs),
        );
      }
    });

  return { resolvers, send, buckets, documents, calls };
}
