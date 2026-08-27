# syntax=docker/dockerfile:1.7

# Multi-stage Dockerfile for the Iceslab backend.
# Build context MUST be the monorepo root (so pnpm-workspace.yaml is accessible).
#
#   docker build -f apps/panel-backend/Dockerfile -t iceslab-backend .

# Pinned to a minor (not the floating `22-alpine` major tag). On 2026-06-11 the
# major tag drifted from an earlier 22.x to 22.22, whose stricter type-stripped
# .ts resolution crash-looped the backend on rebuild (ERR_MODULE_NOT_FOUND on
# the shared package). Minor-pinning still pulls 22.22.x security patches but
# never silently jumps a minor again. Digest-pinning (@sha256) is the
# production-grade follow-up (I4b) once we wire Renovate.
ARG NODE_VERSION=22.22-alpine

# ───── Build stage ─────
FROM node:${NODE_VERSION} AS builder
# NODE_OPTIONS caps the V8 heap during build, without it pnpm + tsc can climb
# past 2 GB on a fresh install and OOM-kill the container on small VPS (CX22-class).
# 1536 MB leaves headroom for native module compilers (sharp, esbuild, prisma).
# NPM_CONFIG_FETCH_RETRIES retries silently on flaky networks instead of hanging
# forever waiting for a TCP read. Three retries with exponential backoff covers
# 95% of transient registry / mirror failures.
ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NODE_OPTIONS=--max-old-space-size=1536 \
    NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
    NPM_CONFIG_FETCH_TIMEOUT=300000 \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
RUN corepack enable
WORKDIR /repo

# Copy manifests first so dependency installation is cacheable.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/panel-backend/package.json apps/panel-backend/
COPY packages/shared/package.json packages/shared/

# Install dev+prod deps for the backend filter (incl. workspace transitives).
# --prefer-offline uses cached packages when available (faster reruns).
RUN --mount=type=cache,id=pnpm,target=/root/.pnpm-store \
    pnpm install --frozen-lockfile --prefer-offline --filter "@iceslab/panel-backend..."

# Now bring in source.
COPY apps/panel-backend apps/panel-backend
COPY packages/shared packages/shared

# Generate Prisma client + compile TS to dist/.
WORKDIR /repo/apps/panel-backend
# Retry prisma generate: it pulls the query engine / does network checks and
# a flaky network can ECONNRESET mid-fetch. Five attempts with a short
# backoff turns a transient blip into a non-event instead of a failed deploy.
# CHECKPOINT_DISABLE (set above) already removes the spurious update-check call.
RUN for i in 1 2 3 4 5; do \
      pnpm exec prisma generate && exit 0; \
      echo "prisma generate attempt $i failed; retrying in 5s"; \
      sleep 5; \
    done; \
    echo "prisma generate failed after 5 attempts" >&2; exit 1
RUN pnpm exec tsc

# Compile the @iceslab/shared workspace package in-place (emit .js siblings
# next to the .ts in its src/). Its package.json points the package entry at
# `src/index.ts` so dev tooling (tsx / vitest / vite) reads TS source directly.
# Production, however, runs plain `node dist/index.js`, and since Node 22.22 a
# .ts entry's `export * from './transport.js'` no longer falls back to
# transport.ts (ERR_MODULE_NOT_FOUND), node:22-alpine floated into that
# behaviour and crash-looped the backend on the first rebuild. Emitting the
# compiled .js siblings makes the source entry resolve under plain node without
# touching package.json (so dev/test/frontend stay on TS source, they never
# see these .js, which exist only inside this image). cwd here is
# /repo/apps/panel-backend; use absolute paths to dodge cwd ambiguity.
RUN pnpm exec tsc -p /repo/packages/shared/tsconfig.json \
      --outDir /repo/packages/shared/src --declaration false

# Strip dev deps so only production node_modules remain.
WORKDIR /repo
RUN --mount=type=cache,id=pnpm,target=/root/.pnpm-store \
    pnpm install --frozen-lockfile --prod --prefer-offline --filter "@iceslab/panel-backend..."

# Strip the sources too. The runtime stage copies /repo wholesale, so whatever
# survives this line is what an operator ends up hosting on their VPS: before
# it, the backend image carried all 421 .ts of apps/panel-backend/src (188 of
# them tests), the tests/ helpers, vitest.config.ts and a copy of this
# Dockerfile. None of it is reachable from `node dist/index.js` - tsc emitted
# every one of those files, including src/generated/prisma, into dist/ - and
# none of it is secret (image-selftest.sh asks the built image about that
# separately). It is simply not the operator's to run, patch or grep.
#
# What must NOT go:
#   * packages/shared/src - its package entry IS src/index.ts, and the builder
#     emits the .js siblings next to the .ts precisely so plain node resolves
#     them. Deleting the directory deletes the program.
#   * prisma/ and prisma.config.ts - `docker compose run --rm migrate` runs
#     `pnpm exec prisma migrate deploy` out of this same image and reads both.
#   * the workspace manifests at /repo - that same pnpm invocation needs them.
#
# tsconfig.json goes with the rest: nothing in the runtime image compiles, and
# the migrate one-shot's TS entry (prisma.config.ts) is loaded by Prisma's own
# loader, which does not consult it. That claim is checked, not asserted - the
# migrate cases in scripts/ops/image-selftest.sh run against this image.
RUN rm -rf \
      /repo/apps/panel-backend/src \
      /repo/apps/panel-backend/tests \
      /repo/apps/panel-backend/scripts \
      /repo/apps/panel-backend/vitest.config.ts \
      /repo/apps/panel-backend/tsconfig.json \
      /repo/apps/panel-backend/Dockerfile \
      /repo/apps/panel-backend/README.md \
      /repo/packages/shared/tsconfig.json \
      /repo/packages/shared/testdata \
      /repo/packages/shared/README.md

# ───── Runtime stage ─────
FROM node:${NODE_VERSION} AS runtime
# NODE_OPTIONS heap cap: without it, Node's auto-sizing on small-RAM containers
# (2 GB VPS) settles around a 60 MB heap, which sits at 95%+ pressure under
# normal load. GC runs every second, CPU bursts repeatedly, dashboard shows
# "panel process 96%". 512 MB is enough headroom for the panel's working set
# (Prisma client, BullMQ queues, request context) without crowding Postgres
# and Redis sharing the same 2 GB.
ENV NODE_ENV=production \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NODE_OPTIONS=--max-old-space-size=512
RUN corepack enable
# Pre-fetch pnpm so the migrate one-shot doesn't trigger an interactive
# Corepack download prompt at runtime (was hanging `pnpm exec prisma migrate
# deploy` until killed). The version comes from package.json's
# `packageManager` field.
RUN corepack prepare pnpm@10.33.2 --activate
WORKDIR /app

# Copy the trimmed workspace from the builder.
COPY --from=builder /repo /app

# Bundle sing-box so the geo builder can compile per-category .srs rule-sets
# (SINGBOX_BIN, G6). Optional feature - if the download is ever a problem, drop
# this block and leave SINGBOX_BIN unset: the sing-box subscription format then
# keeps its external SagerNet URLs (graceful degrade). TARGETARCH is amd64/arm64
# under buildx; plain `docker build` leaves it empty -> amd64. busybox wget (no
# curl in alpine); it follows the GitHub 302 to the release CDN.
# Pinned to a per-arch sha256: a silently re-pointed tag or a tampered CDN
# response fails the build instead of shipping an unexpected binary. BUMPING
# SINGBOX_VERSION REQUIRES updating both checksums (get them from the release, or
# the build's sha256sum -c will fail) - see docs/geo-svc-prod-checklist.md.
ARG SINGBOX_VERSION=1.11.4
ARG SINGBOX_SHA256_AMD64=0bb762ef286b36c2016d9107fc1f089be7a75f6d579b33f067d31e696c05927e
ARG SINGBOX_SHA256_ARM64=4e687359db42b6a28ef93f9cd2cb9549c4b0079cc7e49bc5f6ecbf98257a2507
ARG TARGETARCH
RUN set -eux; \
    arch="${TARGETARCH:-amd64}"; \
    case "$arch" in \
      amd64) sha="$SINGBOX_SHA256_AMD64" ;; \
      arm64) sha="$SINGBOX_SHA256_ARM64" ;; \
      *) echo "unsupported TARGETARCH: $arch" >&2; exit 1 ;; \
    esac; \
    d="sing-box-${SINGBOX_VERSION}-linux-${arch}"; \
    wget -qO /tmp/sb.tgz "https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VERSION}/${d}.tar.gz"; \
    echo "${sha}  /tmp/sb.tgz" | sha256sum -c -; \
    tar -xzf /tmp/sb.tgz -C /tmp; \
    install -m 0755 "/tmp/${d}/sing-box" /usr/local/bin/sing-box; \
    rm -rf /tmp/sb.tgz "/tmp/${d}"; \
    /usr/local/bin/sing-box version
ENV SINGBOX_BIN=/usr/local/bin/sing-box

WORKDIR /app/apps/panel-backend

# I5: run the long-lived backend as the unprivileged `node` user (uid 1000,
# ships with the image). Safe without extra setup: the app writes nothing to
# disk at runtime (logs to stdout, state in Postgres/Redis), reads only
# world-readable files copied in above, and binds an unprivileged port (3000).
# The `migrate` one-shot overrides back to root in compose (it shells out to
# pnpm/corepack). If a future feature needs to write to disk, mount a writable
# volume owned by uid 1000 rather than reverting to root.
USER node
EXPOSE 3000

# Healthcheck hits /health which pings Postgres + Redis.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
