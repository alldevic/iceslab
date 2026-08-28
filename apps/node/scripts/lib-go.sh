#!/usr/bin/env bash
# install_go — the one way a node gets a Go toolchain.
#
# Two things on a node need one: install-iceslab-node.sh compiles the agent
# that then runs as root, and bootstrap-naive.sh drives xcaddy. Until
# 2026-08-28 they each had their own copy of the version, the arch map, the
# floor check and the download — and only one of the two downloads was pinned.
# The other was
#
#   curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${GO_ARCH}.tar.gz"
#
# with no sha256 and with -L following the 302 that go.dev answers with, then
# untarred into /usr/local/go as root. That is precisely the shape
# lib-pinned-fetch.sh exists to remove, and its own header says the function
# "outlived its old call sites"; this was a call site it never reached.
#
# One decision, one place: the version, the checksums and the floor are all
# below, and both callers source this file.

# shellcheck source=lib-pinned-fetch.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib-pinned-fetch.sh"

# The pin has to be new enough to BUILD what the callers build, not merely to
# run `go`. Measured on a Debian 13 guest 2026-08-28 with the old 1.23.4 pin:
# xcaddy printed "github.com/caddyserver/caddy/v2@v2.11.4 requires go >= 1.25.1;
# switching to go1.26.7", downloaded go1.26.7 AND go1.25.1, and handed the
# compile to one of them — the toolchain we had verified decided nothing, and
# the node paid ~160 MB for it. 1.27.0 clears that floor, so the toolchain that
# lands in /usr/local/go is the one that does the work. Re-measured after the
# bump: no "switching to" line, and the naive install went 5m03s -> 2m38s.
#
# sha256 from https://go.dev/dl/?mode=json. Bump the three together.
GO_PINNED_VERSION=1.27.0
GO_SHA256_amd64=675c26c449cbb18fc24b74650de1eabbae6e16f64326fd85a283fb3b58280685
GO_SHA256_arm64=51798d2c42d0e1c6ed7fd9f48728b4193abac9e8aad6dbac2fe96a81f5909bda

# install_go
#
# No-op when the machine already has a Go at least as new as the pin. The floor
# IS the pinned version, deliberately: a separate, lower number (it used to be
# 1.22) lets a host's own older Go satisfy the check and then hand the compile
# to a toolchain Go downloads for itself, which is the same hole by another
# door. Callers may override GO_VERSION; doing so drops the checksum and the
# fetch says out loud that it verified nothing, the same wording
# bootstrap-{singbox,mtg,mieru}.sh use for their hand-run fallback.
install_go() {
  local go_version="${GO_VERSION:-$GO_PINNED_VERSION}"
  if command -v go >/dev/null; then
    local cur
    cur=$(go version | awk '{print $3}' | sed 's/^go//')
    if [[ "$(printf '%s\n' "$GO_PINNED_VERSION" "$cur" | sort -V | head -1)" == "$GO_PINNED_VERSION" ]]; then
      log "Go $cur already meets >= $GO_PINNED_VERSION"
      return 0
    fi
  fi

  local arch go_arch
  arch=$(dpkg --print-architecture)
  case "$arch" in
    amd64) go_arch=amd64 ;;
    arm64) go_arch=arm64 ;;
    *) fail "Unsupported arch for the Go toolchain: $arch" ;;
  esac

  local go_sha=""
  if [[ "$go_version" == "$GO_PINNED_VERSION" ]]; then
    eval "go_sha=\${GO_SHA256_${go_arch}:-}"
  else
    warn "GO_VERSION=$go_version is not the pinned $GO_PINNED_VERSION; the tarball will be fetched UNVERIFIED"
  fi

  log "Installing Go $go_version to /usr/local/go"
  local tmpdl tarball
  tmpdl=$(mktemp -d)
  tarball="go${go_version}.linux-${go_arch}.tar.gz"
  # dl.google.com, not go.dev/dl: the latter answers 302 and pinned_fetch
  # refuses to follow a redirect, which is the whole point of it — a redirect
  # is a second host getting to choose what lands in /usr/local/go. Measured
  # 2026-08-28: go.dev/dl/<tarball> -> 302, dl.google.com/go/<tarball> -> 200.
  pinned_fetch "https://dl.google.com/go/${tarball}" "${tmpdl}/${tarball}" "$go_sha"
  rm -rf /usr/local/go
  tar -C /usr/local -xzf "${tmpdl}/${tarball}"
  rm -rf "$tmpdl"
}
