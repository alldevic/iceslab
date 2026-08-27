# syntax=docker/dockerfile:1.7

# Multi-stage Dockerfile for the Iceslab admin frontend.
# Build context MUST be the monorepo root (so pnpm-workspace.yaml is accessible).
#
#   docker build -f apps/panel-frontend/Dockerfile -t iceslab-frontend .
#
# The runtime image is nginx serving the Vite-built static bundle. The
# nginx config also reverse-proxies the backend's public paths (`/api`,
# the subscription prefix, `/geo/`, the facade prefix, `/health`, `/admin/`)
# to the backend service (compose service name `backend` on port 3000).

# node pinned to a minor (not floating `22-alpine`) - see backend Dockerfile
# for the 2026-06-11 drift incident. nginx is already minor-pinned. Digest pins
# (@sha256) are the follow-up (I4b) once Renovate is wired.
ARG NODE_VERSION=22.22-alpine
ARG NGINX_VERSION=1.27-alpine

# ───── Build stage ─────
FROM node:${NODE_VERSION} AS builder
# NODE_OPTIONS caps V8 heap for Vite build, without it Rollup can climb past
# 2 GB during the bundle phase and OOM on small VPS. 1536 MB matches backend.
# NPM_CONFIG_FETCH_* retries on flaky networks instead of hanging.
ENV CI=true \
    NODE_OPTIONS=--max-old-space-size=1536 \
    NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
    NPM_CONFIG_FETCH_TIMEOUT=300000
RUN corepack enable
WORKDIR /repo

# Vite bakes env vars into the bundle at build time. Empty default makes the
# frontend issue same-origin requests, which the nginx layer below proxies
# through to the backend service.
ARG VITE_API_BASE_URL=
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

# Manifest layer for cacheable dep install.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/panel-frontend/package.json apps/panel-frontend/
COPY packages/shared/package.json packages/shared/

RUN --mount=type=cache,id=pnpm,target=/root/.pnpm-store \
    pnpm install --frozen-lockfile --prefer-offline --filter "@iceslab/panel-frontend..."

COPY apps/panel-frontend apps/panel-frontend
COPY packages/shared packages/shared

WORKDIR /repo/apps/panel-frontend
RUN pnpm build

# ───── Runtime stage: nginx static + API proxy ─────
FROM nginx:${NGINX_VERSION} AS runtime
COPY --from=builder /repo/apps/panel-frontend/dist /usr/share/nginx/html
# Rendered by the nginx image's own entrypoint at container start, not baked:
# two of the proxied prefixes are operator-configurable on the backend
# (SUBSCRIPTION_PATH_PREFIX, REMNAWAVE_COMPAT_PREFIX) and a config frozen at
# build time cannot follow them. The defaults below match the backend's own
# defaults, so an operator who changes neither gets exactly the old config.
#
# The FILTER is not optional: without it envsubst substitutes every ${...} it
# finds whose name exists in the environment, which in an nginx config means
# `$host`, `$uri`, `$scheme` and friends get replaced with empty strings.
COPY apps/panel-frontend/nginx.conf.template /etc/nginx/templates/default.conf.template
# Not a template: it holds no operator-configurable value, and it is a plain
# include so the header set exists in exactly one place.
COPY apps/panel-frontend/security-headers.conf /etc/nginx/snippets/security-headers.conf
ENV ICESLAB_SUB_PREFIX=/sub \
    ICESLAB_COMPAT_PREFIX=rw \
    NGINX_ENVSUBST_FILTER=^ICESLAB_
EXPOSE 80

HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ > /dev/null 2>&1 || exit 1
