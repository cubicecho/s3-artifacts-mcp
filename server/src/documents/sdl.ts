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
  }
`);
