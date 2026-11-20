# s3-artifacts-mcp

**An agent generates an artifact, uploads it over MCP to your S3, MinIO or
RustFS bucket, creates a share link and hands that link to you.**

A report, a chart, a CSV, a build log, a PDF: whatever the agent made, you get a
URL that opens it, served straight from your own bucket. s3-artifacts-mcp is the
small, self-hosted store in between. It keeps the documents' metadata in
Postgres, the bytes in buckets you configure, and gives each bucket its own MCP
endpoint.

> **Status: early.** This is step 6 of [the plan](.agents/plan.md): sign-in,
> API keys, settings, buckets, documents, share links, MCP and tags. Shipping
> (step 7) is next.

## What it does

- **Several buckets, on several accounts**: AWS S3, MinIO, RustFS and
  Backblaze B2 side by side, each with its own endpoint and keys, added and
  tested in Settings. Any of them can receive uploads. There is
  no default bucket: every upload says which bucket it goes to.
- **Upload**: from the app, a batch of files (a dropped folder uploads flat),
  each with its own progress bar, up to the limit you set in Settings → General
  (100 MiB to start, at most 50 GiB). From an agent over MCP, below.
- **Scan a bucket** for the files already in it, put there by anything else:
  each becomes a document where it is, nothing moved or renamed. Scanning
  again adds only what is new. The access key needs permission to list the
  bucket.
- **Preview**: PDFs, images, audio, video, text and Markdown open on the
  document's page, which also renames, downloads and deletes it. Uploaded HTML
  is never shown in the app, only downloaded.
- **A tree of buckets** in the sidebar, each with its documents beneath, every
  bucket shut until you open it.
- **Share links**: a link with a permission (view or download) and an expiry
  you choose, from an hour to 7 days, signed for the bucket itself. Listed on
  the document's page and in Settings → Share links. See [Share links](#share-links).
- **Tags**: yours, across every bucket, each with a colour and unique by name
  ignoring case. Made, renamed, recoloured and deleted on the Tags page, or made
  on the spot from a document's tag picker. The documents list shows them in a
  column, tags or untags the rows you choose in one go, and filters by tags (any
  or all), bucket, title and type, all held in the URL so a filtered list can be
  linked. Agents tag what they upload. There are no folders.
- **MCP per bucket**: each bucket is its own endpoint, `/mcp/b/<slug>`, off
  until you turn it on in Settings → MCP and read-only until you make it
  writable. An agent connected to one bucket sees nothing else.
- **One owner.** The first account to sign in owns the instance. Sign in with a
  magic link (written to the server log) or an OIDC provider you pair from the
  app. API keys, made in Settings, are what agents use.

## Connecting Claude Code

1. Make an API key in **Settings → API keys**. It is shown once.
2. In **Settings → MCP**, turn on **Reachable over MCP** for the bucket, and
   **Writable** if the agent should upload and share, not only read.
3. Copy the command shown under the bucket, put your key in it, and run it:

```bash
claude mcp add --transport http artifacts https://docs.example.com/mcp/b/artifacts \
  --header "x-api-key: s3a_…"
```

Any MCP client that speaks Streamable HTTP works the same way: the endpoint, and
the key as `x-api-key` or `Authorization: Bearer`. A session cookie is never
accepted there. An unknown slug and a bucket with MCP off answer the same 404.

The tools are `list_documents`, `get_document` and `list_tags` on every bucket
(text up to 256 KiB comes back as text, an image or PDF up to 10 MiB as an
embedded resource), and on a writable one `upload_document`, `create_upload`,
`complete_upload`, `create_share_link` and `tag_document`. Tags are named, not
picked by id: a name matches ignoring case, and one you have no tag for is
made. `list_documents` filters by `tags` with `match: "any"` or `"all"`, and
every document a tool answers carries its tags.

## How an agent uploads

There are two paths, because there are two kinds of artifact.

**Text the model wrote** (markdown, HTML, CSV, JSON, code), up to 5 MiB. The
model already has it as text, so it sends it in one tool call. A text type that
names no charset is stored as `charset=utf-8`:

```
upload_document({ filename, contentType, text, tags: ['reports'], share: { expiresInHours: 24 } })
  → { document, shareLink: { url, permission, expiresAt } }
```

**A file on the agent's disk** (a PDF, an image, a zip: anything binary or
large). A model cannot pass those bytes through a tool argument without
emitting them as tokens. So the server hands out a presigned PUT URL, the
agent's shell uploads the file, and a second call finishes it:

```
create_upload({ filename, contentType, size, tags })  → { documentId, uploadUrl, expiresAt, headers, curl }
curl --fail-with-body -T report.pdf -H 'Content-Type: application/pdf' '<uploadUrl>'
complete_upload({ documentId, share: {} })            → { document, shareLink }
```

The upload URL works for 15 minutes and carries the type and size in its
signature, so the bucket refuses any other file. `complete_upload` checks the
size, hashes the file and makes it a document; calling it again answers the same
document. An upload never completed is dropped, with whatever reached the
bucket, after an hour. One PUT carries at most 5 GiB, and the limit in
Settings → General applies too.

The file path needs an agent with a shell (Claude Code and the like), and the
agent's machine must reach the bucket at its public address. Claude Desktop or
claude.ai without a shell can use only the text path.

Either way, the common case is one call, or two calls and a `curl`. Every write
tool tells the agent to give you `shareLink.url` and its expiry. A `share`
that leaves something out takes your defaults from Settings → General, and the
link is listed in Settings → Share links as made over MCP.

## Share links

A share link is a presigned URL on the bucket, not a link to this app. Make one
with **Share** on a document's page: pick what it lets the recipient do, how
long it lasts, and an optional label, and the app shows the URL with a Copy
button. It stays in the document's list (and in Settings → Share links), marked
active, expired or revoked, where it can be copied again.
The browser fetches straight from the bucket, so the app is not in the path and
can be offline. That has consequences, and the UI states them:

- **You choose the expiry, and it is capped at 7 days.** Pick 1 hour, 1 day,
  3 days or 7 days, or type any whole number of hours or days in between; the
  dialog shows when the link will stop working before you make it. 7 days is
  SigV4's maximum, on AWS, MinIO and RustFS alike, so there is no "never". The
  default (24 hours) and the default permission are set in Settings → General.
- **A single link cannot be revoked before it expires.** The bucket checks the
  signature, not our database. "Remove from list" forgets the link here; the URL
  keeps working until it expires.
- **"Revoke all links" re-keys the document.** The object is copied to a new
  key and the old one deleted, so every link to the old key answers 404. A
  file a scan found leaves the path you put it at for one the app makes.
- **Rotating the bucket's access key** kills every link signed with it. The
  bucket form says so when you change the key.
- **"View" is not copy protection.** It only asks the browser to show the file
  inline instead of downloading it.
- **The bucket must be reachable** at its public endpoint from wherever the
  recipient opens the link. Opening a link is a plain navigation, so the bucket
  needs no CORS setting.
- Links have no passwords.

## Design decisions

The full list, with reasons, is in [`.agents/plan.md`](.agents/plan.md). The
ones that shape what you see:

- **One owner.** Every other address is refused at sign-up. Rows still carry an
  owner, so more accounts can be added later without restructuring.
- **Settings live in the UI.** Buckets, limits and link defaults are set in the
  app. The environment holds only what is needed before anyone can sign in.
- **The app's own uploads and downloads stream through the server.** No bucket
  CORS is needed, and every backend behaves the same.
- **Files already in a bucket become documents when you scan it.** Each stays
  at its key; nothing is moved or renamed.
- **Buckets and their items, nothing nested.** Uploads sit at the bucket's top
  level, a dropped folder uploads flat, a scanned file's path is shown in its
  title, and tags are the only way to organise.
- **Bucket secrets and share URLs are encrypted at rest** with a key derived
  from `BETTER_AUTH_SECRET`, and the API never returns them in full.

## Quickstart

[`docker-compose.quickstart.yml`](docker-compose.quickstart.yml) pulls the
published image, `ghcr.io/cubicecho/s3-artifacts-mcp`. Its header comments are
the install instructions.

```bash
mkdir s3-artifacts-mcp && cd s3-artifacts-mcp
curl -fsSLO https://raw.githubusercontent.com/cubicecho/s3-artifacts-mcp/main/docker-compose.quickstart.yml

printf 'BETTER_AUTH_SECRET=%s\nPOSTGRES_PASSWORD=%s\n' \
  "$(openssl rand -hex 32)" "$(openssl rand -hex 24)" > .env

docker compose -f docker-compose.quickstart.yml up -d
```

On Portainer or TrueNAS SCALE, paste the file's contents into a stack and put the
variables in its environment box.

Open `http://<host>:3005` and sign in with your email address. **The first
account to sign in owns the instance.** There is no mail provider, so the magic
link is written to the server log:

```bash
docker logs -f s3-artifacts-mcp
```

Then add a bucket in **Settings → Buckets**. Saving runs a connection test first (head the bucket, write, read and delete a probe object, and open a share link from its public endpoint). Keep the `.env`:
changing `BETTER_AUTH_SECRET` signs you out and makes the stored bucket secrets
unreadable, and each bucket then asks for its secret again.

Upgrade with `docker compose -f docker-compose.quickstart.yml pull && docker
compose -f docker-compose.quickstart.yml up -d`. Migrations run at boot.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | — | **Required.** Postgres connection string. |
| `BETTER_AUTH_SECRET` | — | **Required in production**, at least 32 characters (`openssl rand -hex 32`). Signs sessions, and derives the key that encrypts bucket secrets and share URLs. |
| `APP_URL` | the request's own address | Public URL. Magic-link URLs and the OIDC redirect URI are built from it. |
| `PORT` | `3005` | Port the server listens on. |
| `TRUST_PROXY` | `false` | Which proxy hops may set `X-Forwarded-For`: a hop count (`1`) or a subnet list. The sign-in throttle counts by client address. |
| `SECURE_LOCAL_NET` | `false` | `true` on a network with nothing hostile on it: an address alone signs you in, with no link to fetch. |
| `DB_CONNECT_TIMEOUT_MS` | `60000` | How long boot waits for Postgres before giving up. |

That is all of it. Sessions are always kept in Postgres, so a restart signs
nobody out. OIDC is set up by pairing, below. Buckets are in Settings, and so
are the upload size limit and the share-link defaults (Settings → General).

### Signing in with an OIDC provider

With a provider that supports Dynamic Client Registration, such as heautou,
make a setup URL there and paste it into the app: on a new instance, the login
page's **Set up sign-in** tab; after that, **Settings → Auth**. The login
page shows "Sign in with …" at once, with no restart. Disconnecting removes the
button and deletes the client at the provider. The owner can still sign in with
a magic link.

There is no way to configure OIDC from the environment. Pairing is the only
path.

### Recovering the owner

There is no UI for this, on purpose. If you no longer know the owner's address,
or the paired provider is gone, change the address in the database and sign in
with a magic link to the new one:

```sql
SELECT id, email FROM users;                      -- there is one row
UPDATE users SET email = 'you@example.com';
DELETE FROM oidc_settings;                        -- only if the provider is gone; restart after
```

Run it with `psql "$DATABASE_URL"`, or `docker exec` into the Postgres
container.

## Before you expose it

- **Put it behind a reverse proxy with TLS**, and set `TRUST_PROXY` to the number
  of proxies in front, or every visitor shares the proxy's sign-in budget.
- **Never set `SECURE_LOCAL_NET=true` on a reachable instance.** It makes an
  email address the whole credential.
- **Treat an API key like a password**. Anyone holding it can
  reach every bucket you shared over MCP, and write to the writable ones.
  `SECURE_LOCAL_NET` never waives the key.
- **A share link is a bearer URL.** Anyone who has it can open the file until it
  expires, at most 7 days, or until you revoke all of the document's links. It
  is stored encrypted, and shown only to you.

## Development

```bash
git clone https://github.com/cubicecho/s3-artifacts-mcp.git
cd s3-artifacts-mcp

cp .env.example .env
sed -i "s/^BETTER_AUTH_SECRET=.*/BETTER_AUTH_SECRET=$(openssl rand -hex 32)/" .env

npm install
npm run db:up          # Postgres on 127.0.0.1:5437, RustFS on 9010 (console 9011), bucket `artifacts`
npm run db:migrate
npm run codegen
npm run dev            # API on 3005, Vite dev server on 3001
```

Open <http://localhost:3001>. The dev server proxies `/graphql`, `/api`, `/mcp`
and the OIDC routes to the API, and outside production the magic link comes back in the
response, so the login page offers it as a link.

```bash
npm run check          # codegen, Biome and tsc --noEmit across all three workspaces
npm test               # Vitest: server on an in-memory Postgres, dom, and Storybook in Chromium
npm run storybook      # Storybook on 6006
npm run db:down        # stop Postgres and RustFS
```

The tests against a real bucket (the storage, the content routes, and the MCP
acceptance test: upload, share, open the link, re-key) are skipped unless
`S3AM_IT_ENDPOINT` is set. Against the dev RustFS:

```bash
S3AM_IT_ENDPOINT=http://localhost:9010 S3AM_IT_BUCKET=artifacts S3AM_IT_ACCESS_KEY=s3am \
  S3AM_IT_SECRET_KEY=s3am-dev-secret npx vitest run --project node integration
```

If the Docker daemon is not this machine (`docker context ls` shows a remote
endpoint), set `DEV_BIND=0.0.0.0` in `.env` and point `DATABASE_URL` at the
daemon's host. Only on a network you trust.

See [AGENTS.md](AGENTS.md) for how the pieces fit and the rules that are easy to
break.

### Building the image

```bash
docker compose up --build
```

`docker-compose.yml` builds from this checkout instead of pulling.

## Differences from Engrafo

s3-artifacts-mcp started as a copy of
[Engrafo](https://github.com/cubicecho/engrafo) and keeps its shell: the
workspaces, the generated GraphQL schema, sign-in, API keys and the cubeui app.

- **Gone:** OCR and the processing pipeline, search and embeddings, folders,
  trash, merging and title suggestions, receipts and document dates, the vision
  model, backup and export, the watched folder, duplicate detection.
- **One owner** instead of open registration.
- **Buckets are configured in the UI**, several at once, instead of one
  `S3_*` bucket in the environment.
- **Uploads stream through the server**, where Engrafo's browser uploads straight
  to the bucket, so no bucket CORS is needed.
- **Share links**, which Engrafo has no equivalent of.
- **MCP per bucket and writable**, where Engrafo's `/mcp` reads shared folders
  only.
- **Tags** instead of folders.
- **No `OIDC_*` or `SESSION_STORE`.** OIDC comes only from pairing, and
  sessions are always in Postgres.
- **Published to GHCR only**, never to Docker Hub.
- **Different ports** (3005, 3001 in dev, 5437, 9010/9011), so both run on one
  machine.

## License

[MIT](LICENSE)
