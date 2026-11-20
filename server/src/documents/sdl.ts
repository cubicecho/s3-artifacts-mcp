import { parse } from 'graphql';

// The hand-written half of the documents API. The `Document` type itself, and the `documents` /
// `document` reads, are generated from the table; the descriptions of its columns are in docs.ts.

/** The SDL `applyDocumentsExtension` adds to the generated schema. */
export const DOCUMENTS_SDL = parse(`
  "A document waiting for its bytes, and where to send them."
  type DocumentUpload {
    "The new document, \`pending_upload\` until its bytes have arrived."
    document: Document!
    """
    Where to send the file: \`PUT\` exactly \`size\` bytes to this path, with \`Authorization: Bearer <session token>\`.
    It answers 200 with the document once it is \`ready\`. A failed or shorter or longer body removes the document,
    and a pending one that never gets its bytes is removed after a while.
    """
    uploadPath: String!
  }

  "A file a bucket scan found and could not add, and why."
  type SkippedObject {
    key: String!
    reason: String!
  }

  "What a bucket scan did."
  type BucketScan {
    "Files added as documents."
    imported: Int!
    "Files a document already pointed at, the app's own uploads among them."
    alreadyListed: Int!
    "How many files could not be added: a key with control characters, or a name too long to download as."
    skippedCount: Int!
    "The first of those, with why."
    skipped: [SkippedObject!]!
    "True when the scan stopped at its limit with files left. Scanning again carries on from there."
    truncated: Boolean!
  }

  extend type Document {
    """
    A URL that reads the document's bytes without a session, for \`<img>\`, \`<iframe>\`, \`<video>\` and
    \`<a download>\`, which cannot send one. It is relative (same origin), stops working after a few minutes, and
    stops at once when the document's object key changes. \`download\` asks for an attachment rather than inline.
    Only a \`ready\` document's URL answers. Select \`id\` beside it.
    """
    contentUrl(download: Boolean = false): String!
  }

  extend type Mutation {
    """
    Starts an upload into one of the caller's buckets: inserts a \`pending_upload\` document and answers where to
    send its bytes. \`size\` is in bytes, a whole number, and at most the upload limit. \`contentType\` defaults to
    \`application/octet-stream\`. The title starts as the filename without its extension. BAD_USER_INPUT for an
    empty or oversized file, a bad filename or type, or a bucket whose secret can no longer be decrypted;
    NOT_FOUND for a bucket that is missing or someone else's.
    """
    createDocumentUpload(bucketId: UUID!, filename: String!, contentType: String, size: Float!): DocumentUpload!
    "Changes a document's title. Its filename and object key stay as they are."
    renameDocument(id: UUID!, title: String!): Document!
    """
    Deletes a document: its object in the bucket, then its row. An object that is already gone is not an error.
    BAD_USER_INPUT when the bucket's secret can no longer be decrypted, and STORAGE_ERROR when the bucket refuses
    the delete; the document is kept in both cases.
    """
    deleteDocument(id: UUID!): Boolean!
    """
    Adds the files already in one of the caller's buckets as documents, \`ready\` at once. Each keeps its key; its
    filename is the key's last segment, its title the key without the extension, and its type is guessed from the
    extension. There is no checksum, since the server never reads the bytes. Folder markers (keys ending in \`/\`)
    are passed over, and files that are documents already are counted, not added again, so a scan can be run
    any number of times. NOT_FOUND for a bucket that is missing or someone else's; BAD_USER_INPUT when its secret
    can no longer be decrypted; STORAGE_ERROR when the bucket refuses to be listed (the access key needs list
    permission), with what was added before that kept.
    """
    scanBucket(id: UUID!): BucketScan!
    """
    Revokes every share link of a document by moving its object: the file is copied to a new key at the bucket's
    top level, the document is pointed at it, and the old object is deleted, so every URL signed for the old key
    answers 404 from the bucket. A scanned file leaves the key the owner put it at for one the app makes. NOT_FOUND
    for a document that is missing or someone else's; CONFLICT for one still uploading, or one changed while this
    ran; BAD_USER_INPUT when the bucket's secret can no longer be decrypted; STORAGE_ERROR when the bucket refuses
    the copy, with nothing changed.
    """
    rekeyDocument(id: UUID!): Document!
  }
`);
