import { type BucketProvider, bucketProvider } from '@cubicecho/s3-artifacts-mcp-db/schema';

// What the bucket form starts out with for each provider, and what a bucket on it must have.
// A preset fills the form and checks the save; nothing else is keyed by provider.

/** One provider's preset, as `bucketPresets` answers it. */
export interface BucketPreset {
  provider: BucketProvider;
  /** What the form calls the provider. */
  label: string;
  /** Whether buckets are addressed in the path rather than the host. */
  forcePathStyle: boolean;
  /** The region the form starts with, or null when the owner has to name one. */
  defaultRegion: string | null;
  /** Whether a bucket on it can only be saved with an endpoint. */
  endpointRequired: boolean;
  /** Whether a bucket on it can only be saved with a region. */
  regionRequired: boolean;
  /** An example endpoint, for the form's placeholder. */
  endpointExample: string | null;
}

/** The region MinIO and RustFS answer to unless they are set up otherwise. */
const SELF_HOSTED_REGION = 'us-east-1';

/** Every provider's preset. */
export const BUCKET_PRESETS: Readonly<Record<BucketProvider, Readonly<BucketPreset>>> = Object.freeze({
  s3: Object.freeze({
    provider: 's3',
    label: 'AWS S3',
    forcePathStyle: false,
    defaultRegion: null,
    endpointRequired: false,
    regionRequired: true,
    endpointExample: null,
  }),
  minio: Object.freeze({
    provider: 'minio',
    label: 'MinIO',
    forcePathStyle: true,
    defaultRegion: SELF_HOSTED_REGION,
    endpointRequired: true,
    regionRequired: false,
    endpointExample: 'http://minio.lan:9000',
  }),
  rustfs: Object.freeze({
    provider: 'rustfs',
    label: 'RustFS',
    forcePathStyle: true,
    defaultRegion: SELF_HOSTED_REGION,
    endpointRequired: true,
    regionRequired: false,
    endpointExample: 'http://rustfs.lan:9000',
  }),
  b2: Object.freeze({
    provider: 'b2',
    label: 'Backblaze B2',
    forcePathStyle: false,
    defaultRegion: null,
    endpointRequired: true,
    regionRequired: true,
    endpointExample: 'https://s3.us-west-004.backblazeb2.com',
  }),
});

/** Every preset, in the order the provider enum declares them. */
export const BUCKET_PRESET_LIST: readonly BucketPreset[] = Object.freeze(
  bucketProvider.enumValues.map((provider) => BUCKET_PRESETS[provider]),
);

/** A Backblaze B2 S3 endpoint's host, whose second label is the region: `s3.us-west-004.backblazeb2.com`. */
const B2_ENDPOINT_HOST = /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/;

/**
 * Reads the region out of a Backblaze B2 endpoint.
 *
 * @param endpoint - The endpoint as entered, a URL.
 * @returns The region (`us-west-004`), or null when the endpoint is not a B2 S3 endpoint.
 */
export function regionFromB2Endpoint(endpoint: string): string | null {
  const isUrl = URL.canParse(endpoint);
  if (isUrl === false) {
    return null;
  }
  return B2_ENDPOINT_HOST.exec(new URL(endpoint).hostname)?.[1] ?? null;
}
