import { describe, expect, it } from 'vitest';
import {
  type DocumentFilters,
  matchesDocumentFilters,
  readDocumentFilters,
  TagMatch,
  withDocumentFilters,
} from './document-filters';

const EVERYTHING: DocumentFilters = { bucket: null, tagIds: [], match: TagMatch.Any, title: '', type: null };
const REPORT = {
  title: 'Quarterly Report',
  contentType: 'application/pdf; charset=binary',
  tags: [{ id: 'finance' }, { id: 'q4' }],
};

describe('document filters', () => {
  it('reads everything from an empty query string', () => {
    expect(readDocumentFilters(new URLSearchParams())).toEqual(EVERYTHING);
  });

  it('reads each filter, dropping repeated and empty tag ids', () => {
    const params = new URLSearchParams('bucket=minio&tags=a,,b,a&match=all&q=report&type=application%2Fpdf');
    expect(readDocumentFilters(params)).toEqual({
      bucket: 'minio',
      tagIds: ['a', 'b'],
      match: TagMatch.All,
      title: 'report',
      type: 'application/pdf',
    });
    expect(readDocumentFilters(new URLSearchParams('match=nonsense')).match).toBe(TagMatch.Any);
  });

  it('writes a change and keeps what it does not name', () => {
    const next = withDocumentFilters(new URLSearchParams('bucket=minio&other=1'), { tagIds: ['a', 'b'] });
    expect(next.toString()).toBe('bucket=minio&other=1&tags=a%2Cb');
  });

  it('leaves the URL for a filter back at everything, and match while no tag is chosen', () => {
    const start = new URLSearchParams('bucket=minio&tags=a&match=all&q=x&type=text%2Fplain');
    expect(withDocumentFilters(start, { bucket: null, title: '', type: null }).toString()).toBe('tags=a&match=all');
    expect(withDocumentFilters(start, { tagIds: [] }).has('match')).toBe(false);
    expect(withDocumentFilters(new URLSearchParams('tags=a'), { match: TagMatch.Any }).toString()).toBe('tags=a');
  });

  it('matches title text ignoring case, and the bare type', () => {
    expect(matchesDocumentFilters(REPORT, { ...EVERYTHING, title: ' quarterly ' })).toBe(true);
    expect(matchesDocumentFilters(REPORT, { ...EVERYTHING, title: 'annual' })).toBe(false);
    expect(matchesDocumentFilters(REPORT, { ...EVERYTHING, type: 'application/pdf' })).toBe(true);
    expect(matchesDocumentFilters(REPORT, { ...EVERYTHING, type: 'text/plain' })).toBe(false);
  });

  it('matches any of the tags, or all of them', () => {
    expect(matchesDocumentFilters(REPORT, { ...EVERYTHING, tagIds: ['q4', 'legal'] })).toBe(true);
    expect(matchesDocumentFilters(REPORT, { ...EVERYTHING, tagIds: ['legal'] })).toBe(false);
    expect(matchesDocumentFilters(REPORT, { ...EVERYTHING, tagIds: ['q4', 'finance'], match: TagMatch.All })).toBe(
      true,
    );
    expect(matchesDocumentFilters(REPORT, { ...EVERYTHING, tagIds: ['q4', 'legal'], match: TagMatch.All })).toBe(false);
  });
});
