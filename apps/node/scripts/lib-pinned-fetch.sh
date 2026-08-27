#!/usr/bin/env bash
# pinned_fetch — the one way anything on a node downloads from a third party.
#
# History, because the shape of it explains what this is for. Hysteria and Xray
# were once installed by running upstream INSTALLER SCRIPTS — `bash <(curl
# get.hy2.sh)` and `XTLS/Xray-install/raw/main/...` — unpinned, executing
# whatever those hosts served at that moment, as root. Since 2026-08-28 the
# proxy cores come from the panel instead (`panel_core_fetch` in
# scripts/install-iceslab-node.sh): pinned by version and sha256 in
# packages/shared/src/core-binaries.ts and verified when the panel image was
# built. There is deliberately no fallback to upstream for those.
#
# What the panel cannot carry is a build toolchain. bootstrap-naive.sh compiles
# Caddy with xcaddy and needs a Go tarball from Google; that download is what
# this function is for, and it is why the function outlived its old call sites
# instead of being deleted with them.
#
# Sourced, not copied. It lived inside install-iceslab-node.sh as an unused
# function while the script that actually needed it fetched with a bare `curl
# -fsSL` twenty lines away — two spellings of one decision, the shape this fork
# keeps finding. The caller must already define `log` and `fail`; every
# bootstrap in this directory does.

# pinned_fetch <url> <out-path> [<expected-sha256>]
# Fetches a URL over HTTPS with no redirects, optionally verifying the
# sha256. --proto =https blocks accidental http:// downgrade; --max-redirs 0
# closes the MITM-via-302 vector. Refuses to write if sha mismatches.
#
# --max-redirs 0 is a real constraint on the URL, not a formality: a download
# page that bounces to a CDN (go.dev/dl/... 302s to dl.google.com) is refused
# here, so callers must name the host that actually serves the bytes. That is
# the point — a redirect is a second host getting to choose what you install.
pinned_fetch() {
  local url="$1" out="$2" expect_sha="${3:-}"
  curl --proto '=https' --max-redirs 0 -fsSL "$url" -o "$out" || {
    fail "pinned_fetch: download failed: $url"
  }
  if [[ -n "$expect_sha" ]]; then
    local actual_sha
    actual_sha=$(sha256sum "$out" | awk '{print $1}')
    if [[ "$actual_sha" != "$expect_sha" ]]; then
      rm -f "$out"
      fail "pinned_fetch: sha256 mismatch for $url (expected $expect_sha, got $actual_sha): upstream tampered or you need to bump the pin"
    fi
    log "pinned_fetch: sha256 verified for $(basename "$out")"
  else
    log "pinned_fetch: $(basename "$out") fetched (tag-pinned, sha256 NOT verified; set the *_SHA env to harden)"
  fi
}

# pinned_clone <repo-url> <tag> <expected-commit-sha> <dest>
# A shallow clone of a TAG, checked against the commit that tag is supposed to
# point at. A tag is a mutable pointer: upstream can move it, and `git clone
# --branch v1.2.3` will happily bring back whatever it points at today. This is
# the git-shaped half of the same guarantee sha256 gives a tarball.
#
# An empty expected sha fetches the tag and says so, matching pinned_fetch's
# behaviour with no sha.
pinned_clone() {
  local repo="$1" tag="$2" expect_sha="${3:-}" dest="$4"
  rm -rf "$dest"
  git clone --depth 1 --branch "$tag" "$repo" "$dest" || {
    fail "pinned_clone: clone failed: $repo @ $tag"
  }
  local actual_sha
  actual_sha=$(git -C "$dest" rev-parse HEAD)
  if [[ -n "$expect_sha" ]]; then
    if [[ "$actual_sha" != "$expect_sha" ]]; then
      rm -rf "$dest"
      fail "pinned_clone: $repo tag $tag is commit $actual_sha, not the pinned $expect_sha: the tag was moved upstream, or you need to bump the pin"
    fi
    log "pinned_clone: $repo @ $tag verified at $actual_sha"
  else
    log "pinned_clone: $repo @ $tag is $actual_sha (tag-pinned, commit NOT verified)"
  fi
}
