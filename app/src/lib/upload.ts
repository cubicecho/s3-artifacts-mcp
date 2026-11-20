import { createContext } from 'react';
import { getToken } from './auth';

// Browsers leave the type blank for extensions they do not know.
const UNKNOWN_CONTENT_TYPE = 'application/octet-stream';

/** Types a browser may not know, by extension. */
const TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  // Most browsers have none for Markdown, and some call it text/x-markdown.
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  log: 'text/plain',
  txt: 'text/plain',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  webp: 'image/webp',
  epub: 'application/epub+zip',
};

/** What a browser calls a type that is better known by another name. */
const TYPE_ALIASES: Readonly<Record<string, string>> = {
  'text/x-markdown': 'text/markdown',
  'application/csv': 'text/csv',
  'text/x-csv': 'text/csv',
  'application/x-csv': 'text/csv',
  'text/comma-separated-values': 'text/csv',
};

/**
 * Windows names a type by the program that opens the extension, and with Excel installed a
 * `.csv` is Excel's. That type is also a real `.xls`'s, so it is renamed only for a `.csv`.
 */
const EXCEL_CONTENT_TYPE = 'application/vnd.ms-excel';

/**
 * The type an upload is declared as, which is the `Content-Type` it is stored and served with.
 *
 * @param file - The picked file's name and the type the browser gave it.
 * @returns The browser's type, or one from the extension when it gave none.
 */
export function uploadContentType(file: { name: string; type: string }): string {
  const dot = file.name.lastIndexOf('.');
  const extension = dot === -1 ? '' : file.name.slice(dot + 1).toLowerCase();
  if (file.type === EXCEL_CONTENT_TYPE && extension === 'csv') {
    return 'text/csv';
  }
  if (file.type !== '') {
    return TYPE_ALIASES[file.type] ?? file.type;
  }
  return TYPES_BY_EXTENSION[extension] ?? UNKNOWN_CONTENT_TYPE;
}

// The 2xx range: from here up to the first redirect is the server saying yes.
const HTTP_SUCCESS_MIN = 200;
const HTTP_REDIRECT_MIN = 300;
// The document is already `ready`: an earlier send of the same upload landed.
const HTTP_CONFLICT = 409;

/** One file to send to the path `createDocumentUpload` handed back. */
export interface UploadRequest {
  /** The same-origin path, `/api/documents/:id/content`. */
  path: string;
  /** The file, as the browser's own `Blob` handle, so it is streamed rather than held. */
  file: Blob;
  /** The type the document was created with. */
  contentType: string;
  /** Called with the fraction sent so far, from 0 to 1. */
  onProgress: (fraction: number) => void;
  /** Aborts the send when it fires. */
  signal: AbortSignal;
}

/** Sends one file's bytes. Resolves once the server has stored them. */
export type SendUpload = (request: UploadRequest) => Promise<void>;

/**
 * What a refusal said, from the JSON body the server answers a failed PUT with.
 *
 * @param body - The response text.
 * @returns Its `message` (or `error`), or undefined when it has none.
 */
export function refusalMessage(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    const { message, error } = parsed as { message?: unknown; error?: unknown };
    if (typeof message === 'string' && message !== '') {
      return message;
    }
    return typeof error === 'string' && error !== '' ? error : undefined;
  } catch {
    return undefined;
  }
}

/**
 * PUTs a file's bytes to the server, which streams them on to the bucket.
 *
 * XHR rather than fetch: fetch still reports no upload progress, and a 100 MB file with no
 * progress bar looks exactly like a hung page. The session goes as a bearer token, the same
 * one the GraphQL requests carry.
 *
 * @param request - Where to send it, what, and who hears about the progress.
 * @returns A promise that resolves once the server has stored the file (or had already, a 409),
 *   and rejects with the server's own message when it refuses, when it cannot be reached, or with
 *   an `AbortError` when the send is cancelled.
 */
export function putFile({ path, file, contentType, onProgress, signal }: UploadRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', path);
    xhr.setRequestHeader('Content-Type', contentType);
    const token = getToken();
    if (token) {
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    }

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(event.loaded / event.total);
      }
    };
    xhr.onload = () => {
      const isStored =
        (xhr.status >= HTTP_SUCCESS_MIN && xhr.status < HTTP_REDIRECT_MIN) || xhr.status === HTTP_CONFLICT;
      if (isStored) {
        onProgress(1);
        resolve();
        return;
      }
      reject(new Error(refusalMessage(xhr.responseText) ?? `The server refused the upload (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Could not reach the server'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    if (signal.aborted) {
      reject(new DOMException('Upload cancelled', 'AbortError'));
      return;
    }
    signal.addEventListener('abort', () => xhr.abort(), { once: true });

    xhr.send(file);
  });
}

/**
 * How the upload panel sends a file. The app's is {@link putFile}; a story provides one that
 * answers without a network.
 */
export const UploadSendContext = createContext<SendUpload>(putFile);

/**
 * Whether a failure is a cancelled send rather than a refused one.
 *
 * @param error - What the send rejected with.
 * @returns True for an `AbortError`.
 */
export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Names a NAS, a desktop or an editor leaves beside the files, which nobody means to upload:
 * dotfiles (`.DS_Store`, `._scan.pdf`), Office's `~$` owner files, and Windows's thumbnail cache
 * and folder settings.
 */
const IGNORED_FILE_NAMES = new Set(['thumbs.db', 'desktop.ini']);

function isIgnoredName(name: string): boolean {
  return name.startsWith('.') || name.startsWith('~$') || IGNORED_FILE_NAMES.has(name.toLowerCase());
}

/** Directories a NAS or a desktop keeps for itself: dot-directories, `@eaDir`, `#recycle`, `$RECYCLE.BIN`. */
function isIgnoredDir(name: string): boolean {
  return ['.', '@', '#', '$'].some((prefix) => name.startsWith(prefix));
}

/** What a pick or a drop comes to once its folders are flattened. */
export interface FlatUpload<F> {
  /** The files to upload, each under its own name. */
  files: F[];
  /** How many files from inside folders were left out as junk the OS keeps beside them. */
  skipped: number;
}

/**
 * Flattens a pick or a drop: a bucket has no folders, so every file is uploaded under its own
 * name and the folders it sat in are forgotten.
 *
 * @param files - The picked files, each with its `path` (`Photos/2026/beach.jpg`, or just the name).
 * @returns The files to upload, in the order given, and how many were left out. A file picked on
 *   its own is always kept; from inside a folder, the dotfiles and the OS's own clutter are not.
 */
export function flattenUpload<F extends { name: string; path: string }>(files: readonly F[]): FlatUpload<F> {
  const kept: F[] = [];
  let skipped = 0;
  for (const file of files) {
    const folders = file.path.split('/').filter((part) => part !== '');
    folders.pop();
    const isFromFolder = folders.length > 0;
    if (isFromFolder && (isIgnoredName(file.name) || folders.some(isIgnoredDir))) {
      skipped += 1;
      continue;
    }
    kept.push(file);
  }
  return { files: kept, skipped };
}

/**
 * Runs at most `limit` tasks at once and queues the rest, in the order they came.
 *
 * @param limit - How many may run at once.
 * @returns A function that runs a task when a slot is free, resolving with what it resolves to.
 */
export function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (running < limit) {
      running += 1;
    } else {
      // The slot is handed over by the task that frees it, so `running` never dips in between
      // and a task arriving at that moment cannot take it first.
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    try {
      return await task();
    } finally {
      const handOver = waiting.shift();
      if (handOver) {
        handOver();
      } else {
        running -= 1;
      }
    }
  };
}
