#!/usr/bin/env bash
# Install the Mieru server (`mita`) on a fresh Ubuntu/Debian VPS.
#
# The node-agent (iceslab-node) invokes `mita apply config <path>` and
# `mita reload` to manage user lists. mita runs as its own systemd
# service on most installs (the package handles that); here we only
# lay down the binary.
#
# Idempotent, safe to rerun.
set -euo pipefail

log()  { printf '\033[1;34m[bootstrap]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "Must be run as root (sudo bash $0)"

INSTALL_DIR=/usr/local/bin

# ───── 1. Already installed? ─────
if [[ -x "$INSTALL_DIR/mita" ]]; then
  CURRENT=$("$INSTALL_DIR/mita" version 2>&1 | head -1 || echo "unknown")
  log "mita already installed: $CURRENT (skipping download)"
  log "To upgrade, remove $INSTALL_DIR/mita and rerun."
  exit 0
fi

# ───── 2. Detect arch ─────
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  M_ARCH="amd64" ;;
  aarch64) M_ARCH="arm64" ;;
  armv7l)  M_ARCH="armv7" ;;
  *)       fail "Unsupported architecture: $ARCH" ;;
esac
log "Detected arch: $ARCH → $M_ARCH"

# ───── 3. The artefact ─────
#
# ICESLAB_CORE_ARTEFACT is a .deb the node installer already fetched from the
# panel and verified against the pinned sha256. Without it this falls back to
# GitHub "latest", unverified — kept for a hand-run on a node with no panel,
# and it says so.
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

if [[ -n "${ICESLAB_CORE_ARTEFACT:-}" ]]; then
  [[ -f "$ICESLAB_CORE_ARTEFACT" ]] || fail "ICESLAB_CORE_ARTEFACT is set to $ICESLAB_CORE_ARTEFACT, which is not a file"
  DEB="mita.deb"
  cp "$ICESLAB_CORE_ARTEFACT" "$TMPDIR/$DEB"
  log "Using the panel-verified mita artefact"
else
  warn "no panel artefact given: falling back to GitHub 'latest', UNVERIFIED"
  log "Resolving latest mieru release..."
  LATEST_TAG=$(curl -fsSL https://api.github.com/repos/enfein/mieru/releases/latest \
    | grep '"tag_name"' | head -1 | sed -E 's/.*"v?([^"]+)".*/\1/')
  [[ -n "$LATEST_TAG" ]] || fail "Could not resolve latest mieru release tag from GitHub API"
  DEB="mita_${LATEST_TAG}_${M_ARCH}.deb"
  log "Downloading https://github.com/enfein/mieru/releases/download/v${LATEST_TAG}/${DEB}"
  curl -fsSL --progress-bar "https://github.com/enfein/mieru/releases/download/v${LATEST_TAG}/${DEB}" -o "$TMPDIR/$DEB"
fi

# ───── 5. Install via dpkg ─────
log "Installing $DEB via dpkg..."
dpkg -i "$TMPDIR/$DEB" || {
  warn "dpkg returned non-zero, running apt-get install -f to fix deps"
  apt-get install -f -y
}

# ───── 6. Smoke-test ─────
"$INSTALL_DIR/mita" version >/dev/null 2>&1 || fail "smoke test failed"
log "Smoke-test passed"

# ───── 7. Make /etc/mita writable by node-agent ─────
mkdir -p /etc/mita
chmod 0700 /etc/mita
log "Created /etc/mita (mode 0700; node-agent will populate server.yaml on ApplyInbound)"

# ───── 8. Summary ─────
echo
log "mita is ready."
echo "    Binary:  $INSTALL_DIR/mita"
echo "    Version: $LATEST_TAG"
echo
echo "Set the following in /etc/iceslab-node/env then restart node-agent:"
echo "    MITA_BINARY=$INSTALL_DIR/mita"
echo "    MITA_CONFIG=/etc/mita/server.json"
echo "    MITA_PORT=2012"
echo "    MITA_MTU=1400        # min 1280; drop to 1280 on PPPoE / odd VPN paths"
echo "Then: systemctl restart iceslab-node"
echo
warn "If your distro doesn't ship a mita systemd unit by default, the .deb"
warn "should install one. Check: systemctl status mita"
