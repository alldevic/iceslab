# syntax=docker/dockerfile:1.7

# Multi-stage Dockerfile for the Iceslab Go node-agent.
#
# The build context MUST be apps/node/, not the monorepo root: `COPY go.mod`
# below is relative to the context and there is no go.mod at the root, so a
# root-context build dies on the first COPY. (This comment used to say either
# worked. CI has always passed `context: apps/node` — see the image matrix in
# .github/workflows/ci.yml — so only the comment was wrong, but it is the
# comment a person reads before typing the command by hand.)
#
#   docker build -f apps/node/Dockerfile -t iceslab-node apps/node
#
# Runtime is `distroless/static:nonroot`, no shell, no package manager,
# minimal attack surface. The Go binary is fully static (CGO_ENABLED=0).

# golang is minor-pinned (1.22.x). distroless `nonroot` is a floating tag with
# no version aliases - it should be digest-pinned (@sha256) as the I4b
# follow-up once Renovate is wired; distroless rarely ships behaviour-breaking
# changes, so the floating tag is acceptable in the interim.
ARG GO_VERSION=1.22-alpine
ARG DISTROLESS_VERSION=nonroot

# ───── Build stage ─────
FROM golang:${GO_VERSION} AS builder
WORKDIR /src

# Cache go modules separately from source.
COPY go.mod go.sum* ./
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    go mod download

COPY . .

# Static binary, stripped, no symbols/DWARF.
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    CGO_ENABLED=0 GOOS=linux go build \
        -trimpath \
        -ldflags="-s -w" \
        -o /out/iceslab-node \
        .

# ───── Runtime stage: distroless ─────
FROM gcr.io/distroless/static:${DISTROLESS_VERSION}

COPY --from=builder /out/iceslab-node /usr/local/bin/iceslab-node

ENV NODE_HOST=0.0.0.0
ENV NODE_PORT=1337
ENV HYSTERIA_AUTH_HOST=127.0.0.1
ENV HYSTERIA_AUTH_PORT=9000

EXPOSE 1337
USER nonroot:nonroot

ENTRYPOINT ["/usr/local/bin/iceslab-node"]
