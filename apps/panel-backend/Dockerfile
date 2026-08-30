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

# Toolchain for the one core this image compiles (see the singbox-builder
# stage). Declared up here because an ARG used in a FROM has to precede the
# first FROM, which is also why the version lives in two places - the manifest
# states it as `source.goVersion` and core-source-build.test fails when the two
# drift.
#
# Deliberately NOT the node's 1.27.0 pin: sing-box 1.13.19 does not compile
# under 1.27.0 (a dependency reaches into the standard library's experimental
# encoding/json/v2, which 1.27 changed under it). Measured, see the manifest.
ARG GO_IMAGE=golang:1.26.7-alpine
# ───── sing-box, COMPILED rather than downloaded ─────
#
# The one core this image builds, and not by preference. Upstream's release
# binaries are not built with `with_v2ray_api` - their own `sing-box version`
# lists the tag set and it is not there - and sing-box does not ignore an
# `experimental.v2ray_api` block it cannot honour, it exits 1 before opening a
# port. Every sing-box config this panel writes carries that block, because it
# is how per-user traffic is counted, so the published binary offers a choice
# between a sing-box engine with no accounting and one that does not run.
# Measured on a lab node 2026-08-30. The whole argument, and the manifest
# parsing, live in scripts/build-singbox.sh; this stage only supplies a
# toolchain.
#
# The pin does not weaken, it moves: from the sha256 of a published binary to
# the sha256 of the published SOURCE plus the Go image below. A stale sum fails
# this build exactly as it fails the download step. What the NODE checks is
# unchanged - it compares the bytes it got against the sum the panel states -
# and for these the panel states the sum written beside them here.
FROM ${GO_IMAGE} AS singbox-builder
ARG CORE_ARCHES="amd64 arm64"
# binutils: build-singbox.sh asks readelf whether what it built is static, and
# a missing readelf would make that check silently pass.
RUN apk add --no-cache curl tar binutils
COPY packages/shared/src/core-binaries.ts /manifest/core-binaries.ts
COPY scripts/build-singbox.sh /usr/local/bin/build-singbox.sh
RUN --mount=type=cache,id=gomod,target=/go/pkg/mod \
    --mount=type=cache,id=gobuild,target=/root/.cache/go-build \
    sh /usr/local/bin/build-singbox.sh /manifest/core-binaries.ts /out "$CORE_ARCHES"


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

# ───── Proxy-core binaries, from the pinned manifest ─────
#
# The panel carries the cores and the nodes take them from it. Before this, a
# node fetched its core straight from GitHub — "latest" resolved through
# api.github.com, installed unverified — which put the bytes that terminate
# subscriber traffic, on the machine that holds the node's mTLS key, on a host
# nobody in this system authenticates and a path a censored node may not have.
# The trust question is answered once, here, by whoever builds or pulls this
# image.
#
# The manifest is `packages/shared/src/core-binaries.ts`, and it is READ rather
# than copied: the step above compiled shared to .js siblings, so node can
# import the same declaration the panel and the mirror tests use. Nothing about
# a version or a checksum is written twice.
#
# Artefacts are kept BYTE-IDENTICAL to what upstream published, archive and
# all, so one sha256 means the same thing at panel build, on this disk, and on
# the node after it downloads.
#
# CORE_ARCHES defaults to the two architectures VPS fleets actually run.
# Building with "amd64 arm64 armv7" adds ~65 MB and the third architecture;
# a node whose arch this image does not carry is refused BY NAME rather than
# quietly sent back to GitHub.
ARG CORE_ARCHES="amd64 arm64"
RUN --mount=type=cache,id=cores,target=/var/cache/cores \
    set -eu; \
    ARCHES="$CORE_ARCHES" node --input-type=module -e " \
      const { CORE_BINARIES, coreAssetUrl } = await import('/repo/packages/shared/src/core-binaries.js'); \
      const arches = process.env.ARCHES.split(' ').filter(Boolean); \
      for (const [name, core] of Object.entries(CORE_BINARIES)) \
        for (const arch of arches) { \
          const a = core.assets[arch]; \
          if (!a || !a.sha256) continue; \
          console.log([name, arch, a.file, a.sha256, coreAssetUrl(name, arch)].join('\t')); \
        } \
    " > /tmp/cores.tsv; \
    mkdir -p /repo/cores; \
    while IFS="$(printf '\t')" read -r name arch file sha url; do \
      [ -n "$name" ] || continue; \
      cached="/var/cache/cores/${sha}"; \
      if [ ! -f "$cached" ]; then \
        echo "fetching ${name} ${arch} <- ${url}"; \
        wget -qO "$cached.part" "$url" || { echo "download failed: $url" >&2; exit 1; }; \
        mv "$cached.part" "$cached"; \
      fi; \
      echo "${sha}  ${cached}" | sha256sum -c - >/dev/null || { \
        echo "sha256 mismatch for ${name} ${arch} (${file}): upstream moved or the pin is stale" >&2; \
        rm -f "$cached"; exit 1; \
      }; \
      install -m 0644 "$cached" "/repo/cores/${name}-${arch}"; \
      echo "  ok ${name}-${arch} ($(stat -c%s "/repo/cores/${name}-${arch}") bytes)"; \
    done < /tmp/cores.tsv; \
    ls -1 /repo/cores | wc -l

# The compiled core joins the downloaded ones, sidecar sums included. Kept as a
# separate COPY so the fetch step above stays about downloading and this stays
# about building.
COPY --from=singbox-builder /out/ /repo/cores/
RUN set -eu; ls -l /repo/cores/ | sed 's/^/  /'

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

# The geo builder compiles per-category .srs rule-sets with sing-box (SINGBOX_BIN,
# G6), and the binary it needs is one the image already carries for the nodes.
# It used to be downloaded again here, pinned to 1.11.4 while the manifest
# pinned another version for the fleet: two sing-box versions in one repository,
# each with its own checksum to bump, and nothing holding them together. Now
# there is one.
#
# Optional feature: if a build ever cannot carry cores, drop this block and
# leave SINGBOX_BIN unset — the sing-box subscription format then keeps its
# external SagerNet URLs (graceful degrade). TARGETARCH is amd64/arm64 under
# buildx; plain `docker build` leaves it empty -> amd64.
ARG TARGETARCH
RUN set -eux; \
    arch="${TARGETARCH:-amd64}"; \
    src="/app/cores/sing-box-${arch}"; \
    if [ -f "$src" ]; then \
      tar -xzf "$src" -C /tmp; \
      install -m 0755 "$(find /tmp -type f -name sing-box | head -n1)" /usr/local/bin/sing-box; \
      rm -rf /tmp/sing-box-*; \
      /usr/local/bin/sing-box version; \
    else \
      echo "no sing-box for ${arch} in this image; geo .srs compilation stays off" >&2; \
    fi
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
