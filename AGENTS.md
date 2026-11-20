# AGENTS.md — s3-artifacts-mcp

## What this is

A small, self-hostable document store over S3-compatible buckets, built so that
**an agent can generate an artifact, upload it over MCP to a bucket, create a
share link and hand that link to its user.** One person owns the instance. One
monorepo (npm workspaces): `app/` (frontend), `server/` (GraphQL API, later the
upload routes and MCP), `db/` (schema and connection). One container serves all
of it.

It started as a copy of Engrafo (`apps/engrafo`), stripped to what this scope
needs. The agreed design is [`.agents/plan.md`](.agents/plan.md). Read it
before adding a feature: it has the data model, the GraphQL surface, the MCP
tools and the build order.

**Where the build is:** step 2 of the plan (buckets). Sign-in, API keys,
health, settings and buckets (Settings → Buckets) exist. Documents, share
links, MCP and tags do not yet. They are under [Planned](#planned--see-agentsplanmd) below.
Don't write code or docs as if they exist.

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
| Storage | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` (`@aws-sdk/lib-storage` arrives with uploads in step 3) |
| MCP (planned) | `@modelcontextprotocol/sdk`, stateless Streamable HTTP |
| Testing | Vitest (node on PGlite, dom), Storybook + Playwright |
| Tooling | Biome, Node 26 ESM with no server build, semantic-release, Docker (`node:26-slim`) |

Packages: `@cubicecho/s3-artifacts-mcp-app`, `@cubicecho/s3-artifacts-mcp-server`,
`@cubicecho/s3-artifacts-mcp-db`.

## Project structure

As of step 2. The folders later steps add are in the plan's "Layout".

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
│       │   └── domain/      # bucket-settings, bucket-form-dialog, bucket-test-report, sso-pairing, api-key-settings, create-api-key-dialog
│       ├── routes/          # login, verify, sso, settings (Buckets, Auth, API keys, Appearance), documents (placeholder)
│       ├── lib/             # apollo, auth, page, cn()
│       └── main.tsx         # Providers + the router
├── server/                  # GraphQL API (port 3005)
│   ├── __generated__/       # Generated SDL (not committed)
│   └── src/
│       ├── index.ts         # Boot only: preflight, wait for Postgres, migrate, createApp, listen, stop on a signal
│       ├── core/            # config, defaults, wire, errors, validation, context, preflight, limiter, preload-env, secrets
│       ├── http/            # app (createApp), health, shutdown, static, sso (the two OIDC legs)
│       ├── graphql/         # handler, build-schema, schema, tenancy, write-schema
│       ├── auth/            # better-auth (with the owner gate), auth-host, admin, rate-limit, resolvers
│       ├── sso/             # Pairing an OIDC provider from a setup URL: settings, pairing (RFC 7591/7592), resolvers
│       ├── api-keys/        # resolvers: list, make and revoke the caller's API keys
│       ├── buckets/         # presets, input (validation, slugs), test (the connection probe), sdl, resolvers
│       ├── storage/         # storage (the Storage interface), s3 (one bucket), registry (all of them)
│       └── __tests__/       # Server tests, in the same folders as src; helpers.ts at the root
├── db/
│   ├── drizzle/             # Generated migrations (committed)
│   └── src/
│       ├── models/          # auth (better-auth's tables), users, oidc-settings, buckets
│       ├── schema.ts        # Every model
│       ├── relations.ts     # defineRelations config (drives the GraphQL schema)
│       ├── defaults.ts      # DATABASE_DEFAULTS
│       ├── wait.ts          # waitForDatabase
│       ├── ssl.ts           # requiresSsl
│       └── index.ts         # The DB type, the singleton, closeDatabase
├── .agents/plan.md          # The agreed design
├── Dockerfile               # node:26-slim, no OCR packages
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
| `BETTER_AUTH_SECRET` | Signs sessions, and derives the key bucket secrets (later share URLs) are encrypted with. Rotating it makes every stored bucket secret unreadable; Settings then asks for each again. |
| `APP_URL` (optional) | Magic-link and OIDC redirect URLs. |
| `PORT` (optional) | Listening port. |
| `TRUST_PROXY` (optional) | The sign-in throttle needs it before anyone is signed in. |
| `SECURE_LOCAL_NET` (optional) | Sign-in without a link. It must not be switchable from a UI it unlocks. |
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
  excludes that column: `buckets.secret_access_key_enc` now, `share_links.url_enc`
  in step 4. Mutations that return such a row build it with drizzle-graphql's
  `resolveSelection`, so the column cannot leak through a hand-written path.

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
`SECURE_LOCAL_NET` never waives a key.

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
first. The tabs are Buckets, Auth, API keys and Appearance; the plan adds Share
links, MCP and General. Link to one with `settingsLink(tab)`. **The theme is
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
  for the server, `public_endpoint` for signing share links.
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

**`app/src/components/ui/` is vendored** from the cubeui registry and kept as
published, so `shadcn add` can update it. `biome.json` turns lint and format off
there. The cubeui shells one level up are the same.

**Images go to GHCR, and nowhere else.** The image is
`ghcr.io/cubicecho/s3-artifacts-mcp`. The release workflow has no Docker Hub
login or push, and every compose file and the README name the GHCR image. This
overrides `cubicecho_backend` → `deploy.md`, which makes Docker Hub primary.
`docker-compose.quickstart.yml` is a published artifact (the README links its
raw URL on `main`). It pulls `:latest` and never grows a `build:` key. Its
header comments are install instructions, so an env change there changes them
too.

## Planned — see .agents/plan.md

None of this exists yet. When you build a step, move its rules up into "Rules
that carry weight" and the structure tree, and delete them here.

- **Documents (step 3).** A document is created `pending_upload` before its
  bytes exist. The app's uploads and downloads stream through the server
  (`/api/documents/:id/content`), so the app needs no bucket CORS. Object keys
  are `<objectId>-<sanitized filename>` at the bucket's top level. There are no
  folders.
- **The bucket tree (step 3).** Engrafo's archive tree becomes `bucket-tree`,
  two levels (bucket → item), mounted on every signed-in page. **It starts
  collapsed:** pass `defaultOpen={[]}` to cubeui's `FileTree`, whose default is
  `"all"`. Nothing opens on its own, and expansion is not saved. A story covers
  the collapsed first render.
- **Share links (step 4).** Presigned GETs on the bucket's `public_endpoint`,
  stored encrypted. Expiry is capped at 7 days (SigV4's maximum). A single link
  cannot be revoked; `rekeyDocument` revokes them all. `app_settings` arrives
  here.
- **MCP per bucket (step 5).** `/mcp/b/:slug`, stateless Streamable HTTP, API
  key only. Read-only unless the bucket is `mcp_writable`. Every tool is scoped
  by `bucket_id` in `mcp/access.ts` and re-reads the bucket per call. The write
  tools are `upload_document` (the text path), `create_upload` → `curl -T` →
  `complete_upload` (the file path), `create_share_link` and `tag_document`. The
  acceptance test runs against a real RustFS.
- **Tags (step 6).** The owner's, unique by name ignoring case, kept in Postgres
  (not as S3 object tags).

## Stories are the frontend tests

The rules are in `cubicecho_frontend` → `testing.md`. What is particular here:

- **Stories live next to the component**, so a component and the story claiming
  it works change in the same diff. **Nothing under `components/ui/`**: cubeui
  has its own Storybook.
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
