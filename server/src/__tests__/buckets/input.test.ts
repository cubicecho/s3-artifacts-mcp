import { describe, expect, it } from 'vitest';
import { type BucketFieldsInput, connectionChanged, resolveBucketFields, slugFromName } from '../../buckets/input.ts';
import { BUCKET_PRESET_LIST, BUCKET_PRESETS, regionFromB2Endpoint } from '../../buckets/presets.ts';
import { BUCKET_DEFAULTS } from '../../core/defaults.ts';
import { ErrorCode } from '../../core/errors.ts';

const RUSTFS: BucketFieldsInput = {
  name: 'Dev artifacts',
  provider: 'rustfs',
  endpoint: 'http://docker.lan:9010',
  bucket: 'artifacts',
  accessKeyId: 's3am',
};

/** The BAD_USER_INPUT message a call throws. */
function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toMatchObject({ extensions: { code: ErrorCode.BadUserInput } });
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected a refusal');
}

describe('bucket presets', () => {
  it('lists every provider once, with B2 among them', () => {
    expect(BUCKET_PRESET_LIST.map((preset) => preset.provider)).toEqual(['s3', 'minio', 'rustfs', 'b2']);
    expect(BUCKET_PRESETS.b2).toMatchObject({
      label: 'Backblaze B2',
      forcePathStyle: false,
      endpointRequired: true,
      regionRequired: true,
    });
  });

  it('reads the region out of a B2 endpoint, and nothing out of another', () => {
    expect(regionFromB2Endpoint('https://s3.us-west-004.backblazeb2.com')).toBe('us-west-004');
    expect(regionFromB2Endpoint('https://s3.eu-central-003.backblazeb2.com:443')).toBe('eu-central-003');
    expect(regionFromB2Endpoint('https://s3.amazonaws.com')).toBeNull();
    expect(regionFromB2Endpoint('not a url')).toBeNull();
  });
});

describe('resolveBucketFields', () => {
  it('fills in what the preset supplies', () => {
    expect(resolveBucketFields(RUSTFS)).toEqual({
      name: 'Dev artifacts',
      slug: 'dev-artifacts',
      provider: 'rustfs',
      endpoint: 'http://docker.lan:9010',
      publicEndpoint: null,
      region: 'us-east-1',
      bucket: 'artifacts',
      accessKeyId: 's3am',
      forcePathStyle: true,
    });
  });

  it('keeps what the owner overrode', () => {
    const fields = resolveBucketFields({ ...RUSTFS, region: 'eu-west-1', forcePathStyle: false, slug: 'mine' });
    expect(fields).toMatchObject({ region: 'eu-west-1', forcePathStyle: false, slug: 'mine' });
  });

  it('lets AWS go without an endpoint but not without a region', () => {
    const aws = { name: 'Reports', provider: 's3', bucket: 'reports-bucket', accessKeyId: 'AKIA' } as const;
    expect(refusal(() => resolveBucketFields(aws))).toMatch(/AWS S3 needs a region/);
    expect(resolveBucketFields({ ...aws, region: 'eu-west-2' })).toMatchObject({
      endpoint: null,
      region: 'eu-west-2',
      forcePathStyle: false,
    });
  });

  it.each(['minio', 'rustfs', 'b2'] as const)('refuses %s without an endpoint', (provider) => {
    expect(refusal(() => resolveBucketFields({ ...RUSTFS, provider, endpoint: '  ' }))).toMatch(/needs an endpoint/);
  });

  it('derives a B2 region from its endpoint, and refuses B2 with neither', () => {
    const b2 = { ...RUSTFS, provider: 'b2', endpoint: 'https://s3.us-west-004.backblazeb2.com' } as const;
    expect(resolveBucketFields(b2)).toMatchObject({ region: 'us-west-004', forcePathStyle: false });
    expect(resolveBucketFields({ ...b2, region: 'us-east-005' }).region).toBe('us-east-005');
    expect(refusal(() => resolveBucketFields({ ...b2, endpoint: 'https://b2.example.com' }))).toMatch(
      /Backblaze B2 needs a region/,
    );
  });

  it.each([
    ['ftp://docker.lan:9010', /http or https/],
    ['docker.lan:9010', /http or https/],
    ['http://docker.lan:9010/artifacts', /no path/],
    ['http://user:pass@docker.lan:9010', /no path/],
  ])('refuses the endpoint %s', (endpoint, message) => {
    expect(refusal(() => resolveBucketFields({ ...RUSTFS, endpoint }))).toMatch(message);
  });

  it('keeps an endpoint as its origin, without a trailing slash', () => {
    const fields = resolveBucketFields({
      ...RUSTFS,
      endpoint: 'http://Docker.LAN:9010/',
      publicEndpoint: 'https://s3.example.com',
    });
    expect(fields).toMatchObject({ endpoint: 'http://docker.lan:9010', publicEndpoint: 'https://s3.example.com' });
  });

  it.each(['Has Spaces', 'UPPER', 'double--hyphen', '-edge', 'a'.repeat(BUCKET_DEFAULTS.slugMaxLength + 1)])(
    'refuses the slug %s',
    (slug) => {
      expect(() => resolveBucketFields({ ...RUSTFS, slug })).toThrow();
    },
  );

  it('refuses a name with nothing to make a slug from, unless a slug is given', () => {
    expect(refusal(() => resolveBucketFields({ ...RUSTFS, name: '!!!' }))).toMatch(/Give the bucket a slug/);
    expect(resolveBucketFields({ ...RUSTFS, name: '!!!', slug: 'bangs' }).slug).toBe('bangs');
  });

  it.each([
    ['name', { name: ' ' }, /Give the bucket a name/],
    ['bucket', { bucket: 'ab' }, /bucket name/],
    ['bucket', { bucket: 'has/slash' }, /bucket name/],
    ['accessKeyId', { accessKeyId: '' }, /access key ID/],
    ['region', { region: 'us east' }, /region/],
  ])('refuses a bad %s', (_field, change, message) => {
    expect(refusal(() => resolveBucketFields({ ...RUSTFS, ...change }))).toMatch(message);
  });
});

describe('slugFromName', () => {
  it.each([
    ['Team Reports (2026)', 'team-reports-2026'],
    ['Café Ünïcode', 'cafe-unicode'],
    ['  --edges--  ', 'edges'],
    ['a'.repeat(100), 'a'.repeat(BUCKET_DEFAULTS.slugMaxLength)],
  ])('makes %s into %s', (name, slug) => {
    expect(slugFromName(name)).toBe(slug);
  });
});

describe('connectionChanged', () => {
  const stored = resolveBucketFields(RUSTFS);

  it('ignores the name and the slug', () => {
    expect(connectionChanged(stored, { ...stored, name: 'Renamed', slug: 'renamed' })).toBe(false);
  });

  it.each(['endpoint', 'publicEndpoint', 'region', 'bucket', 'accessKeyId'] as const)('sees a new %s', (field) => {
    expect(connectionChanged(stored, { ...stored, [field]: 'changed' })).toBe(true);
  });
});
