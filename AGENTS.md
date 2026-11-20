# AGENTS.md — s3-artifacts-mcp

## What this is

A small, self-hostable document store over S3-compatible buckets, built so that
**an agent can generate an artifact, upload it over MCP to a bucket, create a
share link and hand that link to its user.** One person owns the instance. One
monorepo (npm workspaces): `app/` (frontend), `server/` (GraphQL API, the
content routes and the MCP endpoints), `db/` (schema and connection). One container serves all
of it.

It started as a copy of Engrafo (`apps/engrafo`), stripped to what this scope
needs. The agreed design is [`.agents/plan.md`](.agents/plan.md). Read it
before adding a feature: it has the data model, the GraphQL surface, the MCP
tools and the build order.

**Where the build is:** v1 is done, all seven steps of the plan. Sign-in, API
keys, health, settings, buckets, documents (upload, scan, preview, rename,
delete, the bucket tree), share links (with re-keying), `app_settings`, the
per-bucket MCP endpoints and tags exist, and step 7 shipped them: the image,
the compose files, CI with the RustFS integration job, and the release to GHCR.
What comes next is under "Later" in the plan.

## Skills to load

This file holds only what is true of this repo and easy to break. The generic
rules live in the skills (on the mcp_skills server). Load them, don't copy them
here.

| Working on | Load |
|---|---|
| Any TypeScript | `cubicecho_typescript`, then `coding-standards` with `references/preferences.md` |
| Server, schema, auth, SSO, errors, tests, Dockerfile, CI | `cubicecho_backend`, then the topic files it lists (`schema.md`, `auth.md`, `sso.md`, `errors-validation.md`, `testing.md`, `defaults.md`, `database.md`, `deploy.md`, `mcp.md`) |
| Components, pages, forms, stories | `cubicecho_frontend`, then `cubeui` before adding or updating a registry item |
| Commits, branches, releases | `cubicecho_typescript` → `git.md` |

This repo departs from `cubicecho_backend` in two places, on purpose: the
layout (D2 in the plan) and the registry (GHCR only, see "Images go to GHCR"
under [Rules that carry weight](#rules-that-carry-weight)).

## Tech stack

As Engrafo, minus OCR, pgvector and the embedding model.

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite, react-router, Apollo Client 4 |
| UI | Tailwind CSS v4, cubeui (shadcn registry), TanStack Form |
| API | graphql-yoga 5 on Express 5, drizzle-graphql generated schema + SDL extensions |
| Database | Drizzle `1.0.0-rc.5` + PostgreSQL (`postgres-js`); PGlite in tests only |
| Auth | better-auth (magic link, OIDC pairing, api-key plugin), `@cubicecho/graphql-better-auth` |
| Storage | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@aws-sdk/lib-storage` |
| MCP | `@modelcontextprotocol/sdk`, stateless Streamable HTTP, hand-written tools |
| Testing | Vitest (node on PGlite, dom), Storybook + Playwright |
| Tooling | Biome, Node 26 ESM with no server build, semantic-release, Docker (`node:26-slim`) |

Packages: `@cubicecho/s3-artifacts-mcp-app`, `@cubicecho/s3-artifacts-mcp-server`,
`@cubicecho/s3-artifacts-mcp-db`.

## Project structure

As of step 7.

```
s3-artifacts-mcp/
├── app/                     # Frontend (Vite SPA, built to app/dist)
│   ├── .storybook/          # main/preview + the Apollo mocking the stories run on
│   ├── vitest.config.ts     # The `storybook` test project (real Chromium)
│   └── src/
│       ├── __generated__/   # Generated GraphQL types (not committed)
│       ├── components/
│       │   ├── ui/          # cubeui primitives: vendored, not linted
│       │   ├── *.tsx        # cubeui shells (PageLayout, CardLayout, SidebarLayout, LoadState, …)
│       │   ├── layouts/     # app-layout (the sidebar shell around every signed-in page), require-auth
│       │   └── domain/      # bucket-tree, bucket-sidebar, upload-panel, upload-dialog, document-preview-card, document-details-card,
│       │                    #   rename-document-dialog, bucket-settings, bucket-form-dialog, bucket-secret-dialog, bucket-test-report, sso-pairing, api-key-settings,
│       │                    #   document-share-links, share-link-dialog, share-link-list, share-link-settings, link-expiry-field, general-settings, mcp-settings,
│       │                    #   document-table, document-filter-bar, document-tags-card, tag-chip, tag-picker, tag-form-dialog, bulk-tag-dialog,
│       │                    #   and the stories' mock servers (*-fixtures.ts)
│       ├── routes/          # login, verify, sso, settings (Buckets, Share links, MCP, General, Auth, API keys, Appearance), documents (/), document (/documents/:id), tags (/tags)
│       ├── lib/             # apollo, auth, library (the tree's and list's one query), document-filters, tags, upload, upload-limit, share-links, content-url, mcp, settings-tabs, page, cn()
│       └── main.tsx         # Providers + the router
├── server/                  # GraphQL API (port 3005)
│   ├── __generated__/       # Generated SDL (not committed)
│   └── src/
│       ├── index.ts         # Boot only: preflight, wait for Postgres, migrate, createApp, listen, stop on a signal
│       ├── core/            # config, defaults, wire, errors, postgres-errors, validation, context, preflight, limiter, preload-env, secrets
│       ├── http/            # app (createApp), health, shutdown, static, sso (the two OIDC legs), content (/api routes); mounts mcp/
│       ├── graphql/         # handler, build-schema, schema, tenancy, write-schema, docs, parent-id, naming
│       ├── auth/            # better-auth (with the owner gate), auth-host, admin, rate-limit, resolvers
│       ├── sso/             # Pairing an OIDC provider from a setup URL: settings, pairing (RFC 7591/7592), resolvers
│       ├── api-keys/        # resolvers: list, make and revoke the caller's API keys
│       ├── buckets/         # presets, input (validation, slugs), test (the connection probe), sdl, resolvers
│       ├── storage/         # storage (the Storage interface), s3 (one bucket), registry (all of them)
│       ├── documents/       # keys, create, scan, rekey, upload (PUT stream in), download (GET stream out), content-url, sweep, sdl, resolvers
│       ├── share-links/     # create (signing), expiry, state, sdl, resolvers
│       ├── tags/            # names (the name rules, shared with MCP), tagging (links, by id and by name), sdl, resolvers
│       ├── app-settings/    # app-settings (read, bounds, update), sdl, resolvers
│       ├── mcp/             # endpoint (/mcp/b/:slug, the key), access (the bucket scope), tools, uploads, content-types
│       └── __tests__/       # Server tests, in the same folders as src; helpers.ts at the root
├── db/
│   ├── drizzle/             # Generated migrations (committed)
│   └── src/
│       ├── models/          # auth (better-auth's tables), users, oidc-settings, buckets, documents, share-links, app-settings, tags, document-tags
│       ├── schema.ts        # Every model
│       ├── relations.ts     # defineRelations config (drives the GraphQL schema)
│       ├── defaults.ts      # DATABASE_DEFAULTS, APP_SETTINGS_DEFAULTS (the columns' defaults)
│       ├── wait.ts          # waitForDatabase
│       ├── ssl.ts           # requiresSsl
│       └── index.ts         # The DB type, the singleton, closeDatabase
├── .agents/plan.md          # The agreed design
├── .github/workflows/       # ci (check, postgres, integration, boot), release (semantic-release, GHCR)
├── Dockerfile               # node:26-slim, no OCR packages, runtime installs without dev or optional packages
├── docker-compose.dev.yml   # Postgres + RustFS for development
├── docker-compose.yml       # The whole stack, built from this checkout
└── docker-compose.quickstart.yml  # The whole stack, pulled from GHCR: what self-hosters paste
```

## Commands

```bash
npm run dev              # server (3005) + Vite dev server (3001, proxies /graphql and the OIDC routes)
npm run db:up            # Postgres on ${DEV_BIND:-127.0.0.1}:5437, RustFS on 9010 (console 9011), dev bucket `artifacts`
npm run db:down          # stop them
npm run db:generate      # new migration from a schema change
npm run db:migrate       # apply migrations
npm run codegen          # GraphQL types for both server and app
npm run check            # codegen + biome + tsc --noEmit, all three workspaces
npm test                 # Vitest: node, dom and storybook projects
npm run test:integration # the *.integration.test.ts files, against the bucket S3AM_IT_* names
npm run storybook        # Storybook on 6006
npm run build-storybook  # Static Storybook to app/storybook-static
```

`npm run check && npm test` is the gate. Run it before saying a change is done.

## Ports and environment

| What | Port |
|---|---|
| Server (API, and the app in production) | 3005 |
| Vite dev server | 3001 |
| Dev Postgres | 5437 |
| Dev RustFS API / console | 9010 / 9011 |

The ports differ from Engrafo's (3004, 3000, 5436, 9000/9001) so both run on one
machine. Change one and change it everywhere it is written: `HTTP_DEFAULTS`,
`app/vite.config.ts`, the compose files, `.env.example` and the README.

**The environment holds only what is needed before the owner can sign in, or
what is about the network.** Everything else is a setting in the UI.

| Var | Why it is in env |
|---|---|
| `DATABASE_URL` | Settings live in the database. |
| `BETTER_AUTH_SECRET` | Signs sessions, and derives the key bucket secrets and share URLs are encrypted with. Rotating it makes every stored bucket secret unreadable; Settings then asks for each again. |
| `APP_URL` (optional) | Magic-link and OIDC redirect URLs. |
| `PORT` (optional) | Listening port. |
| `TRUST_PROXY` (optional) | The sign-in throttle needs it before anyone is signed in. |
| `SECURE_LOCAL_NET` (optional) | Sign-in without a link. It must not be switchable from a UI it unlocks. |
| `EXPOSE_MAGIC_LINK` (optional) | The sign-in link in the API response in production. The same reason as `SECURE_LOCAL_NET`. |
| `DB_CONNECT_TIMEOUT_MS` (optional) | Boot, before the database answers. |

- **Don't add an env var for a setting.** A value the owner may change goes in
  the UI (from step 4, the `app_settings` row), checked against a limit in
  `core/defaults.ts`. Engrafo's `S3_*`, `MAX_UPLOAD_BYTES`, `OIDC_*` and
  `SESSION_STORE` are gone on purpose. Don't bring them back.
- **Only `core/config.ts`, `core/preflight.ts` and the db package read
  `process.env`.** Everything else asks config.
- An env var appears in `core/config.ts`, `.env.example`, the README's table and
  the compose files. Changing one means changing all four.

## How the API is built

The rules are in `cubicecho_backend` → `schema.md`. What is particular here:

- **The schema is generated from `db/src/relations.ts`, not `schema.ts`.** A
  table with no entry there gets no relation fields.
- **Names come from `typeNames` (`graphql/naming.ts`)**: plural keys are
  singularized (`documents` → `Document`), except `appSettings`, which keeps
  its name (type `AppSettings`, read `appSettings`). Every `resolveSelection`
  passes `typeNameMapper: typeNames`, so a hand-written field answers in the
  generated type's shape.
- **Every generated write is off.** `features` in `graphql/tenancy.ts` disables
  insert, update, updateMany and delete, because every write here is a step in a
  lifecycle (a document without its object is not a document). The generated
  schema then has no `Mutation` type, so `withMutationRoot` in
  `graphql/build-schema.ts` adds an empty one for the SDL extensions to extend.
  Writes are hand-written mutations in each concept's `resolvers.ts`, applied by
  `build-schema.ts`.
- **Ids are `UUID`, not `ID`.** It is the generated scalar, and hand-written SDL
  must declare it too, or a variable will not typecheck against it.
- **Tables kept out of the schema** are excluded in `build-schema.ts`:
  better-auth's (`sessions`, `accounts`, `verifications`, `apikeys`) and
  `oidc_settings`, which holds client secrets. A table with a secret column
  excludes that column: `buckets.secret_access_key_enc` and `share_links.url_enc`.
  Mutations that return such a row build it with drizzle-graphql's
  `resolveSelection`, so the column cannot leak through a hand-written path.
  (drizzle-graphql warns at codegen that generated inserts for both tables can
  never succeed. That is expected: every generated write is off.)

## Rules that carry weight

**One owner (D1).** The first account to sign in owns the instance, and every
other address is refused. The gate is better-auth's
`databaseHooks.user.create.before` in `auth/better-auth.ts`, so it holds for
magic link and OIDC alike. It refuses with `FORBIDDEN` and the message "this
instance already has an owner". That is an instance-level refusal with no row to
hide, so `FORBIDDEN` is right there. While there are no users, the login page
says "the first account to sign in owns this instance". **One owner is a gate at
sign-up, not an assumption in queries:** every user table carries `user_id` and
is scoped by it, so multi-user later is additive. Never read "the" user, and
never skip the scope because there is only one.

**Every table needs a `scope` entry.** `graphql/tenancy.ts` maps each table to
a `RowScope` that is ANDed into the SQL of every generated read. A table
missing from `scope` is visible to any caller, and nothing else in the code
will say so. `tenancy.test.ts` fails when you forget. Don't delete the test to
make it pass. Server-decided columns (`user_id`) go in `contextValues`.

**Report `NOT_FOUND`, never `FORBIDDEN`, for a row.** A row that doesn't exist
or isn't the caller's answers `NOT_FOUND`, and so does an id that is not a
UUID. `FORBIDDEN` is only for instance-level refusals: the owner gate, and
pairing SSO as anyone but the owner.

**Codes everywhere.** Every failure a client reads is a `GraphQLError` whose code
is a member of `ErrorCode` (`core/errors.ts`). Tests compare against `ErrorCode`,
not a string. Caught values are read with `errorMessage(error)`.

**Auth is better-auth, reached through GraphQL.** `createAuth(db, opts)` in
`auth/better-auth.ts` builds the instance, and it travels on the context
(`ctx.auth`). The only REST routes are the two legs of an OIDC sign-in.
Passwords are off. better-auth's own rate limiter never runs for `auth.api.*`
calls, so every sign-in mutation calls `throttle` first, keyed by client
address (`TRUST_PROXY`) and by email. Magic links go to the server log, because
there is no mail provider.

**Sessions are always in Postgres.** There is no `SESSION_STORE` and no
in-memory store, so a restart signs nobody out. Don't add a memory store back,
for speed or for tests: tests run on PGlite.

**OIDC comes only from pairing in the UI.** There are no `OIDC_*` env vars and
no `effectiveOidc` override. A setup URL (`<issuer>#setup=<token>&name=<name>`)
is pasted on the login page while there are no users, or in Settings → Auth
by the owner after that. `sso/pairing.ts` registers the app by Dynamic Client
Registration (RFC 7591) and keeps the client in `oidc_settings`. Unpairing
deletes it at the provider (RFC 7592) and forgets the row even when the provider
is unreachable. The setup token is never logged or stored. The callback ends in
a one-time token (`/auth/sso?token=…`), not a cookie. Details are in
`cubicecho_backend` → `sso.md`.

**Never hold an `Auth` from boot.** better-auth fixes its plugins when it is
created, so a pairing builds a new instance: `AuthHost` (`auth/auth-host.ts`)
holds the current one and `rebuild()` replaces it. The context takes
`authHost.current()` per request, and the SSO routes ask the host each time.

**API keys are minted only by a session.** They are better-auth's api-key
plugin, prefix `s3a_`, minted with `rateLimitEnabled: false` (the plugin's
default of ten a day starves an agent). A key cannot mint its successor, and
`SECURE_LOCAL_NET` never waives a key. A key reaches only the MCP endpoints; a
session reaches only `/graphql` and `/api`.

**`SECURE_LOCAL_NET` makes an address the whole credential.** `requestSignIn`
returns a live session for whatever address it is handed. It is for a LAN you
control, and the boot warning says so.

**The app is built in one place and booted in another.** `createApp(deps)` in
`http/app.ts` returns the Express app with nothing listening. `index.ts` is the
only file that opens a port, a connection or a signal handler. That split is
what lets `http/app.test.ts` run the real app on a random port. There is no
CORS: the server serves its own client, and Yoga's default of answering every
origin is off in `graphql/handler.ts`. Later dependencies (the storage
registry) go in through `createApp`, never as a module-level instance.

**Boot waits, shutdown drains.** `waitForDatabase` runs before `migrate`.
`stopOnSignals` stops accepting, drains, then closes the database. `/healthz`
answers `{ ok, version }`, and 503 while Postgres is unreachable. The image's
healthcheck reads it.

**`import './core/preflight.ts';` stays first in `server/src/index.ts`,**
followed by a blank line so Biome's import sort leaves it there. It must run
before `@cubicecho/s3-artifacts-mcp-db` is imported.

**Tunables live in `core/defaults.ts`** (`db/src/defaults.ts` for
`DATABASE_DEFAULTS`), as `<CONCEPT>_DEFAULTS` groups with the unit in the
member name. No module states a tunable of its own. The shape is in
`cubicecho_typescript` → "Defaults".

**Every log line says where it came from**: `[server]`, `[db]`, `[auth]`,
`[sso]`, `[preflight]`. No emoji. Never log secrets or setup tokens. The magic
link is logged on its one line, and nowhere else.

**`UNAUTHENTICATED` means the session expired.** The client drops its token on
it and goes to `/login`. A bad magic link is `BAD_USER_INPUT`, which must not
sign anyone out.

**An empty state means the server said "none", never that we failed to ask.**
`LoadState` takes the failure rung before the empty one.

**The browser is not in a secure context.** A self-hosted instance is reached
over plain HTTP at a LAN address, so `crypto.randomUUID`, `crypto.subtle` and
`navigator.clipboard` are undefined there. Use `clientId()` in place of
`crypto.randomUUID()`, and feature-check the rest. Dev never catches this,
because Vite serves on `localhost`.

**The chrome is cubeui's chrome.** That means `SidebarLayout` with a `Sidebar`,
the palette from `app/cubeui-tokens.css`, and the registry's components for
everything a page is made of. A change to how the shell looks is a change
upstream. Write cubeui the way cubeui is written:

- No `children` on its components. Nodes go in `*Slot` props, and words in
  `title`, `description`, `label` and `content`.
- An icon-only button has an `aria-label`.
- A destructive action is a `ConfirmButton` whose description says what is lost.
- Forms are TanStack Form through `useAppForm`. A `form.SubmitButton` outside
  its `<form>` submits by itself, so don't add an `onClick` that submits again.
- Colours are cubeui's token names. "Muted" is an opacity (`text-foreground/60`).

**The shell owns the sidebar; pages own their headers.** `AppLayout` wraps
everything inside `RequireAuth`, so "signed in" and "has the sidebar" cannot
drift apart. `/login`, `/auth/verify` and `/auth/sso` are a
`CenteredCardLayout` each. Adding a screen means a route in `main.tsx` and an
entry in `NAV_ITEMS`. Two things are easy to break:

- `h-svh`, and `min-h-0` on every flex ancestor between the shell and the page.
  Without them `PageLayout`'s body grows instead of scrolling.
- The theme is applied by the inline script in `index.html` (cubeui's
  `THEME_PRE_PAINT_SCRIPT`), not in React. Done in React, dark mode flashes
  white on every load.

**`PageLayout width="full"` pads nothing.** cubeui's chassis puts `px-4` on the
body only with the `page` and `prose` columns, so every full-width page passes
`FULL_WIDTH_BODY` (`lib/page.ts`) in `contentClassName`.

**Settings sections are tabs in the query string** (`?tab=`), a `Link` per tab,
so a section can be linked and survives a reload. An unknown tab opens the
first. The tabs are Buckets, Share links, MCP, General, Auth, API keys and
Appearance, defined in `lib/settings-tabs.ts` (not the route, so a component the
route renders can link to a tab). Link to one with `settingsLink(tab)`. **The theme is
chosen only on Appearance** (the card picker); the sidebar, the bar and page
headers carry no theme picker. The sign-in pages keep their compact one, since
nobody signed out can reach Settings.

**Buckets are rows, each with its own connection.** One instance mixes
accounts and providers (AWS S3, MinIO, RustFS, Backblaze B2 side by side).
Providers are only presets (`buckets/presets.ts`) that fill the form; there is
no Cloudflare R2 preset. Rules that are easy to break:

- **Secrets are sealed** by `core/secrets.ts` (AES-256-GCM, key from
  `BETTER_AUTH_SECRET` by HKDF, a purpose bound in as AAD) and never returned.
  A secret that no longer opens is `Bucket.secretReadable: false`, not a crash.
- **The `StorageRegistry` caches by bucket id only**, never by provider or
  endpoint, and every bucket write calls `invalidate`. It is injected through
  `createApp` and read from the context, so tests hand in the in-memory backend
  (`__tests__/memory-storage.ts`).
- **Two clients per bucket**, because a signature covers the host: `endpoint`
  for the server, `public_endpoint` for signing share links and MCP upload URLs.
- **Clients send checksums only when required**
  (`requestChecksumCalculation` / `responseChecksumValidation` =
  `WHEN_REQUIRED`). The SDK's default flexible checksums are refused by B2 and
  older MinIO. For the same reason a single-key delete is `DeleteObject`, not
  `DeleteObjects`.
- **`testBucket` runs before every save** that changes the connection: head
  bucket, put, get, share link (presign on `public_endpoint` and fetch), delete.
  A failure before the share link refuses the save with `BAD_USER_INPUT` and
  `extensions { reason, step, errorCode }`. The share-link step is only a
  warning. The delete always runs once the put passed, so a probe is never left
  behind.
- **Slugs are unique across the instance**, because they name the MCP endpoint.
  A taken slug is `CONFLICT`, including when two saves race for it.
- **There is no default bucket.** Every upload names its bucket: an MCP
  client by its endpoint (`/mcp/b/:slug`), the app by the bucket the owner
  picks. Don't add one back to save the app a choice; the upload panel
  preselects instead (the bucket open in the tree, the only one, or the last
  used, remembered in the browser).

**A document is `pending_upload` until its bytes are in the bucket.**
`createDocumentUpload` makes the row; `PUT /api/documents/:id/content` streams
the body through lib-storage, counting and hashing it, and only a body of
exactly the declared size becomes `ready` (sha256 set, in one transaction
guarded on `pending_upload`). Any other ending (short, long, storage failure,
client gone) aborts the multipart upload and deletes the object and the row.
The sweeper (`documents/sweep.ts`, started only in `index.ts`) drops pending
rows idle past `UPLOAD_DEFAULTS.pendingTtlMinutes`, and any object at their
key, which is also how an MCP `create_upload` that never completes is cleaned
up. Making a row ready is `markReady` and restarting its sweep clock is
`claimPending` (`documents/rows.ts`), for the PUT route and MCP alike. Lists show `ready` only.
Object keys are `<uuid>-<ascii filename>` at the bucket's top level. The size
limit is the owner's `app_settings.max_upload_bytes`, read by both
`createDocumentUpload` and the PUT (a limit lowered in between refuses the PUT
with 413), and never past `UPLOAD_DEFAULTS.maxUploadBytes` (50 GiB, bounded by
lib-storage's 10,000 parts of `partSizeBytes`). The upload panel reads the
limit from the server (`lib/upload-limit.ts`); don't write a number into the
app.

**`app_settings` is one row per account, keyed and scoped by `user_id`.** It is
"the instance's settings" only because there is one owner; it has a `scope`
entry and a `contextValues.userId` like any table, so the tenancy test covers
it and a second account would get its own. better-auth's `user.create.after`
makes the row (`ensureAppSettings`), a migration made one for every account
that predates the table, and `readAppSettings` makes it if it is somehow gone,
so no path depends on the hook. Its columns' defaults are
`APP_SETTINGS_DEFAULTS` in `db/src/defaults.ts`; the bounds every value is
checked against are in `core/defaults.ts` (`UPLOAD_DEFAULTS.min/maxUploadBytes`,
`SHARE_LINK_DEFAULTS.min/maxExpiryHours`) and reach the app through
`appSettingsLimits`. A new setting is a column, a bound in a defaults group,
and a field on `updateAppSettings`, never an env var. The cache keys
`AppSettings` by `userId` (`TYPE_POLICIES` in `lib/apollo.ts`), so select it.

**Share links are presigned GETs on the bucket's `public_endpoint` (D5), and
the bucket, not this database, decides whether one opens.**

- `createShareLink` (`share-links/create.ts`, shared with MCP through its
  `createdBy`) signs with `Storage.presignGet`: `inline` for `view`,
  `attachment` with the filename for `download`, and the document's content
  type. Only a `ready` document (CONFLICT otherwise). A permission or expiry
  left out takes the owner's `app_settings` default. The expiry is a whole
  number of hours from `SHARE_LINK_DEFAULTS.minExpiryHours` to
  `maxExpiryHours` (168, SigV4's limit): BAD_USER_INPUT otherwise. There is no
  "never".
- The URL is sealed with `SecretPurpose.ShareLinkUrl` and read back only by
  `ShareLink.url` for the owner, which answers null (not an error) once
  `BETTER_AUTH_SECRET` has changed.
- `ShareLink.state` is worked out, never stored: **revoked** when the link's
  `object_key` is no longer the document's, else **expired** past
  `expires_at`, else **active**. Revoked wins, so a revoked link never turns
  "expired" later.
- `deleteShareLink` removes the row only. The URL keeps working until it
  expires, and the UI calls it "Remove from list" and says so.
- **`rekeyDocument` is the only revocation.** Its order matters
  (`documents/rekey.ts`): copy to `objectKeyFor(newUuid, filename)`, then move
  the row (guarded on the old key, so a racing re-key or delete answers
  CONFLICT and the copy is deleted), then delete the old object. Copy first so
  the row never names an empty key; the delete last. If the bucket refuses that
  delete the old links still work, so the move is undone (row back to the old
  key, copy deleted) and STORAGE_ERROR says nothing was revoked: a link shown as
  revoked must really be dead. A scanned file leaves the owner's key for an
  app-made one, and the confirm says so. Copies past `COPY_DEFAULTS.maxSingleCopyBytes`
  (CopyObject's 5 GiB) go in parts.
- Rotating a bucket's access key kills every link signed with it; the bucket
  form warns when the key changes on edit.

**A scan makes the files already in a bucket documents, where they are.**
`scanBucket` (`documents/scan.ts`) lists the bucket a page at a time and adds
a `ready` row for each key no document has: filename is the key's last
segment, title the key without its extension, type guessed by `mrmime`, no
sha256. It never reads, moves or renames an object. Folder markers (`…/`) and
the bucket test's probe are passed over; a key with control characters or a
too-long name is skipped and reported. The unique `(bucket_id, object_key)`
index with `ON CONFLICT DO NOTHING` makes a repeat or a racing scan add
nothing twice. One scan adds at most `SCAN_DEFAULTS.maxImports`, then says
`truncated`; the next carries on. A key with a `/` in it is still shown flat
(D11). Deleting a scanned document deletes the owner's object, as for any
document.

**MCP is one endpoint per bucket, `/mcp/b/:slug`** (`mcp/`), stateless
Streamable HTTP with a server per request, as Engrafo's `/mcp`. Rules that are
easy to break:

- **The key first, then the bucket.** `endpoint.ts` reads an `s3a_` key from
  `x-api-key` or `Authorization: Bearer` and nothing else: not a cookie, not a
  session token, and `SECURE_LOCAL_NET` never waives it. Without a valid key
  every request is 401, so a stranger learns nothing about slugs. With one, an
  unknown slug, another owner's bucket and a bucket with `mcp_enabled` off all
  answer the same 404.
- **One scope rule.** Every document an MCP tool reads goes through
  `inBucket` in `mcp/access.ts` (the key owner's rows in the endpoint's
  bucket). A document elsewhere answers the same `NO_SUCH_DOCUMENT` as a missing
  one. Add a query there, never beside it.
- **Every tool re-reads the bucket row** (`currentBucket`), so switching MCP off
  or making it read-only holds from the next call. Write tools are registered
  only when the bucket is `mcp_writable` as the request arrives, and each still
  calls `requireWritable`. `setBucketMcp` refuses writable while off.
- **A tool failure is a result** (`isError` with a message the model can act
  on), never a transport error. Results are JSON, as text and as
  `structuredContent`.
- **Uploads reuse the app's lifecycle.** `upload_document` and `create_upload`
  make the row with `createPendingDocument` (so the owner's upload limit holds);
  `create_upload` also caps at `MCP_DEFAULTS.maxPresignedPutBytes` (one PUT, 5
  GiB). The presigned PUT (`Storage.presignPut`) is signed for
  `public_endpoint` with `content-type` and `content-length` in the signature;
  the presigner leaves them unsigned unless told. `complete_upload` heads the
  object, refuses (and removes) a size mismatch, hashes it once and calls
  `markReady`; on a ready document it answers it again.
- **Tags are named, not picked.** `upload_document` and `create_upload` take
  `tags`, and `tag_document` (a write tool) `add` and `remove`, all by name,
  matched ignoring case; a name the owner has no tag for is made
  (`ensureTagsNamed`, which finds rather than refuses a name made alongside). The
  names are checked before anything is stored. `list_documents` filters by
  `tags` with `match: 'any' | 'all'`, `list_tags` answers the tags on a
  document in this bucket and the ones on no document at all, with how many ready
  documents here carry each; a tag used only in other buckets is left out, so an
  endpoint never learns about a bucket it cannot see, and every document a tool answers carries `tags`. The tag
  reads are in `access.ts`, under `inBucket`, like every other.
- **Text uploaded inline is stored as UTF-8**, so a text type with no charset
  gets `; charset=utf-8` (`mcp/content-types.ts`).
- **Links come from `createShareLink`** with `ShareLinkCreator.Mcp`; a `share`
  that leaves a field out takes the `app_settings` default. Every write tool's
  description tells the agent to hand over `shareLink.url` and its expiry; that
  text is how an agent learns to.
- **The limits move together**: `HTTP_DEFAULTS.mcpBodyLimitBytes` stays above
  `MCP_DEFAULTS.inlineUploadBytes` (with room for JSON escaping), and
  `uploadUrlTtlMinutes` below `UPLOAD_DEFAULTS.pendingTtlMinutes`, so nothing
  reaches a key after its row was swept. A test checks both.
- **The acceptance test** (`__tests__/mcp/mcp.integration.test.ts`) is the goal
  against a real RustFS: upload with tags and a share, list by those tags, open
  the link with no credentials, a binary file through `create_upload`, a plain `fetch` PUT and
  `complete_upload`, then a re-key and a 404. It is skipped unless
  `S3AM_IT_ENDPOINT` is set, and deletes every object it makes. CI's
  `integration` job runs it (see "CI proves the real bucket" below).
- Settings → MCP (`mcp-settings`) shows each bucket's switches, its endpoint
  from the browser's origin (`lib/mcp.ts`, kept in step with `MCP_ROUTE` by
  hand) and a `claude mcp add --transport http <slug> <url> --header "x-api-key:
  …"` command. `--header` is variadic, so it stays after the name and URL. Vite
  proxies `/mcp` in dev.

**Tags are the owner's (D8), kept in Postgres, never as S3 object tags (D11).**
`tags` holds the name and a `#rrggbb` colour; `document_tags` links a tag to a
document and carries the owner's `user_id` like every table, so both have a
`scope` entry. Rules that are easy to break:

- **The name rules live in `tags/names.ts`, for GraphQL and MCP alike.** A name
  is trimmed, at most `TAG_DEFAULTS.nameMaxLength`, and unique to its owner
  ignoring case: the unique index is `(user_id, lower(name))`. A taken name is
  `CONFLICT`, from the check or, when two saves race, from the index
  (`isUniqueViolation`, `core/postgres-errors.ts`). A tag may change the case of
  its own name. A tag made with no colour gets one of `TAG_DEFAULTS.palette`,
  picked by its name. Don't check a name anywhere else.
- **Links go with either side.** Both foreign keys cascade: deleting a tag
  takes it off every document (the confirm says how many), and deleting a
  document, or forgetting a bucket's, takes its links.
- **Another user's tag or document is `NOT_FOUND`, and nothing changes.**
  `setDocumentTags` and `bulkTagDocuments` check every id first
  (`ownTagIds`, `ownDocumentIds` in `tags/tagging.ts`) and write in one
  transaction. A tag in both `add` and `remove` is `BAD_USER_INPUT`.
- **Counts are generated.** `Tag.documentsAggregate(where: { status: { eq: ready } })`
  is how many documents carry a tag, through the `.through()` relation.
  drizzle-graphql 16 builds broken SQL for a relation *filter* through it
  (`documents(where: { tags: … })`), so nothing filters that way: the documents
  list filters the tags the `Library` query already has.
- **The documents list's filters are the URL** (`lib/document-filters.ts`):
  `?bucket=<slug>&tags=<id>,<id>&match=all&q=<title>&type=<content type>`. A
  filter back at "everything" leaves the URL, and an id or slug that names
  nothing filters nothing. A tag's row on `/tags` links to the list filtered to
  it (`tagDocumentsPath`).
- **Every tag edit is a form in a dialog** (`tag-form-dialog`); the picker
  (`tag-picker`, a `Combobox multiple`) is the only place a tag is made without
  one, by typing a name no tag has. A document's picker shows a pick at once and
  saves one change after another, so a second pick never undoes the first.
- **Colours go through the colour helpers.** A chip is `Badge` with the tag's
  colour and `readableTextColor` for its ink; a dot is `ColorDot`. Never a
  palette class.
- A tagging mutation answers the documents with their `tags { ...TagFields }`,
  which updates them in the cache everywhere; it refetches `TAG_QUERIES` for the
  counts. A tag renamed, recoloured or deleted refetches `LIBRARY_QUERIES` too.

**The content routes are same-origin and must stay safe as such.**
`/api/documents/:id/content` is served from the app's own origin, so an
uploaded file could otherwise run script as the app:

- `PUT` takes only a session bearer header (no cookies, no API keys). `GET`
  takes the bearer header or a `?t=` from `Document.contentUrl`, because
  `<img>`, `<iframe>` and `<video>` cannot send headers. `t` is an HMAC over
  id, object key, download flag and expiry (15 minutes), keyed by HKDF from
  `BETTER_AUTH_SECRET`. Any bad, stale or foreign token is 404, never 401/403.
- Every response has `nosniff`; everything but passive inline types (non-SVG
  images, audio, video, PDF, plain text) gets `Content-Security-Policy:
  sandbox`. Don't widen that list. The app never renders uploaded HTML.
- No CORS headers on `/api`, ever.

**A field added to a generated type needs `id` in the query.** drizzle-graphql
adds the primary key only when a query names no column, so `Bucket.secretReadable`
and `Document.contentUrl` read it through `parentIdOf` (`graphql/parent-id.ts`),
which answers BAD_USER_INPUT, not NOT_FOUND, when it is missing. Use it for any
new added field, and always select `id` in the app.

**The bucket tree starts collapsed and stays the owner's.** `bucket-tree` passes
`defaultOpen={[]}` to cubeui's `FileTree` (whose default is `"all"`). Nothing
opens a bucket but a press: not a reload, an upload, or a document page. A
bucket the owner opened stays open through a refetch. Expansion is not saved.
Stories cover all three. The tree and the documents list share the `Library`
query; anything that adds or removes a bucket or document refetches it
(`LIBRARY_QUERIES`).

**`app/src/components/ui/` is vendored** from the cubeui registry and kept as
published, so `shadcn add` can update it. `biome.json` turns lint and format off
there. The cubeui shells one level up are the same.

**Images go to GHCR, and nowhere else.** The image is
`ghcr.io/cubicecho/s3-artifacts-mcp`. The release workflow has no Docker Hub
login or push, and every compose file and the README name the GHCR image. This
overrides `cubicecho_backend` → `deploy.md`, which makes Docker Hub primary.
`docker-compose.quickstart.yml` is a published artifact (the README links its
raw URL on `main`). It pulls `:${S3AM_VERSION:-latest}` and never grows a
`build:` key. Its header comments are install instructions, and the README's
Quickstart walks the same steps, so an env change there changes both.

**CI proves the real bucket, and refuses to skip it.** The `integration` job
starts `docker-compose.dev.yml`'s RustFS (`up -d rustfs`, then
`run --rm rustfs-init` for the bucket), sets the `S3AM_IT_*` variables to it
and runs `npm run test:integration` with Vitest's JSON reporter. A suite with no
`S3AM_IT_ENDPOINT` skips itself and passes, so the next step fails the job
unless every `server/src/__tests__/**/*.integration.test.ts` file ran and every
test in it passed, none skipped or todo. A new integration file only has to
match that name; it needs a real bucket to have run, never an in-memory one.

**The runtime image installs with `--omit=dev --omit=optional`.** better-auth
and drizzle-orm name vitest, drizzle-kit, PGlite and React as optional peers,
which npm marks `devOptional` and keeps unless both kinds are omitted: about
200 MB of build tools. The only optional-only packages in the lockfile are
esbuild's, rolldown's and lightningcss's platform binaries. A runtime
dependency that needs an optional package would lose it here: check the
lockfile before adding one, and `docker run --rm --entrypoint ls <image>
node_modules` after.

## Later — see .agents/plan.md

v1 is built. What it leaves out on purpose (more accounts, links through the
app, moving documents, keys limited to buckets, link passwords) is listed under
"Later" in the plan. When you build one, move its rules up into "Rules that
carry weight" and the structure tree.

## Stories are the frontend tests

The rules are in `cubicecho_frontend` → `testing.md`. What is particular here:

- **Stories live next to the component**, so a component and the story claiming
  it works change in the same diff. **Nothing under `components/ui/`**: cubeui
  has its own Storybook.
- **Mock servers live in `components/domain/*-fixtures.ts`**: `bucketServer`
  (its `mcpCalls` records `setBucketMcp`),
  `documentServer`, `shareLinkServer`, `sharingServer` (documents and
  links over one list, so a re-key moves the document the page shows),
  `tagServer` (tags over another server's documents, whose `tags` are its own
  objects, so a rename shows on every document) and `taggingServer` (documents
  and tags together). `mergeResolvers` lays one over another. Every document
  fixture has `tags`, since `Library` asks for them.
- **There are two ways to give a story a server**, under
  `parameters.apolloClient` (`app/.storybook/graphql.tsx`). `mocks` is Apollo's
  `MockedProvider`, for when the request is the subject. `resolvers` is a
  `graphql-mocks` server over `app/src/__generated__/schema.graphql`, for when
  the page is the subject, and it is the one that catches schema drift. Every
  story gets a fresh `ApolloProvider`.
- **Accessibility failures are test failures**: `a11y: { test: 'error' }`.
- **Three vitest projects, and the order matters.** `node` (PGlite) and `dom`
  (jsdom) are `groupOrder: 0`. `storybook` (Chromium) is `groupOrder: 1` with
  `fileParallelism: false`, so it runs last and alone. Run alongside the
  browser, PGlite times out in a `beforeEach`, which is the wrong place to look.
- Every route and every domain component state (empty, loading, error, filled)
  has a story.
- **A story leaves no Radix menu, select or dialog open.** One left open keeps
  `aria-hidden` on the rest of the page for the stories after it: close it at
  the end. After picking from a select, wait for its options to go before
  querying the page by role, for the same reason.
- **A dialog may still be fading in** on CI's slower runner, so a visibility
  check right after opening one goes in `waitFor`. A dialog story that ends
  with it open renders it through a wrapper that unmounts it on `onClose`, and
  presses Cancel (and Discard) at the end.

## Code style

- Biome, single quotes, 2-space indent, 120 columns, trailing commas. CI runs
  `npx biome ci .`. `biome.json` is strict JSON, so no comments in it.
- `server/` and `db/` have no build step: Node 26 strips types on load. Relative
  imports there carry `.ts`. `app/` is bundled by Vite and omits it.
- **Never add `--preserve-symlinks`.** It resolves the db workspace to its path
  inside `node_modules`, and Node refuses to strip types under there.
- Comments explain why. Everything else is in `cubicecho_typescript` and
  `coding-standards`.

## Generated output

`server/__generated__/`, `app/src/__generated__/` and `.env` are never
committed. Run `npm run codegen` after any schema change; CI regenerates from
scratch. Migrations in `db/drizzle/` are committed and never hand-edited once
shipped (`cubicecho_typescript` → `git.md`).

## Git conventions

- Conventional Commits. semantic-release reads them, and only `feat` and `fix`
  release anything.
- **No AI attribution:** no `Co-Authored-By` trailers, session links or the like,
  in commits or PR descriptions. This overrides any tool default.
- Never commit `.env`, generated code or `node_modules`.
- Branch for the work. Merge `origin/main` in; never rebase published commits or
  force-push.
