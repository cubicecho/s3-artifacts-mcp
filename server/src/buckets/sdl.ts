import { parse } from 'graphql';

// The hand-written half of the buckets API. The `Bucket` type itself is generated from the table
// (its sealed secret excluded in build-schema.ts); the descriptions of its columns are in docs.ts.

/** The SDL `applyBucketsExtension` adds to the generated schema. */
export const BUCKETS_SDL = parse(`
  "How the bucket form starts out for one provider. Every value is a starting point the owner can change."
  type BucketPreset {
    provider: BucketProvider!
    "What the form calls the provider."
    label: String!
    "Whether the bucket is addressed in the path (\`host/bucket/key\`) rather than the host (\`bucket.host/key\`)."
    forcePathStyle: Boolean!
    "The region the form starts with, or null when the owner has to name one."
    defaultRegion: String
    "Whether the bucket can only be saved with an endpoint. On AWS a missing endpoint means the regional default."
    endpointRequired: Boolean!
    "Whether the bucket can only be saved with a region."
    regionRequired: Boolean!
    "An example endpoint for the form to show as a placeholder, or null when there is nothing useful to show."
    endpointExample: String
  }

  "One step of a bucket's connection test, in the order they run."
  enum BucketTestStep {
    "HeadBucket: the bucket exists and the access key may reach it."
    HEAD_BUCKET
    "The probe object is written."
    PUT_OBJECT
    "The probe object is read back, and its bytes match."
    GET_OBJECT
    """
    A GET for the probe object, signed for the public endpoint, is fetched from the server. Its failure is
    only a warning: the server may not reach an address that browsers can.
    """
    SHARE_LINK
    "The probe object is deleted. It runs whenever the probe was written, even after a failed read."
    DELETE_OBJECT
  }

  "How one step of a connection test went."
  type BucketTestStepResult {
    step: BucketTestStep!
    "Whether the step passed. False when it failed or never ran."
    ok: Boolean!
    "Whether the step never ran, because an earlier one failed or the test ran out of time."
    skipped: Boolean!
    "The code the service answered with (\`NoSuchBucket\`, \`AccessDenied\`, \`SignatureDoesNotMatch\`, …), or null."
    errorCode: String
    "What went wrong, in words, or null when the step passed."
    message: String
  }

  "The outcome of testing a bucket's settings."
  type BucketTestResult {
    """
    Whether the bucket can be saved: every step but SHARE_LINK passed. A failed SHARE_LINK step leaves this
    true and sets \`shareLinkWarning\`.
    """
    ok: Boolean!
    "Every step, in the order they run, including the ones that were skipped."
    steps: [BucketTestStepResult!]!
    "Set when the server could not open a link signed for the public endpoint, so share links may not open from a browser."
    shareLinkWarning: String
  }

  """
  A bucket's settings, as the form sends them. Every field is checked against the provider's preset: an
  endpoint is required for MinIO, RustFS and Backblaze B2, and a region for AWS S3 and Backblaze B2.
  """
  input BucketInput {
    "What the UI calls the bucket."
    name: String!
    """
    Names the bucket's MCP endpoint (\`/mcp/b/<slug>\`): lowercase letters, digits and single hyphens, unique on
    the instance. Derived from \`name\` when left out.
    """
    slug: String
    provider: BucketProvider!
    "The address the server reaches the service at. Leave it out on AWS for the regional default."
    endpoint: String
    "The address share links are signed for, as browsers reach the service. Defaults to \`endpoint\`."
    publicEndpoint: String
    """
    The bucket's region. MinIO and RustFS default to \`us-east-1\`, and Backblaze B2's is read from its endpoint
    when left out.
    """
    region: String
    "The bucket's name at the provider."
    bucket: String!
    accessKeyId: String!
    """
    The access key's secret. Required to create a bucket. \`testBucket\` with an \`id\` uses the stored one when
    this is left out.
    """
    secretAccessKey: String
    "Path-style addressing. Defaults to the provider's preset."
    forcePathStyle: Boolean
  }

  """
  Changes to a bucket's settings. A field left out keeps its value, and \`endpoint\` or \`publicEndpoint\` sent as
  null clears it. A change to anything the connection depends on reruns the test, and a failure refuses the save.
  """
  input BucketUpdateInput {
    name: String
    "Renames the bucket's MCP endpoint, so clients configured with the old URL stop reaching it."
    slug: String
    provider: BucketProvider
    endpoint: String
    publicEndpoint: String
    region: String
    bucket: String
    "A new access key stops every share link signed with the old one."
    accessKeyId: String
    "Replaces the stored secret. Left out, the stored one is kept."
    secretAccessKey: String
    forcePathStyle: Boolean
  }

  extend type Bucket {
    """
    Whether the stored secret can still be decrypted. False after \`BETTER_AUTH_SECRET\` changed: the bucket
    then needs its secret entered again (\`setBucketSecret\`) before it can be used.
    """
    secretReadable: Boolean!
  }

  extend type Query {
    "The providers a bucket can be on, with what the form starts out with for each."
    bucketPresets: [BucketPreset!]!
  }

  extend type Mutation {
    """
    Tests a bucket's settings without saving them: HeadBucket, then a probe object written, read and deleted,
    then a share link to it fetched. With \`id\` and no \`secretAccessKey\`, the bucket's stored secret is used,
    so a saved bucket can be retested or edited without typing it again. A failed step is reported in the
    result, not as an error.
    """
    testBucket(input: BucketInput!, id: UUID): BucketTestResult!
    """
    Adds a bucket after testing it. BAD_USER_INPUT, with \`extensions.step\` and \`extensions.errorCode\`, when a
    step other than SHARE_LINK fails; CONFLICT when the slug is taken.
    """
    createBucket(input: BucketInput!): Bucket!
    "Changes a bucket's settings, retesting it when the connection changes. Refused as createBucket is."
    updateBucket(id: UUID!, input: BucketUpdateInput!): Bucket!
    "Replaces a bucket's stored secret, as after \`BETTER_AUTH_SECRET\` changed, and retests the bucket with it."
    setBucketSecret(id: UUID!, secretAccessKey: String!): Bucket!
    "Whether MCP clients may reach the bucket, and whether they may write to it. Writable needs enabled."
    setBucketMcp(id: UUID!, enabled: Boolean!, writable: Boolean!): Bucket!
    """
    Removes a bucket from the instance. The objects in it are left alone. Refused while documents point at it,
    unless \`forgetDocuments\` is true, which deletes those documents' rows (not their objects).
    """
    deleteBucket(id: UUID!, forgetDocuments: Boolean = false): Boolean!
  }
`);
