import { GraphQLError } from 'graphql';
import type { BucketPresetsQuery, BucketProvider } from '@/__generated__/graphql';
import type { BucketTestOutcome } from '@/components/domain/bucket-test-report';
import type { BucketScanResult } from '@/lib/bucket-scan';
import { clientId } from '@/lib/id';

// Buckets and presets as the server answers them, for the stories' mock servers. The mock
// executes against the real SDL, so a field the server renames fails the stories that use these.

/** The presets `bucketPresets` answers, as `server/src/buckets/presets.ts` has them. */
export const BUCKET_PRESETS: BucketPresetsQuery['bucketPresets'] = [
  {
    provider: 's3',
    label: 'AWS S3',
    forcePathStyle: false,
    defaultRegion: null,
    endpointRequired: false,
    regionRequired: true,
    endpointExample: null,
  },
  {
    provider: 'minio',
    label: 'MinIO',
    forcePathStyle: true,
    defaultRegion: 'us-east-1',
    endpointRequired: true,
    regionRequired: false,
    endpointExample: 'http://minio.lan:9000',
  },
  {
    provider: 'rustfs',
    label: 'RustFS',
    forcePathStyle: true,
    defaultRegion: 'us-east-1',
    endpointRequired: true,
    regionRequired: false,
    endpointExample: 'http://rustfs.lan:9000',
  },
  {
    provider: 'b2',
    label: 'Backblaze B2',
    forcePathStyle: false,
    defaultRegion: null,
    endpointRequired: true,
    regionRequired: true,
    endpointExample: 'https://s3.us-west-004.backblazeb2.com',
  },
];

/** A bucket as `buckets` answers it. */
export interface BucketFixture {
  id: string;
  slug: string;
  name: string;
  provider: BucketProvider;
  endpoint: string | null;
  publicEndpoint: string | null;
  region: string;
  bucket: string;
  accessKeyId: string;
  forcePathStyle: boolean;
  mcpEnabled: boolean;
  mcpWritable: boolean;
  secretReadable: boolean;
  createdAt: string;
  updatedAt: string;
}

const CREATED = '2026-11-01T09:00:00.000Z';

/** A MinIO on the home network. */
export const MINIO_BUCKET: BucketFixture = {
  id: '0b6f1c2a-3d4e-4f50-8a61-7b8c9d0e1f20',
  slug: 'artifacts',
  name: 'Artifacts',
  provider: 'minio',
  endpoint: 'http://minio.lan:9000',
  publicEndpoint: 'https://files.example.com',
  region: 'us-east-1',
  bucket: 'artifacts',
  accessKeyId: 'minio-owner',
  forcePathStyle: true,
  mcpEnabled: false,
  mcpWritable: false,
  secretReadable: true,
  createdAt: CREATED,
  updatedAt: CREATED,
};

/** AWS, on the regional default endpoint. */
export const S3_BUCKET: BucketFixture = {
  ...MINIO_BUCKET,
  id: '1c7a2d3b-4e5f-4061-9b72-8c9d0e1f2a31',
  slug: 'reports',
  name: 'Reports',
  provider: 's3',
  endpoint: null,
  publicEndpoint: null,
  region: 'eu-west-1',
  bucket: 'acme-reports',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  forcePathStyle: false,
};

/** Backblaze B2, a second account. */
export const B2_BUCKET: BucketFixture = {
  ...MINIO_BUCKET,
  id: '2d8b3e4c-5f60-4172-8c83-9d0e1f2a3b42',
  slug: 'backups',
  name: 'Backups',
  provider: 'b2',
  endpoint: 'https://s3.us-west-004.backblazeb2.com',
  publicEndpoint: null,
  region: 'us-west-004',
  bucket: 'acme-backups',
  accessKeyId: '004a1b2c3d4e5f60000000001',
  forcePathStyle: false,
};

/** RustFS, on the same network as the MinIO. */
export const RUSTFS_BUCKET: BucketFixture = {
  ...MINIO_BUCKET,
  id: '3e9c4f5d-6071-4283-9d94-0e1f2a3b4c53',
  slug: 'scratch',
  name: 'Scratch',
  provider: 'rustfs',
  endpoint: 'http://rustfs.lan:9000',
  publicEndpoint: null,
  bucket: 'scratch',
  accessKeyId: 'rustfs-owner',
};

/** One of each provider, in no particular order. */
export const MIXED_BUCKETS: readonly BucketFixture[] = [S3_BUCKET, B2_BUCKET, MINIO_BUCKET, RUSTFS_BUCKET];

/** Every step of a test, as `testBucket` answers them. */
const STEPS = ['HEAD_BUCKET', 'PUT_OBJECT', 'GET_OBJECT', 'DELETE_OBJECT', 'SHARE_LINK'] as const;

/** A step that passed. */
function passed(step: (typeof STEPS)[number]) {
  return { step, ok: true, skipped: false, errorCode: null, message: null };
}

/** A test where every step passed. */
export const TEST_PASSED: BucketTestOutcome = { ok: true, shareLinkWarning: null, steps: STEPS.map(passed) };

/** A test that failed at HeadBucket: the secret is wrong. Every later step was skipped. */
export const TEST_FAILED: BucketTestOutcome = {
  ok: false,
  shareLinkWarning: null,
  steps: [
    {
      step: STEPS[0],
      ok: false,
      skipped: false,
      errorCode: 'SignatureDoesNotMatch',
      message: 'The request signature we calculated does not match the signature you provided.',
    },
    ...STEPS.slice(1).map((step) => ({ step, ok: false, skipped: true, errorCode: null, message: null })),
  ],
};

/** A test that passed, but the server could not open a link signed for the public endpoint. */
export const TEST_WARNED: BucketTestOutcome = {
  ok: true,
  shareLinkWarning: 'The server could not reach https://files.example.com, so share links may not open from a browser.',
  steps: [
    ...STEPS.slice(0, -1).map(passed),
    {
      step: STEPS[STEPS.length - 1],
      ok: false,
      skipped: false,
      errorCode: null,
      message: 'fetch failed: getaddrinfo ENOTFOUND files.example.com',
    },
  ],
};

/** What the mock server's mutations are told to do. */
interface BucketServerOptions {
  /** What `testBucket` answers. */
  test?: BucketTestOutcome;
  /** When set, `createBucket`, `updateBucket` and `setBucketSecret` refuse with this message. */
  saveRefusal?: string;
  /** When set, `deleteBucket` without `forgetDocuments` refuses as the server does while documents remain. */
  hasDocuments?: boolean;
  /** What `scanBucket` answers: a result, or a refusal's message. Left out, it finds nothing. */
  scan?: BucketScanResult | string;
  /** When set, `setBucketMcp` refuses with this message. */
  mcpRefusal?: string;
}

/** What `setBucketMcp` was asked, in order. */
export interface BucketMcpCall {
  id: string;
  enabled: boolean;
  writable: boolean;
}

/** A scan that found every file listed already. */
export const SCAN_NOTHING_NEW: BucketScanResult = {
  imported: 0,
  alreadyListed: 0,
  skippedCount: 0,
  skipped: [],
  truncated: false,
};

/** Longer than the 255 characters a filename may be. */
const SKIPPED_NAME_LENGTH = 300;

/** A scan that added files, found some listed already, and could not add two. */
export const SCAN_ADDED: BucketScanResult = {
  imported: 12,
  alreadyListed: 3,
  skippedCount: 2,
  skipped: [
    { key: 'exports/bad\nname.csv', reason: 'A filename cannot contain control characters.' },
    { key: `archive/${'x'.repeat(SKIPPED_NAME_LENGTH)}.txt`, reason: 'A filename can be at most 255 characters.' },
  ],
  truncated: false,
};

/** `BucketInput` as a mutation receives it. */
interface BucketInputArgs {
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

/**
 * A server holding buckets that its mutations really change, so a story sees the list move.
 *
 * @param start - The buckets it starts with.
 * @param options - What its test answers, and what it refuses.
 * @returns The resolvers, the list itself, and every `setBucketMcp` call, for a story to inspect.
 */
export function bucketServer(start: readonly BucketFixture[], options: BucketServerOptions = {}) {
  const buckets = start.map((bucket) => ({ ...bucket }));
  const mcpCalls: BucketMcpCall[] = [];
  const refuseSave = () => {
    if (options.saveRefusal) {
      throw new GraphQLError(options.saveRefusal, { extensions: { code: 'BAD_USER_INPUT' } });
    }
  };
  const resolvers = {
    Query: {
      buckets: () => buckets,
      bucketPresets: () => BUCKET_PRESETS,
    },
    Mutation: {
      testBucket: () => options.test ?? TEST_PASSED,
      scanBucket: () => {
        if (typeof options.scan === 'string') {
          throw new GraphQLError(options.scan, { extensions: { code: 'STORAGE_ERROR' } });
        }
        return options.scan ?? SCAN_NOTHING_NEW;
      },
      createBucket: (_parent: unknown, args: { input: BucketInputArgs }) => {
        refuseSave();
        const { input } = args;
        const made: BucketFixture = {
          ...MINIO_BUCKET,
          ...input,
          id: clientId(),
          slug: input.slug ?? input.name.toLowerCase(),
          endpoint: input.endpoint ?? null,
          publicEndpoint: input.publicEndpoint ?? null,
          region: input.region ?? 'us-east-1',
          forcePathStyle: input.forcePathStyle ?? false,
        };
        buckets.push(made);
        return made;
      },
      updateBucket: (_parent: unknown, args: { id: string; input: Partial<BucketInputArgs> }) => {
        refuseSave();
        const bucket = buckets.find((entry) => entry.id === args.id);
        if (bucket === undefined) {
          throw new GraphQLError('No such bucket', { extensions: { code: 'NOT_FOUND' } });
        }
        Object.assign(bucket, args.input, { secretReadable: true });
        return bucket;
      },
      setBucketSecret: (_parent: unknown, args: { id: string; secretAccessKey: string }) => {
        refuseSave();
        const bucket = buckets.find((entry) => entry.id === args.id);
        if (bucket === undefined) {
          throw new GraphQLError('No such bucket', { extensions: { code: 'NOT_FOUND' } });
        }
        bucket.secretReadable = true;
        return bucket;
      },
      setBucketMcp: (_parent: unknown, args: BucketMcpCall) => {
        mcpCalls.push({ id: args.id, enabled: args.enabled, writable: args.writable });
        if (options.mcpRefusal) {
          throw new GraphQLError(options.mcpRefusal, { extensions: { code: 'BAD_USER_INPUT' } });
        }
        const bucket = buckets.find((entry) => entry.id === args.id);
        if (bucket === undefined) {
          throw new GraphQLError('No such bucket', { extensions: { code: 'NOT_FOUND' } });
        }
        // As the server: writable needs enabled.
        if (args.writable && args.enabled === false) {
          throw new GraphQLError('Turn MCP on for the bucket before making it writable.', {
            extensions: { code: 'BAD_USER_INPUT' },
          });
        }
        Object.assign(bucket, { mcpEnabled: args.enabled, mcpWritable: args.writable });
        return bucket;
      },
      deleteBucket: (_parent: unknown, args: { id: string; forgetDocuments?: boolean | null }) => {
        const isRefused = options.hasDocuments === true && args.forgetDocuments !== true;
        if (isRefused) {
          throw new GraphQLError('3 documents are still in this bucket. Forget them first, or remove them.', {
            extensions: { code: 'CONFLICT' },
          });
        }
        buckets.splice(
          buckets.findIndex((bucket) => bucket.id === args.id),
          1,
        );
        return true;
      },
    },
  };
  return { resolvers, buckets, mcpCalls };
}
