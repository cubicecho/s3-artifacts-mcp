/** How the document page shows a document of a type. */
export const PreviewKind = {
  Pdf: 'pdf',
  Image: 'image',
  Audio: 'audio',
  Video: 'video',
  Markdown: 'markdown',
  Text: 'text',
  /** Details and a download, nothing drawn: an archive, an office file, and HTML on purpose. */
  None: 'none',
} as const;
export type PreviewKind = (typeof PreviewKind)[keyof typeof PreviewKind];

/** Types that are text without saying `text/`. */
const TEXT_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/x-ndjson',
]);

/**
 * Never drawn in the app, whatever else holds. An uploaded page served from this origin would run
 * with the owner's session, and even sandboxed it would fetch whatever it names. SVG goes only into
 * an `<img>`, where its scripts do not run.
 */
const NEVER_RENDERED = new Set(['text/html', 'application/xhtml+xml']);

/**
 * The type without its parameters, in lower case: `text/plain; charset=utf-8` is `text/plain`.
 *
 * @param contentType - The stored `Content-Type`.
 * @returns The bare type.
 */
export function bareType(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * How the document page previews a type.
 *
 * @param contentType - The stored `Content-Type`.
 * @returns The kind of preview, `none` for anything the page does not draw.
 */
export function previewKind(contentType: string): PreviewKind {
  const type = bareType(contentType);
  if (NEVER_RENDERED.has(type)) {
    return PreviewKind.None;
  }
  if (type === 'application/pdf') {
    return PreviewKind.Pdf;
  }
  if (type === 'text/markdown') {
    return PreviewKind.Markdown;
  }
  if (type.startsWith('text/') || TEXT_TYPES.has(type)) {
    return PreviewKind.Text;
  }
  if (type.startsWith('image/')) {
    return PreviewKind.Image;
  }
  if (type.startsWith('audio/')) {
    return PreviewKind.Audio;
  }
  if (type.startsWith('video/')) {
    return PreviewKind.Video;
  }
  return PreviewKind.None;
}

/** Short names for the types people upload most, as a list column says them. */
const TYPE_LABELS: Readonly<Record<string, string>> = {
  'application/pdf': 'PDF',
  'text/markdown': 'Markdown',
  'text/plain': 'Text',
  'text/csv': 'CSV',
  'text/html': 'HTML',
  'application/json': 'JSON',
  'application/zip': 'ZIP',
  'application/octet-stream': 'Binary',
};

/**
 * What a list column calls a type: "PDF", "PNG image", or the type itself when it has no short name.
 *
 * @param contentType - The stored `Content-Type`.
 * @returns The label.
 */
export function typeLabel(contentType: string): string {
  const type = bareType(contentType);
  const known = TYPE_LABELS[type];
  if (known) {
    return known;
  }
  const [family, subtype = ''] = type.split('/');
  const isMedia = family === 'image' || family === 'audio' || family === 'video';
  if (isMedia && subtype !== '') {
    // `svg+xml` is an SVG, `x-wav` a WAV.
    const name = subtype.replace(/^x-/, '').replace(/\+.*$/, '').toUpperCase();
    return `${name} ${family}`;
  }
  return type === '' ? 'Unknown' : type;
}
