import { afterEach, describe, expect, it, vi } from 'vitest';
import { envPositiveInteger, port, trustProxy } from '../../core/config.ts';
import { HTTP_DEFAULTS } from '../../core/defaults.ts';

const FALLBACK = 7;

describe('envPositiveInteger', () => {
  it('reads a whole number', () => {
    expect(envPositiveInteger('3', FALLBACK)).toBe(3);
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['zero', '0'],
    ['negative', '-2'],
    ['a fraction', '0.5'],
    ['a fraction above one', '1.5'],
    ['not a number', 'many'],
    ['infinite', 'Infinity'],
  ])('falls back when the value is %s', (_name, value) => {
    expect(envPositiveInteger(value, FALLBACK)).toBe(FALLBACK);
  });
});

describe('port', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to HTTP_DEFAULTS.port', () => {
    vi.stubEnv('PORT', undefined);
    expect(port()).toBe(HTTP_DEFAULTS.port);
  });

  it('reads PORT', () => {
    vi.stubEnv('PORT', '4000');
    expect(port()).toBe(4000);
  });
});

describe('trustProxy', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['unset', '', HTTP_DEFAULTS.trustProxy],
    ['off', 'false', false],
    ['on', 'true', true],
    ['a hop count', '1', 1],
    ['a subnet list', 'loopback, 10.0.0.0/8', 'loopback, 10.0.0.0/8'],
  ])('reads %s', (_label, value, expected) => {
    vi.stubEnv('TRUST_PROXY', value);
    expect(trustProxy()).toBe(expected);
  });
});
