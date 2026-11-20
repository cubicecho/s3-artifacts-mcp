import { describe, expect, it } from 'vitest';
import { DOCUMENT_DEFAULTS } from '../../core/defaults.ts';
import { objectKeyFor, safeKeyName } from '../../documents/keys.ts';

const OBJECT_ID = '0b7c8a52-5a52-4d6e-9d1f-6f3f0c2a9e11';

describe('object keys', () => {
  it('puts the object id before the filename, at the bucket top level', () => {
    expect(objectKeyFor(OBJECT_ID, 'report.pdf')).toBe(`${OBJECT_ID}-report.pdf`);
  });

  it.each([
    ['a path', 'reports/2026/q3.pdf', 'reports-2026-q3.pdf'],
    ['spaces and punctuation', 'My report (final) #2.pdf', 'My-report-final-2.pdf'],
    ['accents', 'résumé.docx', 'resume.docx'],
    ['a script with no ASCII form', '報告.pdf', 'file.pdf'],
    ['a name that is only an extension', '.env', 'file.env'],
    ['nothing safe at all', '???', 'file'],
    ['a backslash', 'C:\\temp\\x.txt', 'C-temp-x.txt'],
  ])('makes %s safe', (_case, filename, expected) => {
    expect(safeKeyName(filename)).toBe(expected);
  });

  it('caps the length and keeps the extension', () => {
    const name = safeKeyName(`${'a'.repeat(500)}.tar`);
    expect(name).toHaveLength(DOCUMENT_DEFAULTS.keyFilenameMaxLength);
    expect(name.endsWith('a.tar')).toBe(true);
  });

  it('never has a slash or a character outside the safe set', () => {
    const key = objectKeyFor(OBJECT_ID, '../../etc/passwd\u0000 ü?*<>|"');
    expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(key).not.toContain('/');
  });
});
