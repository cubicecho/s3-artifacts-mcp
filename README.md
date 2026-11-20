# s3-artifacts-mcp

**An agent generates an artifact, uploads it over MCP to your S3, MinIO or
RustFS bucket, creates a share link and hands that link to you.**

A report, a chart, a CSV, a build log, a PDF: whatever the agent made, you get a
URL that opens it, served straight from your own bucket. s3-artifacts-mcp is the
small, self-hosted store in between. It keeps the documents' metadata in
Postgres, the bytes in buckets you configure, and gives each bucket its own MCP
endpoint.

One person owns an instance. It runs as one container beside a Postgres, and
the quickstart adds a RustFS to hold the files.

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

## Quickstart

[`docker-compose.quickstart.yml`](docker-compose.quickstart.yml) runs the
published image, `ghcr.io/cubicecho/s3-artifacts-mcp`, with a Postgres and a
RustFS beside it. Nothing to clone and nothing to build. Its header comments
repeat these steps, for when you paste it into Portainer, TrueNAS SCALE or
Dockge instead (the variables then go in the stack's environment box).

Below, `nas.local` stands for the address of the machine it runs on: a hostname
or LAN IP that your browser, and the machine your agent runs on, can both reach.

**1. Start it.**

```bash
mkdir s3-artifacts-mcp && cd s3-artifacts-mcp
curl -fsSLO https://raw.githubusercontent.com/cubicecho/s3-artifacts-mcp/main/docker-compose.quickstart.yml

cat > .env <<EOF
S3AM_HOST=nas.local
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
RUSTFS_PASSWORD=$(openssl rand -hex 24)
EOF

docker compose -f docker-compose.quickstart.yml up -d --wait
curl http://nas.local:3005/healthz          # {"ok":true,"version":"…"}
```

The stack refuses to start until all four are set. Keep the `.env`: changing
`BETTER_AUTH_SECRET` later signs you out and makes the stored bucket secrets
unreadable, and each bucket then asks for its secret again. If ports 3005, 9000
or 9001 are taken on that machine, set `S3AM_PORT`, `RUSTFS_PORT` or
`RUSTFS_CONSOLE_PORT` in the `.env`.

**2. Sign in.** Open `http://nas.local:3005` and enter your email address.
**The first account to sign in owns the instance**, and every other address is
refused after that. There is no mail provider, so the sign-in link is written to
the container log, on the line after `[auth] Magic link for you@…`:

```bash
docker logs s3-artifacts-mcp
```

Open that link. On a network you control, `SECURE_LOCAL_NET=true` in the `.env`
skips the link, and `EXPOSE_MAGIC_LINK=true` has the login page offer it (see
[Configuration](#configuration) before using either). You can also sign in with
an OIDC provider instead: [Signing in with an OIDC provider](#signing-in-with-an-oidc-provider).

**3. Add the bucket.** In **Settings → Buckets**, press **Add bucket** and fill
it in for the RustFS in the stack:

| Field | Value |
| --- | --- |
| Provider | RustFS |
| Name | `artifacts` (the slug, and so the MCP endpoint, comes from it) |
| Endpoint | `http://rustfs:9000`, how the server reaches it |
| Public endpoint | `http://nas.local:9000` (your `RUSTFS_PORT`, if you changed it) |
| Bucket | `artifacts` |
| Access key ID | `s3am` |
| Secret access key | your `RUSTFS_PASSWORD` |

Saving tests the bucket first: it heads the bucket, writes, reads and deletes a
probe object, and opens a share link from the public endpoint. **The public
endpoint is the field people get wrong**: read
[Where share links and uploads go](#where-share-links-and-uploads-go).

**4. Connect Claude Code.** Make a key in **Settings → API keys** with
**New key**; it is shown once. In **Settings → MCP**, turn on **Reachable over
MCP** for the bucket, and **Writable** so the agent can upload and share. Copy
the Claude Code command shown under the bucket, put your key in it, and run it
where Claude Code runs:

```bash
claude mcp add --transport http artifacts http://nas.local:3005/mcp/b/artifacts \
  --header "x-api-key: s3a_…"
```

The endpoint shown is built from the address your browser has open, so open the
app at the address the agent's machine will use, not `localhost`.

**5. Get a link back.** Ask Claude Code for something, for example *"Write a
one-page summary of this repo's README as markdown, upload it to artifacts and
give me a share link."* It calls `upload_document` with `share`, and answers
with a URL that starts `http://nas.local:9000/artifacts/…` and when it expires.
Open it in your browser: it is served by RustFS, not by the app. For a file on
the agent's disk (*"upload ./report.pdf and share it"*) it uses `create_upload`,
`curl` and `complete_upload` instead ([How an agent uploads](#how-an-agent-uploads)).

**Upgrading.** `docker compose -f docker-compose.quickstart.yml pull && docker
compose -f docker-compose.quickstart.yml up -d`. Migrations run at boot. To
stay on one release, set `S3AM_VERSION` (for example `1.3.0`) in the `.env`;
it defaults to `latest`.

Your documents live in the `s3am_rustfs` volume (or whichever buckets you add),
and their metadata, tags and share links in `s3am_pgdata`. Back up both
together. Before you give the instance a domain, read
[Before you expose it](#before-you-expose-it).

## Connecting other MCP clients

Any MCP client that speaks Streamable HTTP works the same way as Claude Code:
the endpoint, `http://<host>:3005/mcp/b/<slug>`, and an API key as `x-api-key`
or `Authorization: Bearer`. A session cookie is never accepted there. Without a
valid key every request answers 401; with one, an unknown slug and a bucket
with MCP off answer the same 404.

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

The upload URL carries the type and size in its signature, so the bucket
refuses any other file. `complete_upload` checks the size, hashes the file and
makes it a document; calling it again answers the same document.

The file path needs an agent with a shell (Claude Code and the like), and the
agent's machine must reach the bucket at its public endpoint. Claude Desktop or
claude.ai without a shell can use only the text path.

Either way, the common case is one call, or two calls and a `curl`. Every write
tool tells the agent to give you `shareLink.url` and its expiry. A `share`
that leaves something out takes your defaults from Settings → General (24
hours and download, to start), and the link is listed in Settings → Share links
as made over MCP.

## Share links

A share link is a presigned URL on the bucket, not a link to this app. Make one
with **Share** on a document's page: pick what it lets the recipient do, how
long it lasts, and an optional label, and the app shows the URL with a Copy
button. It stays in the document's list (and in Settings → Share links), marked
active, expired or revoked, where it can be copied again. The browser fetches
straight from the bucket, so the app is not in the path and can be offline. That
has consequences, and the UI states them; they are listed under
[Limits](#limits).

- **"View" is not copy protection.** It only asks the browser to show the file
  inline instead of downloading it.
- Links have no passwords. A link is a bearer URL: anyone who has it can open
  the file until it expires.

### Where share links and uploads go

Each bucket has two addresses. **Endpoint** is where the server reaches the
bucket, for everything the app does itself. **Public endpoint** (which defaults
to the endpoint) is what share links and an agent's upload URLs are signed for,
and those requests go straight from the recipient's browser, or the agent's
machine, to the bucket. The rules:

- **The public endpoint must be reachable from wherever a link is opened**, and
  from the machine an agent uploads a file from. `http://rustfs:9000` is a name
  only the containers in the stack know, and `localhost` means a different
  machine to everyone but the Docker host. Use the host's LAN name or IP, or a
  domain.
- **The signature covers the host and port.** A link signed for one address
  fails at any other, with a signature error rather than a DNS one, even when
  both reach the same bucket. So the public endpoint is spelled exactly as
  browsers will use it.
- **A reverse proxy in front of the bucket** must pass the `Host` header, the
  path and the query string through unchanged, and the public endpoint is then
  the proxy's address (`https://s3.example.com`). A proxy that rewrites `Host`
  breaks every link.
- **Links already made keep the address they were signed for.** Changing a
  bucket's public endpoint affects only links made after.
- **The bucket test opens a share link from the server.** When the server
  cannot reach the public address (some routers do not loop back), the save
  still succeeds with a warning, and links may still work from a browser. Open
  one to check.
- **No CORS setting is needed.** The app streams its own uploads and downloads
  through the server, opening a link is a plain navigation, and an agent's
  upload comes from `curl`, not a browser.
- **The app's own address is a separate thing.** `APP_URL` is used for sign-in
  links and the OIDC redirect URI; it plays no part in share links. The MCP
  endpoint shown in Settings → MCP comes from the address your browser has the
  app open at.

## Limits

Most of these come from S3 itself, because a share link is checked by the
bucket and not by this app.

- **A link lasts from 1 hour to 7 days.** Pick 1 hour, 1 day, 3 days or 7 days,
  or type any whole number of hours or days in between; the dialog shows when it
  will stop working before you make it. 7 days is SigV4's maximum, on AWS, MinIO
  and RustFS alike, so there is no "never". The default (24 hours) and the
  default permission are set in Settings → General.
- **A single link cannot be revoked before it expires.** The bucket checks the
  signature, not our database. "Remove from list" forgets a link here; the URL
  keeps working until it expires.
- **Revoking means re-keying.** "Revoke all links" on a document's page copies
  the object to a new key and deletes the old one, so every link made so far
  answers 404 and shows as revoked. A file a scan found leaves the path you put
  it at for one the app makes. If the bucket refuses the delete, nothing is
  revoked and the app says so.
- **Rotating the bucket's access key** kills every link signed with it. The
  bucket form says so when you change the key.
- **Changing `BETTER_AUTH_SECRET`** signs you out, makes every stored bucket
  secret unreadable (each bucket then asks for its secret again) and hides the
  URLs of the links already made. Those links still open until they expire.
- **Uploads**: up to the limit in Settings → General, which starts at 100 MiB
  and goes up to 50 GiB. Over MCP, inline text is at most 5 MiB and one
  presigned PUT at most 5 GiB. An upload URL works for 15 minutes, and an upload
  never completed is dropped, with whatever reached the bucket, after an hour.
- **MCP reads**: text up to 256 KiB comes back as text, and an image or PDF up
  to 10 MiB as an embedded resource. Anything larger, or of another type, comes
  back as its details and a note.
- **One owner per instance**, and API keys are not limited to some buckets: a
  key reaches every bucket with MCP on.

## Configuration

**The server reads only these.** Everything else (buckets, the upload limit,
share-link defaults, OIDC) is set in the app.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | — | **Required.** Postgres connection string. |
| `BETTER_AUTH_SECRET` | — | **Required in production**, at least 32 characters (`openssl rand -hex 32`). Signs sessions, and derives the key that encrypts bucket secrets and share URLs. |
| `APP_URL` | the request's own address | Where people reach the app. Sign-in links and the OIDC redirect URI are built from it. |
| `PORT` | `3005` | Port the server listens on. |
| `TRUST_PROXY` | `false` | Which proxy hops may set `X-Forwarded-For`: a hop count (`1`) or a subnet list. |
| `SECURE_LOCAL_NET` | `false` | `true` on a network with nothing hostile on it: an address alone signs you in, with no link to fetch. |
| `EXPOSE_MAGIC_LINK` | `false` | `true` returns the sign-in link to the login page in production, as development always does, instead of only logging it. Private networks only. |
| `DB_CONNECT_TIMEOUT_MS` | `60000` | How long boot waits for Postgres before giving up. |

- **`APP_URL`**: unset, each request uses the address the browser came in on.
  The quickstart sets it to `http://S3AM_HOST:S3AM_PORT`, because a sign-in link
  is read from the log, where there is no request to take an address from.
  Behind a reverse proxy, set it to the address people type
  (`https://docs.example.com`). It has nothing to do with share links: see
  [Where share links and uploads go](#where-share-links-and-uploads-go).
- **`TRUST_PROXY`**: the sign-in throttle counts attempts by client address.
  With a reverse proxy in front and this left `false`, every visitor shares the
  proxy's address and its budget; set it to the number of proxies (usually `1`).
  Never set it to `true` or a hop count on a port the internet reaches directly,
  or any client can choose its own address by sending the header.
- **`SECURE_LOCAL_NET` and `EXPOSE_MAGIC_LINK`** both make an email address
  enough to sign in, the first with no link at all and the second by handing the
  link to whoever asks. Neither is wrong on a LAN you control, and both are
  wrong the moment the port is reachable from anywhere you don't. Neither ever
  waives an API key on the MCP endpoints.

Sessions are always kept in Postgres, so a restart signs nobody out.

**The quickstart file adds these**, which are about the stack rather than the
server:

| Variable | Default | Meaning |
| --- | --- | --- |
| `S3AM_HOST` | — | **Required.** The machine's hostname or LAN IP, no scheme. `APP_URL` is built from it. |
| `POSTGRES_PASSWORD` | — | **Required.** The database's password. |
| `RUSTFS_PASSWORD` | — | **Required.** The RustFS root secret, and so the bucket's secret access key. |
| `S3AM_VERSION` | `latest` | The image tag to run, such as `1.3.0`. |
| `S3AM_PORT` | `3005` | Where the app is published. |
| `RUSTFS_PORT` | `9000` | Where RustFS is published. Share links point here. |
| `RUSTFS_CONSOLE_PORT` | `9001` | RustFS's admin console. It takes the root password, so drop the line if you don't want it published. |
| `TZ` | `UTC` | The containers' time zone. |

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
with a magic link to the new one. With the quickstart:

```bash
docker exec -it s3-artifacts-mcp-postgres psql -U s3am -d s3am
```

```sql
SELECT id, email FROM users;                      -- there is one row
UPDATE users SET email = 'you@example.com';
DELETE FROM oidc_settings;                        -- only if the provider is gone; restart after
```

Elsewhere, run the same with `psql "$DATABASE_URL"`. Then sign in as
`you@example.com` and take the link from the log. The owner's documents,
buckets, tags, keys and links are untouched.

## Before you expose it

- **Put it behind a reverse proxy with TLS**, set `APP_URL` to its address and
  `TRUST_PROXY` to the number of proxies in front.
- **Never set `SECURE_LOCAL_NET` or `EXPOSE_MAGIC_LINK` on a reachable
  instance.** They make an email address the whole credential.
- **Treat an API key like a password**. Anyone holding it can
  reach every bucket you shared over MCP, and write to the writable ones.
  Revoke one in Settings → API keys.
- **A share link is a bearer URL.** Anyone who has it can open the file until it
  expires, at most 7 days, or until you revoke all of the document's links. It
  is stored encrypted, and shown only to you.
- **The bucket's public endpoint is public.** Without a valid signature it
  refuses every request, but it is reachable; give it TLS too if links leave
  your network.

## Design decisions

The full list, with reasons, is in [`.agents/plan.md`](.agents/plan.md). The
ones that shape what you see:

- **One owner.** Every other address is refused at sign-up. Rows still carry an
  owner, so more accounts can be added later without restructuring.
- **Settings live in the UI.** Buckets, limits and link defaults are set in the
  app. The environment holds only what is needed before anyone can sign in.
- **The app's own uploads and downloads stream through the server.** No bucket
  CORS is needed, and every backend behaves the same.
- **Share links are presigned URLs on the bucket**, so they open while the app
  is down, at the price of the limits above.
- **Files already in a bucket become documents when you scan it.** Each stays
  at its key; nothing is moved or renamed.
- **Buckets and their items, nothing nested.** Uploads sit at the bucket's top
  level, a dropped folder uploads flat, a scanned file's path is shown in its
  title, and tags are the only way to organise.
- **Bucket secrets and share URLs are encrypted at rest** with a key derived
  from `BETTER_AUTH_SECRET`, and the API never returns them in full.

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
response, so the login page offers it as a link. Add the dev bucket in
Settings → Buckets: RustFS, endpoint `http://localhost:9010`, bucket
`artifacts`, access key `s3am`, secret `s3am-dev-secret`.

```bash
npm run check             # codegen, Biome and tsc --noEmit across all three workspaces
npm test                  # Vitest: server on an in-memory Postgres, dom, and Storybook in Chromium
npm run test:integration  # the tests against a real bucket (below)
npm run storybook         # Storybook on 6006
npm run db:generate       # a new migration after a change to the models
npm run db:down           # stop Postgres and RustFS
```

`npm run check && npm test` is the gate before a commit; CI runs the same.

The integration tests run against a real bucket: the storage, the content
routes, and the MCP acceptance test (upload with tags and a share, open the link
with no credentials, a binary file through a presigned PUT, then a re-key and a
404). They are skipped unless `S3AM_IT_ENDPOINT` is set, and delete every
object they make. Against the dev RustFS:

```bash
S3AM_IT_ENDPOINT=http://localhost:9010 S3AM_IT_BUCKET=artifacts S3AM_IT_ACCESS_KEY=s3am \
  S3AM_IT_SECRET_KEY=s3am-dev-secret npm run test:integration
```

CI's `integration` job runs them against the same RustFS, and fails if any of
them skipped.

If the Docker daemon is not this machine (`docker context ls` shows a remote
endpoint), set `DEV_BIND=0.0.0.0` in `.env`, and point `DATABASE_URL`, the dev
bucket's endpoint and `S3AM_IT_ENDPOINT` at the daemon's host. Only on a
network you trust.

See [AGENTS.md](AGENTS.md) for how the pieces fit and the rules that are easy to
break.

### Building the image

```bash
docker compose up -d --build
```

`docker-compose.yml` is the same stack built from this checkout instead of
pulled. It needs `BETTER_AUTH_SECRET` and `RUSTFS_PASSWORD` in `.env`, and its
header comments list the rest.

### Releases

Every merge to `main` runs CI (`check`, `postgres`, `integration`, `boot`).
When it passes, semantic-release reads the Conventional Commits since the last
release, and a `feat` or `fix` cuts a version: a GitHub release, and the image
at `ghcr.io/cubicecho/s3-artifacts-mcp:<version>` and `:latest`. The image goes
to GHCR only.

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
