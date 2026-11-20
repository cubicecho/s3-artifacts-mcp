import { describe, expect, it } from 'vitest';
import { describeExpiry, ExpiryUnit, expiryError, hoursOf, splitHours } from './share-links';
import { describeUploadLimit } from './upload-limit';

const LIMITS = { minLinkExpiryHours: 1, maxLinkExpiryHours: 168 };

describe('describeExpiry', () => {
  it.each([
    [1, '1 hour'],
    [5, '5 hours'],
    [24, '1 day'],
    [36, '36 hours'],
    [168, '7 days'],
  ])('says %i hours as “%s”', (hours, said) => {
    expect(describeExpiry(hours)).toBe(said);
  });
});

describe('hoursOf and splitHours', () => {
  it('turns days into hours, and only whole positive amounts into anything', () => {
    expect(hoursOf(3, ExpiryUnit.Days)).toBe(72);
    expect(hoursOf(12, ExpiryUnit.Hours)).toBe(12);
    expect(hoursOf(1.5, ExpiryUnit.Days)).toBeNull();
    expect(hoursOf(0, ExpiryUnit.Hours)).toBeNull();
    expect(hoursOf(null, ExpiryUnit.Hours)).toBeNull();
  });

  it('shows whole days in days and the rest in hours', () => {
    expect(splitHours(48)).toEqual({ amount: 2, unit: ExpiryUnit.Days });
    expect(splitHours(30)).toEqual({ amount: 30, unit: ExpiryUnit.Hours });
  });
});

describe('expiryError', () => {
  it('takes the bounds themselves', () => {
    expect(expiryError(1, LIMITS)).toBeUndefined();
    expect(expiryError(168, LIMITS)).toBeUndefined();
  });

  it('says the range for anything past it, or for an amount that is not whole', () => {
    expect(expiryError(169, LIMITS)).toBe('Choose from 1 hour to 7 days');
    expect(expiryError(null, LIMITS)).toBe('Enter a whole number of hours or days, from 1 hour to 7 days');
  });
});

describe('describeUploadLimit', () => {
  it('writes whole gibibytes as GiB and the rest in MiB', () => {
    expect(describeUploadLimit(104_857_600)).toBe('100 MiB');
    expect(describeUploadLimit(53_687_091_200)).toBe('50 GiB');
    expect(describeUploadLimit(1_610_612_736)).toBe('1536 MiB');
  });
});
