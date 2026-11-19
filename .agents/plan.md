# s3-artifacts-mcp — v1 plan

Agreed 2026-11-19. Engrafo (`apps/engrafo`) is the reference: copy its shell and
conventions, keep only what the scope below needs.

## Goal

**An agent generates an artifact, uploads it over MCP to a bucket, creates a
share link and hands that link to its user.** Every v1 feature serves this or
the owner's management of it. The acceptance test (see "Testing") is this
sequence, end to end, against a real RustFS.

Two kinds of artifact, two upload paths:

- **Text the model wrote itself** (markdown, HTML, CSV, JSON, code): the model already has it as text, so it is sent inline in one tool call (`upload_document`).
- **A file on the agent's disk** (PDF, image, zip; anything binary or large): the model cannot pass those bytes through a tool argument without emitting them as tokens. So the server hands out a presigned PUT URL, the agent's shell uploads to it (`curl -T`), and a second call completes it (`create_upload` → PUT → `complete_upload`). This needs an agent with a shell (Claude Code and the like). Claude Desktop or claude.ai without a shell can use only the text path.

Both paths can create the share link in the same call (`share: {...}`), so the
common case takes one call (text) or two calls and a `curl` (file). The link is
signed for the bucket's `public_endpoint`, so it opens wherever the user's
browser can reach that address.

## Context

A small, self-hostable document store over S3-compatible buckets. One person
owns the instance. They upload documents into any of several buckets (AWS S3,
MinIO, RustFS), tag them, hand out share links that point straight at the
bucket, and choose which buckets an MCP client may reach.

v1 scope, and nothing else:

1. Upload documents.
2. Share documents: a link with a permission (view or download) and an expiry.
3. Several buckets, on S3, MinIO or RustFS, configured in the UI.
4. Tag documents.
5. MCP, exposed per bucket.

All settings live in the UI. The environment holds only what is needed before
anyone can sign in (see "Environment").

## Decisions

| # | Decision | Notes |
|---|---|---|
| D1 | **One owner.** The first account to sign in owns the instance; every other address is refused. | Rows still carry `user_id`, so multi-user later is additive (see "Later"). |
| D2 | **Engrafo's app layout** (`app/ server/ db/` workspaces), not the single-operator layout. | A deliberate departure from `cubicecho_backend`'s archetype test: v1 has one user, but the repo should not need restructuring when it grows a second. Postgres like Engrafo, PGlite in tests only. |
| D3 | **Buckets are managed by the owner in Settings**; any bucket can receive uploads. | |
| D4 | **The app's own uploads and downloads stream through the server.** | No bucket CORS is needed for the app, and every backend behaves the same. The server carries the traffic. |
| D5 | **Share links are presigned URLs on the bucket itself**, not links to the app. | The browser fetches straight from the bucket, so the app is not in the path. Consequences in "Share links". |
| D6 | **Only files uploaded through the app are documents.** Existing objects in a bucket are ignored. | A "Scan bucket" import is listed under "Later". |
| D7 | **MCP is read-only by default; `mcp_writable` per bucket** allows upload and tagging. | |
| D8 | **Tags are the owner's** (`user_id`), unique by name ignoring case. | |
| D9 | **No passwords on share links.** They get a permission and an expiry. | |
| D10 | **Bucket secrets and share URLs are encrypted at rest** (AES-256-GCM, key derived from `BETTER_AUTH_SECRET` by HKDF). They are never returned by the API in full. | Engrafo stores its vision key in plaintext; this does not. |
| D11 | **The tree is buckets and their items; there are no folders.** The sidebar keeps Engrafo's tree, with each bucket as a top-level node and its documents (keys) flat beneath it. Every bucket starts collapsed. Objects sit at the bucket's top level, and a dropped folder uploads flat. Tags are the only way to organise. | Tags live in Postgres, not as S3 object tags. |

## Out of scope for v1

Everything in Engrafo that is not listed above: OCR and the processing
pipeline, search and embeddings, folders, trash, merge and title suggestions,
receipts and document dates, vision, backup/export, the watched folder,
duplicate detection. Also: sharing with other accounts, link passwords,
importing existing bucket contents, moving documents between buckets.

## Stack

As Engrafo (see its `AGENTS.md`, "Tech Stack"), minus OCR, pgvector and the
embedding model:

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite, react-router, Apollo Client 4 |
| UI | Tailwind v4, cubeui (shadcn registry), TanStack Form |
| API | graphql-yoga 5 on Express 5, drizzle-graphql generated schema + SDL extensions |
| Database | Drizzle 1.0.0-rc.5 + PostgreSQL (`postgres-js`); PGlite in tests |
| Auth | better-auth (magic link, OIDC pairing, api-key plugin), `@cubicecho/graphql-better-auth` |
| Storage | `@aws-sdk/client-s3`, `@aws-sdk/lib-storage` (streamed multipart upload), `@aws-sdk/s3-request-presigner` (share links) |
| MCP | `@modelcontextprotocol/sdk`, stateless Streamable HTTP, hand-written tools (as Engrafo's `mcp/`) |
| Testing | Vitest (node on PGlite, dom), Storybook + Playwright |
| Tooling | Biome, Node 26 ESM with no server build, semantic-release, Docker (`node:26-slim`) |

Package names: `@cubicecho/s3-artifacts-mcp-app`, `-server`, `-db`. Image:
`ghcr.io/cubicecho/s3-artifacts-mcp`, and nowhere else. **Nothing is published
to Docker Hub.** This differs from Engrafo and from `cubicecho_backend`'s
deploy rule: the release workflow has no Docker Hub login or push, and every
compose file and the README name the GHCR image.

## What comes from Engrafo

| Engrafo | Here |
|---|---|
| Root tooling: `package.json` workspaces, `biome.json`, `tsconfig.base.json`, `vitest.config.ts`, `.releaserc.json`, `.github/`, `no-negation.grit` | Copy, rename. |
| `server/src/core/` (config, defaults, wire, errors, validation, context, preflight, limiter) | Copy, then strip env vars that move to the UI. |
| `server/src/http/` (app, health, shutdown, static) | Copy. Add the `/api/documents/:id/content` routes and `/mcp/b/:slug`. |
| `server/src/graphql/` (handler, build-schema, schema, tenancy, write-schema) | Copy. New `scope` entries for the new tables. |
| `server/src/auth/`, `server/src/sso/` | Copy. Add the single-owner gate. Drop the `OIDC_*` env override; pairing from the UI is the only path. |
| `server/src/api-keys/` | Copy. |
| `server/src/storage/s3.ts` | Adapt into `storage/` (registry over bucket rows, see below). |
| `server/src/documents/create.ts` | Adapt: the pending → ready lifecycle stays, completion now happens when the server-side stream finishes. |
| `server/src/mcp/` | Adapt: per-bucket endpoint, new tools. |
| `db/src/` (index, wait, ssl, defaults, auth models, users, oidc-settings) | Copy. New models below. |
| `app/` shell: cubeui components, `layouts/`, login, verify, sso, settings route shell, `sso-pairing`, `create-api-key-dialog`, `mcp-settings`, `upload-panel`, `lib/apollo`, `lib/upload` | Copy, adapt. |
| `archive-tree`, `archive-sidebar`, `lib/tree` | Adapt into `bucket-tree` and `bucket-sidebar`: two levels only (bucket → item). Drop folder creation, rename-folder and drag-to-move. Keep it mounted on every signed-in page. **It starts collapsed:** every bucket node is shut on load, which means passing `defaultOpen={[]}` to cubeui's `FileTree`, whose default is `"all"` (Engrafo leaves it at that). Nothing opens on its own: not on a reload, not after an upload, and not when a document's page opens. Expansion is not saved. A story covers the collapsed first render. |
| Dockerfile, compose files | Copy, drop the OCR packages and the models stage. Point the image at GHCR. |
| `.github/workflows/release.yml` | Copy, remove the Docker Hub login and push steps. |
| Everything listed in "Out of scope" | Do not copy. |

## Layout

```
s3-artifacts-mcp/
├── app/src/
│   ├── components/{ui,layouts,domain}/   # domain: bucket-tree, bucket-sidebar, upload-panel, document-table, tag-picker, tag-chip,
│   │                                     #   share-link-dialog, bucket-form-dialog, bucket-settings,
│   │                                     #   mcp-settings, api-key-settings, share-link-settings, general-settings
│   ├── routes/            # login, verify, sso, documents, document, tags, settings
│   └── lib/               # apollo, auth, upload, format, page, cn
├── server/src/
│   ├── core/              # config, defaults, wire, errors, validation, context, preflight, limiter, secrets
│   ├── http/              # app, health, shutdown, static, content (stream routes)
│   ├── graphql/           # handler, build-schema, schema, tenancy, write-schema
│   ├── auth/  sso/  api-keys/
│   ├── buckets/           # presets, test (connection probe), resolvers
│   ├── storage/           # storage.ts (the Storage interface), s3.ts (one bucket), registry.ts (all of them)
│   ├── documents/         # create, upload (stream in), download (stream out), rekey, resolvers
│   ├── tags/              # names, resolvers
│   ├── share-links/       # sign, resolvers
│   ├── settings/          # app settings row, resolvers
│   ├── mcp/               # access, tools, endpoint
│   └── __tests__/
├── db/src/models/         # auth, users, oidc-settings, app-settings, buckets, documents, tags, document-tags, share-links
├── .agents/plan.md        # this file
├── AGENTS.md  CLAUDE.md -> AGENTS.md  README.md  .env.example
├── Dockerfile  docker-compose.yml  docker-compose.dev.yml  docker-compose.quickstart.yml
```

## Environment

Only what must exist before the owner can sign in, or that is about the
network rather than the app:

| Var | Why it stays in env |
|---|---|
| `DATABASE_URL` | Settings live in the database. |
| `BETTER_AUTH_SECRET` | Signs sessions and derives the encryption key. Rotating it makes stored bucket secrets and share URLs unreadable; the UI then marks each bucket "re-enter secret". |
| `APP_URL` (optional) | Magic-link and OIDC redirect URLs. |
| `PORT` (optional) | Listening port. |
| `TRUST_PROXY` (optional) | Network fact, needed by the sign-in throttle before anyone is signed in. |
| `SECURE_LOCAL_NET` (optional) | Sign-in without a link on a trusted LAN. It must not be switchable from a UI it unlocks. |
| `DB_CONNECT_TIMEOUT_MS` (optional) | Boot, before the database answers. |

Everything Engrafo reads from `S3_*`, `MAX_UPLOAD_BYTES`, `OIDC_*` and
`SESSION_STORE` moves to Settings or goes away. Sessions are always kept in
Postgres.

## Data model

Conventions as Engrafo: uuid PKs, snake_case, `withTimezone`, `$onUpdate`, an
index on every FK, `user_id` plus a `scope` entry on every user table (the
tenancy test enforces it).

**`app_settings`**: a single row.
- `max_upload_bytes` (default 100 MiB)
- `default_link_expiry_hours` (default 24, at most 168)
- `default_link_permission` (`view` | `download`, default `download`)

**`buckets`**
- `id`, `user_id`
- `slug`: unique, URL-safe; names the MCP endpoint
- `name`: shown in the UI
- `provider`: `s3` | `minio` | `rustfs`. Only a preset, see below.
- `endpoint`: the address the server uses. Null on AWS means the regional default.
- `public_endpoint`: the address a share link is signed for. Defaults to `endpoint`.
- `region`, `bucket`
- `access_key_id`, `secret_access_key_enc`
- `force_path_style`
- `is_default`: at most one, enforced by a partial unique index
- `mcp_enabled`, `mcp_writable`
- `created_at`, `updated_at`

**`documents`**
- `id`, `user_id`, `bucket_id` (FK `ON DELETE RESTRICT`)
- `title`, `filename`, `object_key`, `content_type`, `size`, `sha256`
- `status`: `pending_upload` | `ready`
- `created_at`, `updated_at`

**`tags`**
- `id`, `user_id`, `name`, `color`
- unique on `(user_id, lower(name))`

**`document_tags`**
- `document_id`, `tag_id`: PK on the pair, both `ON DELETE CASCADE`

**`share_links`**
- `id`, `user_id`, `document_id` (`ON DELETE CASCADE`)
- `label` (optional)
- `permission`: `view` | `download`
- `url_enc`: the presigned URL. It is a bearer credential, so it is encrypted.
- `object_key`: the key the URL was signed for, which is how the UI tells the link is dead after a re-key
- `expires_at`
- `created_by`: `owner` | `mcp`
- `created_at`

Better-auth's tables (users, sessions, verification, apikeys) as Engrafo.

## Storage

- **`Storage` interface** (from Engrafo's `s3.ts`): `head`, `getStream(key, range?)`, `upload(key, stream, {contentType, size})`, `copy(from, to)`, `delete(keys)`, `presignGet(key, {filename, contentType, disposition, expiresIn})`.
- **`createS3Storage(bucketRow, secret)`** builds two clients:
  - an internal one on `endpoint`
  - a signer on `public_endpoint`, because a signature covers the host (Engrafo's "two endpoints" rule)
- **`StorageRegistry`** (`storage/registry.ts`):
  - `get(bucketId)` builds the clients lazily and caches them.
  - `invalidate(bucketId)` runs on every bucket write.
  - It is injected through `createApp` deps and the context, so tests hand in an in-memory `Storage`.
- **Provider presets** fill the form; the owner can override any field:
  - `s3`: path-style off, region required, endpoint optional
  - `minio`, `rustfs`: path-style on, endpoint required, region `us-east-1`
- **Test connection** (`testBucket`, also run before every save):
  1. `HeadBucket`
  2. PUT, GET and DELETE a probe object
  3. presign a GET for the probe against `public_endpoint` and fetch it from the server

  A failure in steps 1–2 refuses the save, naming the step and the S3 error code. A failure in step 3 is only a warning ("share links may not open from a browser"), because the server may not be able to reach the public address that browsers can.
- **Object key:** `<objectId>-<sanitized filename>` at the bucket's top level, with no `/` and no bucket prefix setting. `objectId` is a random uuid that starts as the document's id. A bucket is one flat list of items, the filename still shows to anyone browsing it, and keys stay unique without a lookup (D11).
- **Removing a bucket** is refused while documents point at it. "Forget documents" deletes those rows only and leaves the objects in place.

## Uploads and in-app downloads (D4)

1. **Start.** `createDocumentUpload(bucketId?, filename, contentType, size, tagIds?)`:
   - refuses above `max_upload_bytes`
   - inserts a `pending_upload` row (default bucket when none is given)
   - returns `{ document, uploadPath: /api/documents/:id/content }`
2. **Send.** `PUT /api/documents/:id/content` (session only):
   - streams the body to S3 with `lib-storage` `Upload`, hashing SHA-256 as it passes
   - stops at `size` bytes and refuses a shorter or longer body
   - on success, re-heads the object, then sets `sha256` and `status = ready` and applies the tags, in one transaction
   - on failure, aborts the multipart upload and deletes the row
   - is idempotent: a `ready` document answers 409

   The app sends with XHR so each file gets its own progress bar (Engrafo's upload panel, `UPLOAD_DEFAULTS.concurrency` at once).
3. **Clean up.** A sweeper drops `pending_upload` rows older than `UPLOAD_DEFAULTS.pendingTtlMinutes`.
4. **Download.** `GET /api/documents/:id/content[?download=1]` (session only):
   - streams from S3
   - honours `Range`, so PDFs and video seek
   - sets `Content-Disposition` from `filename`
5. **Cross-site safety.** No CORS headers are set on `/api`, and the session cookie is `SameSite=Lax`. A cross-site page can neither PUT nor read.
6. **Preview** on the document page, by type:
   - PDF in an `<iframe>`, images, audio and video in native elements
   - text and markdown rendered (cubeui `Markdown`)
   - anything else: details and a download button

## Share links (D5)

- **Creating a link.** `createShareLink(documentId, permission, expiresInHours, label?)`:
  - signs a GET on the bucket's `public_endpoint` with `response-content-disposition` (`inline` for `view`, `attachment; filename=…` for `download`) and `response-content-type`
  - stores the link encrypted and returns the URL
  - the app shows the URL with a copy button, and it can be copied again from the list later
- **Limits that come from S3, which the UI states:**
  - **Expiry is capped at 7 days** (SigV4's maximum, on AWS, MinIO and RustFS alike). The expiry picker offers 1 hour to 7 days and no "never". `SHARE_LINK_DEFAULTS.maxExpiryHours = 168`.
  - **A single link cannot be revoked before it expires.** S3 checks the signature, not our database.
  - **"Revoke all links" re-keys the document** (`rekeyDocument`). It copies the object to `<new objectId>-<filename>`, deletes the old key, updates `object_key`, and marks every link signed for the old key as revoked. Their URLs now answer 404 from the bucket. It is offered on the document page and confirmed with `ConfirmButton`.
  - **Rotating the bucket's access key** also kills every link signed with it. The bucket form says so when the access key changes.
  - **`view` is not copy protection.** It only asks the browser to show the file inline, and the form's help text says so.
- **Listing and deleting.** `deleteShareLink` removes a link from the list and is labelled "Remove from list". It does not stop the URL, and the confirm text says so.
- **Where links show up.** On the document page (its links) and in Settings → Share links (all links, filterable by state: active, expired, revoked).
- **Reaching the bucket.** The bucket must answer at `public_endpoint` from wherever the recipient is. Opening a link is a top-level navigation, so bucket CORS is not needed for share links either.

## Tags

- **Managing tags:** create, rename, recolor and delete from `/tags`, or create inline from the tag picker. Deleting a tag removes it from every document (cascade) after a confirm that shows the count.
- **Tagging documents:**
  - the tag picker on the document page
  - a column in the documents table
  - bulk add or remove on a multi-select
- **Filters on the documents list:** tags (any or all), bucket, title text and type. The filter lives in the URL.
- **Writes:** hand-written mutations `setDocumentTags(documentId, tagIds)` and `bulkTagDocuments(documentIds, add, remove)`. The name check ignores case and is shared with MCP.

## MCP per bucket

- **Endpoint:** `/mcp/b/:slug`, stateless Streamable HTTP like Engrafo's `/mcp`, mounted before the static handler.
  - An unknown slug or a bucket with `mcp_enabled` off answers the same 404.
  - Every tool re-reads the bucket row per call, so switching it off takes effect on the next call (Engrafo's `loadMcpAccess` rule).
- **Auth:** an API key in `Authorization: Bearer` or `x-api-key`, never a session, and `SECURE_LOCAL_NET` does not waive it.
  - Keys are better-auth's api-key plugin with prefix `s3a_` and the plugin's rate limit off.
  - Only a session can create or revoke keys.
- **Read tools** (always on):
  - `list_documents({ tags?, match?: 'any'|'all', title?, contentType?, limit?, cursor? })`: metadata and tags, newest first
  - `list_tags()`: tags with their document count in this bucket
  - `get_document({ id })`: metadata, tags, then content by type:
    - text-like types up to `MCP_DEFAULTS.inlineTextBytes` come back as text
    - images and PDFs up to `MCP_DEFAULTS.inlineBinaryBytes` come back as embedded resources
    - anything larger comes back as metadata only, with a note
- **Write tools** (only when `mcp_writable` is on). These are what the goal runs on.
  - **Text path.** `upload_document({ filename, contentType, text, tags?, share? })`:
    - stores `text` as UTF-8, up to `MCP_DEFAULTS.inlineUploadBytes`
    - tags are named, and missing ones are created
    - returns the document, plus `shareLink { url, permission, expiresAt }` when `share` was given
  - **File path, step 1.** `create_upload({ filename, contentType, size, tags? })`:
    - inserts a `pending_upload` row
    - returns `{ documentId, uploadUrl, expiresAt, headers, curl }`
    - `uploadUrl` is a presigned PUT signed for `public_endpoint`, with the type and length in the signature, valid `MCP_DEFAULTS.uploadUrlTtlMinutes`
    - `curl` is the exact command: `curl -T <path> -H 'Content-Type: …' '<url>'`
    - the agent's machine has to reach the bucket at `public_endpoint`; no CORS is involved, because curl is not a browser
  - **File path, step 2.** `complete_upload({ documentId, share? })`:
    - heads the object and refuses a size mismatch
    - reads it once to compute `sha256` and marks the document `ready`
    - idempotent, like Engrafo's `completeDocumentUpload`
    - returns the document, plus `shareLink` when `share` was given
    - the same pending-row sweeper cleans up an upload that never completes
  - `create_share_link({ id, permission?, expiresInHours?, label? })`: for a document that already exists
  - `tag_document({ id, add?, remove? })`
  - `share` is `{ permission?, expiresInHours?, label? }`. Missing fields take the `app_settings` defaults.
  - Links made over MCP are recorded with `created_by = mcp`, so the owner sees them in Settings → Share links.
  - Every write tool's description tells the agent to give the user `shareLink.url` and its expiry. That text is how the agent learns what to do with the result.
- **Scope:** every tool is limited to documents with `bucket_id` equal to the endpoint's bucket. That is the one rule in `mcp/access.ts`, and tests cover a document in another bucket.
- **Settings → MCP:**
  - per bucket: the enabled and writable switches, a copyable endpoint URL, and a `claude mcp add --transport http <url> --header "x-api-key: …"` snippet
  - the API key list, with keys shown once at creation

## Auth and the single owner (D1)

- **Sign-in methods:** Engrafo's magic link (to the server log; `SECURE_LOCAL_NET` signs in directly) and OIDC pairing from a setup URL.
- **The owner gate:**
  - On a fresh instance, the login page says "the first account to sign in owns this instance".
  - better-auth's `databaseHooks.user.create.before` refuses a second user, so no other address can sign up through either method.
  - Refused as `FORBIDDEN` with a plain message ("this instance already has an owner").
- **Who can pair:** anyone on an empty instance, the owner after (Engrafo's rule, which already works this way).
- **Recovering a lost owner** (a lost email or provider) is a documented SQL step in the README, not a UI feature.

## Settings (UI)

`/settings` with sections, all owner-only:

| Section | Contents |
|---|---|
| Buckets | List with the default marked; add/edit dialog (preset, endpoint, public endpoint, region, bucket, access key, secret which can be replaced but not read, path-style); Test; set default; remove/forget |
| Share links | All links, with filters, copy, remove from list |
| MCP | Per-bucket switches and URLs, the client snippet |
| API keys | Create (shown once), list with last used, revoke |
| Sign-in | OIDC pairing (Engrafo's `sso-pairing`) |
| General | Max upload size, default link expiry and permission |

On a fresh instance with no bucket, the documents page shows an empty state that links to Settings → Buckets. Upload is disabled until a bucket passes its test.

## GraphQL surface

Generated reads for `buckets` (secret column excluded), `documents`, `tags`,
`document_tags`, `share_links` (`url_enc` excluded) and `app_settings`, scoped
by `user_id`. Every generated write is off, as in Engrafo. The hand-written
mutations:

- **Buckets:** `testBucket`, `createBucket`, `updateBucket`, `setBucketSecret`, `setDefaultBucket`, `setBucketMcp(enabled, writable)`, `deleteBucket(forgetDocuments)`
- **Documents:** `createDocumentUpload`, `renameDocument`, `deleteDocument` (row and object), `rekeyDocument`
- **Tags:** `createTag`, `updateTag`, `deleteTag`, `setDocumentTags`, `bulkTagDocuments`
- **Share links:** `createShareLink`, `deleteShareLink`, and `ShareLink.url` as a resolved field that decrypts for the owner's session
- **Settings:** `updateAppSettings`
- **Kept from Engrafo:** the API-key and auth/SSO mutations

Errors use Engrafo's `ErrorCode` vocabulary. A row that does not exist or does
not belong to the caller answers `NOT_FOUND`.

## Defaults (`server/src/core/defaults.ts`)

| Group | Values |
|---|---|
| `UPLOAD_DEFAULTS` | `concurrency`, `pendingTtlMinutes` (60), `sweepIntervalMinutes` (10) |
| `SHARE_LINK_DEFAULTS` | `maxExpiryHours` (168), `minExpiryHours` (1) |
| `MCP_DEFAULTS` | `inlineTextBytes` (256 KiB, read), `inlineBinaryBytes` (10 MiB, read), `inlineUploadBytes` (5 MiB, `upload_document`), `uploadUrlTtlMinutes` (15), `pageSize` (50). The `/mcp` body cap in `HTTP_DEFAULTS` must stay above `inlineUploadBytes`. `create_upload` is bounded by `app_settings.max_upload_bytes` |
| `BUCKET_DEFAULTS` | `probeKey` (`.s3-artifacts-mcp-probe`), `testTimeoutMs` (10 000), `clientCacheSize` |
| `HTTP_DEFAULTS`, `AUTH_DEFAULTS`, `OPERATION_LIMIT_DEFAULTS`, `DATABASE_DEFAULTS` | As Engrafo |

`app_settings` holds the values the owner may change. The groups above hold
the limits those values are checked against.

## Testing

- **Server:** Vitest on PGlite with an in-memory `Storage`. Covers:
  - the tenancy test
  - upload lifecycle: short, long and aborted bodies, idempotence, the sweeper
  - range downloads
  - bucket test outcomes
  - secret encryption round trip, and the behaviour after the secret changes
  - share-link signing: expiry cap, disposition per permission, link state after a re-key
  - tag name rules
  - MCP access: other bucket, disabled bucket, read-only bucket refusing writes, key vs. no key
  - the owner gate
- **Acceptance test (the goal):** against a real RustFS in CI (compose service), with an MCP SDK client on `/mcp/b/:slug` using an API key:
  1. `upload_document` with `text` and `share` → fetch `shareLink.url` with no credentials → the bytes match, and `Content-Type` and `Content-Disposition` are as asked.
  2. `create_upload` → PUT a binary file to `uploadUrl` with plain `fetch` → `complete_upload` with `share` → fetch the link → the bytes match.
  3. `rekeyDocument` → the link from step 2 answers 404.

  This is the path an in-memory `Storage` cannot prove.
- **Other integration checks** (same job): in-app stream upload and a range download.
- **Frontend:** Storybook stories as the UI tests (Engrafo's "Stories are the frontend tests"). One for every route and every domain component state: empty, loading, error, filled.
- **Gate:** `npm run check && npm test` before each step is called done.

## Build order

Each step is one or more Conventional Commits, and each ends green.

1. **Scaffold.**
   - Copy Engrafo's root tooling, `core/`, `http/`, `graphql/`, `auth/`, `sso/`, `api-keys/`, `db/` base and the app shell.
   - Rename the packages. Delete everything out of scope.
   - Add the owner gate.
   - Done when: sign-in (magic link and OIDC pairing) works, `/healthz` answers, Settings shows Sign-in and API keys.
2. **Buckets.**
   - `core/secrets.ts`, the `buckets` model, `storage/` (interface, s3, registry), presets, `testBucket`, the bucket mutations, Settings → Buckets.
   - Done when: a RustFS bucket and an AWS-style bucket can be added, tested, defaulted and removed.
3. **Documents.**
   - The `documents` model, the upload start mutation, the stream-in and stream-out routes, the sweeper, the documents list, the document page with preview, rename and delete.
   - Done when: a batch of mixed files uploads with per-file progress into a chosen bucket and previews, and shows in the sidebar tree under that bucket. A dropped folder uploads its files flat.
4. **Share links.**
   - The model, signing, `rekeyDocument`, the share dialog, the document's link list, Settings → Share links, Settings → General.
5. **MCP: the goal.**
   - `/mcp/b/:slug`, access, the write tools (`upload_document`, `create_upload`, `complete_upload`, `create_share_link`), read tools, Settings → MCP.
   - The RustFS acceptance test.
   - Done when: Claude Code, connected to one bucket, writes a markdown file and a PDF, uploads both, and hands back working share links. It cannot see another bucket.
6. **Tags.**
   - The models, the mutations, `/tags`, the picker, list filters, bulk tagging, `tag_document`, and `tags` on the upload tools.
   - Until this step, the upload tools take no `tags`.
7. **Ship.**
   - Dockerfile, `docker-compose.dev.yml` (Postgres and RustFS; no CORS setting needed, `RUSTFS_OBS_LOG_DIRECTORY` emptied as in Engrafo), `docker-compose.quickstart.yml` (pulls `ghcr.io/cubicecho/s3-artifacts-mcp:latest`), CI (check, postgres, boot, the RustFS integration job), release to GHCR only.
   - README and AGENTS.md.

## Later (not v1)

- More accounts and per-user document shares: add a `document_shares` table and widen the `documents` scope to "owner or shared".
- Share links that go through the app, for instant revocation, no 7-day cap and download counts.
- "Scan bucket" to import objects that already exist.
- Moving documents between buckets.
- API keys limited to chosen buckets.
- Link passwords.
