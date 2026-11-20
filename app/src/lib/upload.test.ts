import { describe, expect, it } from 'vitest';
import { bucketTreeEntries, EMPTY_BUCKET_LABEL } from './bucket-tree';
import { PreviewKind, previewKind, typeLabel } from './document-type';
import { preselectBucket } from './last-bucket';
import { createLimiter, flattenUpload, refusalMessage, uploadContentType } from './upload';

const picked = (path: string) => ({ name: path.split('/').pop() ?? path, path });

describe('flattenUpload', () => {
  it('keeps every file under its own name and forgets the folders', () => {
    const { files, skipped } = flattenUpload([picked('Trip/a.jpg'), picked('Trip/2026/b.jpg'), picked('c.pdf')]);
    expect(files.map((file) => file.name)).toEqual(['a.jpg', 'b.jpg', 'c.pdf']);
    expect(skipped).toBe(0);
  });

  it('leaves out the clutter inside a folder, but never a file picked on its own', () => {
    const { files, skipped } = flattenUpload([
      picked('Trip/.DS_Store'),
      picked('Trip/@eaDir/a.jpg'),
      picked('Trip/~$draft.docx'),
      picked('.env'),
    ]);
    expect(files.map((file) => file.path)).toEqual(['.env']);
    expect(skipped).toBe(3);
  });
});

describe('uploadContentType', () => {
  it('names a type the browser left blank from the extension', () => {
    expect(uploadContentType({ name: 'notes.md', type: '' })).toBe('text/markdown');
    expect(uploadContentType({ name: 'blob', type: '' })).toBe('application/octet-stream');
    expect(uploadContentType({ name: 'a.csv', type: 'application/vnd.ms-excel' })).toBe('text/csv');
    expect(uploadContentType({ name: 'a.png', type: 'image/png' })).toBe('image/png');
  });
});

describe('refusalMessage', () => {
  it("reads the server's message from a JSON refusal", () => {
    expect(refusalMessage('{"message":"Too large"}')).toBe('Too large');
    expect(refusalMessage('{"error":"Bad"}')).toBe('Bad');
    expect(refusalMessage('<html>')).toBeUndefined();
  });
});

describe('createLimiter', () => {
  it('runs at most the limit at once', async () => {
    const limit = createLimiter(2);
    let running = 0;
    let most = 0;
    const task = () =>
      limit(async () => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
      });
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(most).toBe(2);
  });
});

describe('preselectBucket', () => {
  const a = { id: 'a', slug: 'alpha', secretReadable: true };
  const b = { id: 'b', slug: 'beta', secretReadable: true };
  const locked = { id: 'c', slug: 'gamma', secretReadable: false };

  it('prefers the filtered bucket, then the only one, then the last used', () => {
    expect(preselectBucket([a, b], 'beta', 'a')).toBe('b');
    expect(preselectBucket([a, locked], null, null)).toBe('a');
    expect(preselectBucket([a, b], null, 'b')).toBe('b');
    expect(preselectBucket([a, b], null, null)).toBeNull();
  });

  it('never picks a bucket whose secret cannot be read', () => {
    expect(preselectBucket([a, b, locked], 'gamma', 'c')).toBeNull();
  });
});

describe('bucketTreeEntries', () => {
  it('nests documents under their bucket, tells duplicates apart, and marks an empty bucket', () => {
    const entries = bucketTreeEntries([
      {
        id: 'b1',
        name: 'Art/ifacts',
        secretReadable: true,
        documents: [
          { id: 'd1', title: 'notes' },
          { id: 'd2', title: 'notes' },
        ],
      },
      { id: 'b2', name: 'Empty', secretReadable: true, documents: [] },
    ]);
    expect(entries.map((entry) => entry.path)).toEqual([
      'Art∕ifacts',
      'Art∕ifacts/notes',
      'Art∕ifacts/notes (2)',
      'Empty',
      `Empty/${EMPTY_BUCKET_LABEL}`,
    ]);
  });
});

describe('previewKind', () => {
  it('draws what the browser can, and never a web page', () => {
    expect(previewKind('application/pdf')).toBe(PreviewKind.Pdf);
    expect(previewKind('text/markdown; charset=utf-8')).toBe(PreviewKind.Markdown);
    expect(previewKind('application/json')).toBe(PreviewKind.Text);
    expect(previewKind('image/svg+xml')).toBe(PreviewKind.Image);
    expect(previewKind('text/html')).toBe(PreviewKind.None);
    expect(previewKind('application/zip')).toBe(PreviewKind.None);
  });

  it('labels types for the list', () => {
    expect(typeLabel('image/svg+xml')).toBe('SVG image');
    expect(typeLabel('audio/x-wav')).toBe('WAV audio');
    expect(typeLabel('application/vnd.foo')).toBe('application/vnd.foo');
  });
});
