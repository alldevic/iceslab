#!/usr/bin/env bash
# Provision a fresh Ubuntu/Debian VPS to run a NaiveProxy inbound.
#
# NaiveProxy multi-user mode needs Caddy built with the klzgrad/forwardproxy@naive
# fork; the upstream `naive` standalone binary is single-tenant only. We use
# `xcaddy` to compile a Caddy with the naive plugin and drop the result at
# /usr/local/bin/caddy-naive.
#
# Usage:  sudo bash bootstrap-naive.sh
# Idempotent, safe to rerun (re-pulls upstream sources, re-builds binary).
set -euo pipefail

log()  { printf '\033[1;34m[bootstrap]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "Must be run as root (sudo bash $0)"

# shellcheck source=lib-pinned-fetch.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib-pinned-fetch.sh"
# shellcheck source=lib-apt.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib-apt.sh"

CADDY_NAIVE_BIN=${CADDY_NAIVE_BIN:-/usr/local/bin/caddy-naive}
GO_VERSION=${GO_VERSION:-1.27.0}

# sha256 of the Go tarballs for GO_VERSION, from https://go.dev/dl/?mode=json.
# This is the one thing on a node that is still downloaded from a third party:
# the panel carries proxy cores, not a build toolchain, and xcaddy cannot
# compile Caddy without one. So it is pinned the same way the cores are.
#
# Overriding GO_VERSION therefore drops the sha (the map below only knows this
# one), and the fetch then says out loud that it verified nothing — the same
# wording bootstrap-{singbox,mtg,mieru}.sh use for their hand-run fallback.
# Bump both together.
#
# The pin has to be new enough to BUILD, not merely to run `go`. Measured on a
# Debian 13 guest 2026-08-28 with the old 1.23.4 pin: xcaddy printed
#
#   go: github.com/caddyserver/caddy/v2@v2.11.4 requires go >= 1.25.1;
#       switching to go1.26.7
#   go: downloading go1.26.7 (linux/amd64)
#   go: downloading go1.25.1 (linux/amd64)
#
# — the toolchain we verified by sha256 fetched two more and handed the compile
# to one of them. The build worked, but the pin decided nothing, and a node
# paid for ~160 MB of downloads it did not need. A version that already clears
# Caddy's floor makes the pinned toolchain the one that does the work.
GO_SHA256_amd64=675c26c449cbb18fc24b74650de1eabbae6e16f64326fd85a283fb3b58280685
GO_SHA256_arm64=51798d2c42d0e1c6ed7fd9f48728b4193abac9e8aad6dbac2fe96a81f5909bda
GO_PINNED_VERSION=1.27.0

# Pinned rather than @latest. `go install ...@<version>` is verified against
# the Go checksum database; `@latest` is a moving target that is whatever
# upstream tagged this morning, compiled and run as root at build time.
XCADDY_VERSION=${XCADDY_VERSION:-v0.4.7}

# ───── 1. Distro check ─────
if [[ ! -r /etc/os-release ]]; then
  fail "Cannot read /etc/os-release; unsupported distro"
fi
. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) ;;
  *) fail "Only Ubuntu/Debian are supported here. Detected ID=${ID:-unknown}." ;;
esac
log "Detected $PRETTY_NAME"

# ───── 2. Prereqs ─────
log "Installing apt prereqs (curl, ca-certificates, git)"
apt_get update -y
apt_get install -y \
  curl ca-certificates git build-essential

# ───── 3. Go toolchain ─────
# Ubuntu's apt go can lag the Caddy/xcaddy minimum, so install the upstream
# tarball in /usr/local/go regardless of what apt has.
#
# The floor is the pinned version itself, not a separate number. It used to be
# 1.22, which let a host's own Go 1.23 satisfy the check and then hand the
# compile to a toolchain Go downloaded for itself — the second half of the
# measurement above. One number, and it is the one whose bytes we verified.
NEED_GO=true
if command -v go >/dev/null; then
  CUR=$(go version | awk '{print $3}' | sed 's/^go//')
  if [[ "$(printf '%s\n' "$GO_PINNED_VERSION" "$CUR" | sort -V | head -1)" == "$GO_PINNED_VERSION" ]]; then
    log "Go $CUR already meets >= $GO_PINNED_VERSION"
    NEED_GO=false
  fi
fi
if $NEED_GO; then
  log "Installing Go $GO_VERSION to /usr/local/go"
  ARCH=$(dpkg --print-architecture)
  case "$ARCH" in
    amd64) GO_ARCH=amd64 ;;
    arm64) GO_ARCH=arm64 ;;
    *) fail "Unsupported arch: $ARCH" ;;
  esac
  TARBALL="go${GO_VERSION}.linux-${GO_ARCH}.tar.gz"
  TMPDL=$(mktemp -d)
  GO_SHA=""
  if [[ "$GO_VERSION" == "$GO_PINNED_VERSION" ]]; then
    eval "GO_SHA=\${GO_SHA256_${GO_ARCH}:-}"
  else
    warn "GO_VERSION=$GO_VERSION is not the pinned $GO_PINNED_VERSION; the tarball will be fetched UNVERIFIED"
  fi
  # dl.google.com, not go.dev/dl: the latter answers 302 and pinned_fetch
  # refuses to follow a redirect, which is the whole point of it — a redirect
  # is a second host getting to choose what lands in /usr/local/go. Measured
  # 2026-08-28: go.dev/dl/<tarball> -> 302, dl.google.com/go/<tarball> -> 200.
  pinned_fetch "https://dl.google.com/go/${TARBALL}" "${TMPDL}/${TARBALL}" "$GO_SHA"
  rm -rf /usr/local/go
  tar -C /usr/local -xzf "${TMPDL}/${TARBALL}"
  rm -rf "$TMPDL"
fi
export PATH=/usr/local/go/bin:$PATH

# ───── 4. xcaddy ─────
if ! command -v xcaddy >/dev/null; then
  log "Installing xcaddy ${XCADDY_VERSION}"
  GOBIN=/usr/local/bin go install "github.com/caddyserver/xcaddy/cmd/xcaddy@${XCADDY_VERSION}"
fi
log "xcaddy: $(xcaddy version 2>&1 | head -1 || echo present)"

# ───── 5. Build caddy + forwardproxy@naive ─────
#
# The replacement target on the LEFT MUST be
# `github.com/caddyserver/forwardproxy@caddy2` (the module path Caddy v2
# expects), not plain `github.com/caddyserver/forwardproxy`. Without the
# @caddy2 suffix xcaddy still produces a binary, but the forward_proxy
# handler never registers: `caddy list-modules` shows nothing under
# http.handlers.forward_proxy and runtime fails silently. Caught in prod
# on a second xcaddy build, when the module cache resolved a different
# inner version than the first attempt and exposed the missing suffix.
#
# We reference the `@naive` BRANCH (not a v2.x tag) because klzgrad's repo
# doesn't follow the Go-modules /v2 path convention: Go semver rejects
# tags >= v2.0 unless the module path ends in /v2. A branch reference
# resolves to a pseudo-version that bypasses semver strict mode, which is
# what the NaiveProxy ArchWiki and klzgrad/forwardproxy README document.
log "Building Caddy + klzgrad/forwardproxy@naive plugin -> $CADDY_NAIVE_BIN"

# Clear stale module cache from prior failed builds; otherwise `go build`
# can keep resolving to a half-baked older entry.
rm -rf "${GOPATH:-$HOME/go}/pkg/mod/cache/download/github.com/klzgrad" 2>/dev/null || true

WORKDIR=$(mktemp -d)
pushd "$WORKDIR" > /dev/null
xcaddy build \
  --with 'github.com/caddyserver/forwardproxy@caddy2=github.com/klzgrad/forwardproxy@naive' \
  --output "$CADDY_NAIVE_BIN"
popd > /dev/null
rm -rf "$WORKDIR"
chmod +x "$CADDY_NAIVE_BIN"

# ───── 6. Verify ─────
if ! "$CADDY_NAIVE_BIN" version >/dev/null; then
  fail "$CADDY_NAIVE_BIN is not executable; build failed."
fi
log "$CADDY_NAIVE_BIN $(${CADDY_NAIVE_BIN} version | head -1)"

# Confirm the naive plugin got linked in.
if ! "$CADDY_NAIVE_BIN" list-modules 2>/dev/null | grep -q '^http\.handlers\.forward_proxy$'; then
  warn "forward_proxy module not present in built Caddy; build was misconfigured."
  exit 1
fi
log "✓ forward_proxy module is linked"

# ───── 7. Summary ─────
echo
log "✓ Caddy + NaiveProxy fork is ready."
echo
echo "Next steps:"
echo "  - Open the inbound's TCP port (default :443) in the firewall."
echo "  - Point the DNS A-record at this VPS so Caddy can auto-fetch LE certs"
echo "    via tls-alpn-01 / http-01."
echo "  - Start the Iceslab node-agent; it will write the Caddyfile and reload."
echo
warn "NaiveProxy bumps Chromium roughly every 30 days. Re-run this script"
warn "periodically; a stale TLS fingerprint is easier to fingerprint."
