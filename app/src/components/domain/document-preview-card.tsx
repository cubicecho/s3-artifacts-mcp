import { useEffect, useRef, useState } from 'react';
import { CardLayout } from '@/components/card-layout';
import { EmptyState } from '@/components/empty-state';
import { Markdown } from '@/components/markdown';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CodeBlock } from '@/components/ui/code';
import { RefreshCw } from '@/components/ui/icons';
import { Spinner } from '@/components/ui/spinner';
import { PREVIEW_DEFAULTS } from '@/defaults';
import { ContentFetchError, fetchContentText, useContentUrl } from '@/lib/content-url';
import { PreviewKind, previewKind, typeLabel } from '@/lib/document-type';
import { describeError } from '@/lib/error-message';
import { formatBytes } from '@/lib/format';

/** What the preview needs to know about its document. */
export interface PreviewDocument {
  id: string;
  title: string;
  contentType: string;
  size: number;
}

interface DocumentPreviewCardProps {
  document: PreviewDocument;
}

/** The kinds that are fetched and drawn as text, and so are held to the size cap. */
const TEXT_KINDS: ReadonlySet<PreviewKind> = new Set([PreviewKind.Markdown, PreviewKind.Text]);

/**
 * Why a document is not drawn, in a line that says what to do instead.
 *
 * @param document - The document.
 * @param kind - How its type is previewed.
 * @returns The line, or null when it is drawn.
 */
function notShownBecause(document: PreviewDocument, kind: PreviewKind): string | null {
  if (kind === PreviewKind.None) {
    return isWebPage(document.contentType)
      ? 'Web pages are never opened inside the app. Download it to open it in a browser of its own.'
      : `${typeLabel(document.contentType)} files have no preview here. Download it to open it.`;
  }
  if (TEXT_KINDS.has(kind) && document.size > PREVIEW_DEFAULTS.maxTextBytes) {
    return `At ${formatBytes(document.size)} it is too large to show here. Download it to read it.`;
  }
  return null;
}

/**
 * Whether a type is a web page, which is never drawn here.
 *
 * @param contentType - The stored `Content-Type`.
 * @returns True for HTML and XHTML.
 */
function isWebPage(contentType: string): boolean {
  return /^(text\/html|application\/xhtml\+xml)\b/i.test(contentType);
}

/**
 * A document's content, drawn by its type: a PDF in a frame, an image, audio and video in the
 * browser's own players, and text, Markdown, JSON or CSV fetched and drawn (up to
 * `PREVIEW_DEFAULTS.maxTextBytes`). Anything else, and every web page, is left to the download.
 *
 * The URL expires after a quarter of an hour, so a player or image that fails to load asks for a
 * fresh one once before it says it failed.
 *
 * @param props - The document.
 * @returns The preview card.
 */
export function DocumentPreviewCard({ document }: DocumentPreviewCardProps) {
  const kind = previewKind(document.contentType);
  const reason = notShownBecause(document, kind);
  const { url, failed, refresh, version } = useContentUrl(document.id, reason === null);
  // The URL a load failed on and was refreshed for. Failing again on the fresh one is a real failure.
  const retriedFor = useRef<string | null>(null);
  // The URL that failed for good. Kept by URL rather than as a flag, so a fresh URL is a fresh
  // chance without an effect to reset it, which an error arriving first would race.
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const broken = url !== null && url === brokenUrl;

  const onLoadError = () => {
    if (url !== null && retriedFor.current === null) {
      retriedFor.current = url;
      refresh();
      return;
    }
    setBrokenUrl(url);
  };

  // A load that worked earns the next expiry its own refresh.
  const onLoaded = () => {
    retriedFor.current = null;
  };

  const retry = () => {
    retriedFor.current = null;
    setBrokenUrl(null);
    refresh();
  };

  const failure = (description: string) => (
    <Alert
      variant="destructive"
      title="Could not load the preview"
      description={description}
      actionSlot={<Button size="sm" variant="outline" iconSlot={<RefreshCw />} content="Try again" onClick={retry} />}
    />
  );

  let body: React.ReactNode;
  if (reason !== null) {
    body = <EmptyState compact title={reason} />;
  } else if (failed || broken) {
    body = failure(
      failed
        ? 'The server gave no address for the file.'
        : 'The file did not load. The bucket may be unreachable from the server.',
    );
  } else if (url === null) {
    return <CardLayout level={2} title="Preview" loading />;
  } else {
    body = (
      <PreviewBody
        key={version}
        document={document}
        kind={kind}
        url={url}
        onLoaded={onLoaded}
        onLoadError={onLoadError}
        failure={failure}
      />
    );
  }

  return <CardLayout level={2} title="Preview" contentSlot={body} />;
}

interface PreviewBodyProps {
  document: PreviewDocument;
  kind: PreviewKind;
  url: string;
  /** The file loaded. */
  onLoaded: () => void;
  /** The file did not load: most likely its URL expired. */
  onLoadError: () => void;
  failure: (description: string) => React.ReactNode;
}

/**
 * The preview itself, once its URL is in hand.
 *
 * @param props - The document, how it is drawn, its URL, and what a failed load calls.
 * @returns The element that shows it.
 */
function PreviewBody({ document, kind, url, onLoaded, onLoadError, failure }: PreviewBodyProps) {
  switch (kind) {
    case PreviewKind.Pdf:
      return (
        <iframe
          title={`Preview of ${document.title}`}
          src={url}
          className="h-[36rem] w-full rounded-md border border-foreground/10"
        />
      );
    case PreviewKind.Image:
      return (
        <img
          src={url}
          alt={document.title}
          onLoad={onLoaded}
          onError={onLoadError}
          className="mx-auto max-h-[36rem] max-w-full rounded-md object-contain"
        />
      );
    case PreviewKind.Audio:
      return (
        // `preload="none"`: nothing is fetched until it is played, so a long recording costs nothing to look at.
        <audio
          controls
          preload="none"
          src={url}
          onLoadedMetadata={onLoaded}
          onError={onLoadError}
          className="w-full"
          aria-label={document.title}
        >
          {/* Uploaded audio comes with no captions; the empty track keeps the element honest about it. */}
          <track kind="captions" />
        </audio>
      );
    case PreviewKind.Video:
      return (
        <video
          controls
          preload="none"
          src={url}
          onLoadedMetadata={onLoaded}
          onError={onLoadError}
          className="max-h-[36rem] w-full rounded-md"
          aria-label={document.title}
        >
          <track kind="captions" />
        </video>
      );
    case PreviewKind.Markdown:
    case PreviewKind.Text:
      return (
        <TextPreview
          document={document}
          kind={kind}
          url={url}
          onLoaded={onLoaded}
          onLoadError={onLoadError}
          failure={failure}
        />
      );
    default:
      return null;
  }
}

/**
 * The text of a document, fetched from its URL: Markdown drawn as a document, JSON indented, and
 * everything else as it is.
 *
 * @param props - The document, its URL, and what an expired URL calls.
 * @returns The text, a loading card while it is fetched, or why it could not be.
 */
function TextPreview({ document, kind, url, onLoaded, onLoadError, failure }: PreviewBodyProps) {
  const [text, setText] = useState<{ url: string; content: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  // The latest handler, read when a fetch fails, so a new one each render does not fetch again.
  const loadError = useRef(onLoadError);
  loadError.current = onLoadError;
  const loaded = useRef(onLoaded);
  loaded.current = onLoaded;

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    fetchContentText(url, controller.signal).then(
      (content) => {
        loaded.current();
        setText({ url, content });
      },
      (reason: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        // A refused URL is most likely one that expired: ask for a fresh one once.
        if (reason instanceof ContentFetchError) {
          loadError.current();
          return;
        }
        setError(reason);
      },
    );
    return () => controller.abort();
  }, [url]);

  if (error !== null) {
    return failure(describeError(error));
  }
  if (text === null || text.url !== url) {
    return <Spinner label="Loading the text" />;
  }
  if (kind === PreviewKind.Markdown) {
    return <Markdown content={text.content} />;
  }
  return <CodeBlock title={document.title} content={readable(document.contentType, text.content)} maxHeight="lg" />;
}

/**
 * Text as it reads best: JSON indented, anything else unchanged.
 *
 * @param contentType - The document's type.
 * @param content - Its text.
 * @returns The text to draw.
 */
function readable(contentType: string, content: string): string {
  if (/json/i.test(contentType) === false) {
    return content;
  }
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}
