import { type BucketProvider, bucketProvider } from '@cubicecho/s3-artifacts-mcp-db/schema';
import { z } from 'zod';
import { BUCKET_DEFAULTS } from '../core/defaults.ts';
import { badInput } from '../core/errors.ts';
import { parseOrThrow } from '../core/validation.ts';
import { BUCKET_PRESETS, regionFromB2Endpoint } from './presets.ts';

// A bucket's settings as the form sends them, checked and completed from the provider's preset.
// Creating and updating both end here: an update is the stored row with the changes laid over it.

const { nameMaxLength, slugMaxLength } = BUCKET_DEFAULTS;

/** Lowercase letters and digits in runs joined by single hyphens: safe in a URL path as it is. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** What a slug derived from a name drops: everything but letters and digits, in runs. */
const NOT_SLUG = /[^a-z0-9]+/g;
/** Hyphens left at either end once the rest is replaced. */
const EDGE_HYPHENS = /^-+|-+$/g;
/** Combining marks, which `normalize('NFKD')` splits off accented letters. */
const COMBINING_MARKS = /\p{M}/gu;
/** A region name: letters, digits, hyphens and underscores (`us-east-1`, `us-west-004`). */
const REGION = /^[\w-]+$/;
/** A bucket name as S3-compatible services accept one: 3 to 63 letters, digits, dots, hyphens or underscores. */
const BUCKET_NAME = /^[A-Za-z0-9][\w.-]{1,61}[A-Za-z0-9]$/;
/** The protocols an endpoint may use. */
const ENDPOINT_PROTOCOLS = new Set(['http:', 'https:']);
/** The path of an endpoint URL that names only a host. */
const ROOT_PATH = '/';

/** A bucket's settings once checked: what is stored, apart from the secret. */
export interface BucketFields {
  name: string;
  slug: string;
  provider: BucketProvider;
  endpoint: string | null;
  publicEndpoint: string | null;
  region: string;
  bucket: string;
  accessKeyId: string;
  forcePathStyle: boolean;
}

/** A bucket's settings as sent: the fields a preset can fill in may be missing. */
export interface BucketFieldsInput {
  name: string;
  slug?: string | null;
  provider: BucketProvider;
  endpoint?: string | null;
  publicEndpoint?: string | null;
  region?: string | null;
  bucket: string;
  accessKeyId: string;
  forcePathStyle?: boolean | null;
}

/** An optional text field: blank is the same as left out. */
const optionalText = z
  .string()
  .nullish()
  .transform((value) => {
    const trimmed = value?.trim() ?? '';
    return trimmed === '' ? null : trimmed;
  });

/**
 * An endpoint: an http or https URL that names a host and nothing under it.
 *
 * @param label - What the field is called in a message.
 * @returns A schema parsing to the URL's origin, or null when blank.
 */
function endpointSchema(label: string) {
  return optionalText.transform((value, ctx) => {
    if (value === null) {
      return null;
    }
    const url = URL.canParse(value) ? new URL(value) : null;
    const isHttp = url !== null && ENDPOINT_PROTOCOLS.has(url.protocol);
    if (isHttp === false) {
      ctx.addIssue({
        code: 'custom',
        message: `${label} has to be an http or https URL, such as https://s3.example.com.`,
      });
      return z.NEVER;
    }
    const hasMore = url.pathname !== ROOT_PATH || url.search !== '' || url.hash !== '' || url.username !== '';
    if (hasMore) {
      ctx.addIssue({ code: 'custom', message: `${label} names only a scheme, a host and a port, with no path.` });
      return z.NEVER;
    }
    return url.origin;
  });
}

const fieldsSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Give the bucket a name.')
    .max(nameMaxLength, `Keep the name to ${nameMaxLength} characters.`),
  slug: optionalText.pipe(
    z
      .string()
      .max(slugMaxLength, `Keep the slug to ${slugMaxLength} characters.`)
      .regex(SLUG, 'A slug is lowercase letters and digits, joined by single hyphens, such as team-reports.')
      .nullable(),
  ),
  provider: z.enum(bucketProvider.enumValues, { message: 'Choose a provider.' }),
  endpoint: endpointSchema('The endpoint'),
  publicEndpoint: endpointSchema('The public endpoint'),
  region: optionalText.pipe(
    z.string().regex(REGION, 'A region is letters, digits and hyphens, such as us-east-1.').nullable(),
  ),
  bucket: z
    .string()
    .trim()
    .regex(BUCKET_NAME, 'A bucket name is 3 to 63 letters, digits, dots or hyphens, as the provider shows it.'),
  accessKeyId: z.string().trim().min(1, 'Enter the access key ID.'),
  forcePathStyle: z.boolean().nullish(),
});

/** A secret access key as sent: required wherever it is asked for, and never blank. */
export const secretSchema = z.string().trim().min(1, 'Enter the secret access key.');

/**
 * Makes a slug from a bucket's name: `Team Reports (2026)` becomes `team-reports-2026`.
 *
 * @param name - The bucket's name.
 * @returns The slug, or an empty string when the name has no letters or digits.
 */
export function slugFromName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(NOT_SLUG, '-')
    .slice(0, slugMaxLength)
    .replace(EDGE_HYPHENS, '');
}

/**
 * Checks a bucket's settings and fills in what its provider's preset supplies.
 *
 * @param input - The settings as sent.
 * @returns The settings to store.
 * @throws BAD_USER_INPUT naming the first field that is wrong, or missing for the provider.
 */
export function resolveBucketFields(input: BucketFieldsInput): BucketFields {
  const fields = parseOrThrow(fieldsSchema, input);
  const preset = BUCKET_PRESETS[fields.provider];

  if (preset.endpointRequired && fields.endpoint === null) {
    const example = preset.endpointExample === null ? '' : `, such as ${preset.endpointExample}`;
    throw badInput(`${preset.label} needs an endpoint: the address the server reaches it at${example}.`);
  }
  const derivedRegion =
    fields.provider === 'b2' && fields.endpoint !== null ? regionFromB2Endpoint(fields.endpoint) : null;
  const region = fields.region ?? derivedRegion ?? preset.defaultRegion;
  if (region === null) {
    throw badInput(`${preset.label} needs a region, such as us-east-1.`);
  }

  const slug = fields.slug ?? slugFromName(fields.name);
  if (slug === '') {
    throw badInput('Give the bucket a slug: its name has no letters or digits to make one from.');
  }

  return {
    name: fields.name,
    slug,
    provider: fields.provider,
    endpoint: fields.endpoint,
    publicEndpoint: fields.publicEndpoint,
    region,
    bucket: fields.bucket,
    accessKeyId: fields.accessKeyId,
    forcePathStyle: fields.forcePathStyle ?? preset.forcePathStyle,
  };
}

/** The settings a connection depends on. A change to any of them reruns the test before saving. */
const CONNECTION_FIELDS = [
  'provider',
  'endpoint',
  'publicEndpoint',
  'region',
  'bucket',
  'accessKeyId',
  'forcePathStyle',
] as const satisfies readonly (keyof BucketFields)[];

/**
 * Whether new settings reach the bucket differently from the stored ones.
 *
 * @param stored - The settings as saved.
 * @param next - The settings about to be saved.
 * @returns True when any connection field differs.
 */
export function connectionChanged(stored: BucketFields, next: BucketFields): boolean {
  return CONNECTION_FIELDS.some((field) => stored[field] !== next[field]);
}
