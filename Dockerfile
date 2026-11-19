# syntax=docker/dockerfile:1

FROM node:26-slim AS builder

WORKDIR /app

COPY . .

# devDependencies included: codegen and the Vite build both need them.
RUN npm ci

# The GraphQL schema is generated from the Drizzle schema, so codegen imports
# @cubicecho/s3-artifacts-mcp-db — which refuses to load without a DATABASE_URL.
# postgres-js does not connect until a query runs, so a placeholder is enough.
ENV DATABASE_URL=postgres://build:build@127.0.0.1:5432/build
RUN npm run codegen && npm run build:app

# `docker build --target test -t s3-artifacts-mcp-test . && docker run --rm s3-artifacts-mcp-test`.
# Not `npm test`: that also runs the `storybook` project, which needs a Chromium
# this image does not carry. The stories run in CI's `check` job.
FROM builder AS test
CMD ["npx", "vitest", "run", "--project", "node", "--project", "dom"]

FROM node:26-slim AS runtime

WORKDIR /app

# Only the runtime workspaces are installed; Vite and its plugins exist to
# produce app/dist and are useless once it exists.
COPY package.json package-lock.json ./
COPY db/package.json db/
COPY server/package.json server/
COPY app/package.json app/

RUN npm ci --omit=dev --include-workspace-root --workspace @cubicecho/s3-artifacts-mcp-db --workspace @cubicecho/s3-artifacts-mcp-server \
 && npm cache clean --force

# The server is not compiled: Node strips the types from its TypeScript sources
# as it loads them, so the sources are the build output.
COPY db/src db/src
COPY db/drizzle db/drizzle
COPY server/src server/src
COPY --from=builder /app/app/dist app/dist

ENV NODE_ENV=production
ENV PORT=3005

EXPOSE 3005

# Nothing is written to the container's disk: documents go to the buckets and
# everything else to Postgres, so no directory needs chowning first.
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3005)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# No --preserve-symlinks: it would resolve @cubicecho/s3-artifacts-mcp-db to its path
# inside node_modules, and Node refuses to strip types from anything under there.
# Exec form, so node is PID 1 and receives SIGTERM itself.
CMD ["node", "server/src/index.ts"]
