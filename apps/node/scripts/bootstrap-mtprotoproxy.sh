#!/usr/bin/env bash
# Install alexbers/mtprotoproxy, the second MTProto engine, on a node.
#
# The node-agent spawns it as `python3 <script> <config>` when
# MTPROTOPROXY_SCRIPT is set. This script unpacks the pinned source, patches it
# (see 3.), makes sure python3 can run it fast, records the version, and writes
# the mtprotoproxy block of the agent's env (lib/node-env.sh). The agent
# writes config.py itself on the panel's push.
#
# It installs BESIDE mtg, not instead of it: two engines of one protocol, a
# profile picks one. Nothing here touches /usr/local/bin/mtg or /etc/mtg.
#
# Idempotent, safe to rerun: a node already on the pinned version keeps its
# tree; the env block is written either way.
#
# Flags:
#   --restart-agent  restart iceslab-node at the end
#   --remove         take mtprotoproxy off the node instead (refused while it runs)
#
# Env overrides (both or neither: a version nobody checked has no checksum):
#   MTPROTOPROXY_VERSION  release to install instead of the pin, e.g. 1.1.2
#   MTPROTOPROXY_SHA256   sha256 of GitHub's v<version>.tar.gz for that tag
set -euo pipefail

log()  { printf '\033[1;34m[bootstrap]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

# shellcheck source=lib/node-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/node-env.sh"
node_env_flags "$@" || fail "usage: $0 [--restart-agent] [--remove]"

[[ $EUID -eq 0 ]] || fail "Must be run as root (sudo bash $0)"

INSTALL_DIR=/opt/mtprotoproxy
SCRIPT_PATH=/opt/mtprotoproxy/mtprotoproxy.py
# What CoreVersion reports: upstream carries no version string anywhere.
VERSION_FILE=/opt/mtprotoproxy/.iceslab-version
CONFIG_DIR=/etc/mtprotoproxy
CONFIG_PATH=/etc/mtprotoproxy/config.py

# Port, metrics port and the Fake-TLS domain have defaults in the agent and
# come from the panel's push; only what registers the adapter is written here.
wire_env() {
  node_env_block mtprotoproxy \
    "MTPROTOPROXY_SCRIPT=$SCRIPT_PATH" \
    "MTPROTOPROXY_CONFIG=$(node_env_keep MTPROTOPROXY_CONFIG "$CONFIG_PATH")"
}

unwire_env() {
  node_env_unblock mtprotoproxy MTPROTOPROXY_SCRIPT MTPROTOPROXY_CONFIG MTPROTOPROXY_PYTHON \
    MTPROTOPROXY_PORT MTPROTOPROXY_METRICS_PORT MTPROTOPROXY_DOMAIN MTPROTOPROXY_ACCEPT_LEGACY
}

# The proxy runs as python3, so it is found by its script, not by name.
running_pids() {
  local pids
  pids="$(pgrep -f "$SCRIPT_PATH" 2>/dev/null | tr '\n' ' ' || true)"
  pids="${pids% }"
  [[ -n "$pids" ]] && printf 'mtprotoproxy pid %s' "$pids"
  return 0
}

# --remove: the tree and the config the agent rendered (every user's secret).
# Kept: the config dir itself, which the agent's unit lists as writable.
remove_core() {
  local config
  config="$(node_env_keep MTPROTOPROXY_CONFIG "$CONFIG_PATH")"
  node_env_refuse_if_running mtprotoproxy "$(running_pids)"
  rm -rf "$INSTALL_DIR"
  rm -f "$config"
  unwire_env
  log "mtprotoproxy removed"
}

if [[ "$NODE_ENV_REMOVE" == 1 ]]; then
  remove_core
  node_env_done mtprotoproxy
  exit 0
fi

# ───── pinned version ─────
# The pin and its sha256 come from the version manifest
# (packages/shared/src/core-versions.ts), in the block below. One file for
# every arch: it is Python source.
# >>> core-pins:mtprotoproxy >>>
# Generated from packages/shared/src/core-versions.ts, do not edit by hand:
# change the manifest, then run core-pins.test.ts with UPDATE_CORE_PINS=1.
MTPROTOPROXY_PINNED_VERSION="1.1.2"
MTPROTOPROXY_PINNED_TAG="v1.1.2"
declare -A MTPROTOPROXY_PINNED_FILE=(
  [amd64]="v1.1.2.tar.gz"
  [arm64]="v1.1.2.tar.gz"
  [armv7]="v1.1.2.tar.gz"
)
declare -A MTPROTOPROXY_PINNED_SHA256=(
  [amd64]="4082ea3875fa524b6c8f3d08208938cdf867a79c2bf99ceda85d57dece868702"
  [arm64]="4082ea3875fa524b6c8f3d08208938cdf867a79c2bf99ceda85d57dece868702"
  [armv7]="4082ea3875fa524b6c8f3d08208938cdf867a79c2bf99ceda85d57dece868702"
)
# <<< core-pins:mtprotoproxy <<<

if [[ -n "${MTPROTOPROXY_VERSION:-}" && -z "${MTPROTOPROXY_SHA256:-}" ]] || [[ -z "${MTPROTOPROXY_VERSION:-}" && -n "${MTPROTOPROXY_SHA256:-}" ]]; then
  fail "MTPROTOPROXY_VERSION and MTPROTOPROXY_SHA256 go together: a version without its checksum is not installed"
fi
WANT_VERSION="${MTPROTOPROXY_VERSION:-$MTPROTOPROXY_PINNED_VERSION}"
WANT_VERSION="${WANT_VERSION#v}"
WANT_SHA="${MTPROTOPROXY_SHA256:-${MTPROTOPROXY_PINNED_SHA256[amd64]}}"
TAG="${MTPROTOPROXY_PINNED_TAG//"$MTPROTOPROXY_PINNED_VERSION"/$WANT_VERSION}"

apt_install() {
  command -v apt-get >/dev/null 2>&1 || fail "no apt-get; install $* by hand, then rerun"
  # Wait for unattended-upgrades instead of failing on its lock.
  DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 -qq update || true
  DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 -qq install -y "$@" \
    || fail "could not install $*"
}

# ───── 1. Python, and the AES backend that decides whether this is usable ─────
# mtprotoproxy picks cryptography, then pycryptodome, then the pure-Python
# pyaes it bundles, and on that last one it starts and serves at 0.4 MB/s
# (measured against 3777 MB/s with cryptography). The agent refuses to run it
# without a fast backend, so it is installed here, not discovered as "Telegram
# is slow".
command -v python3 >/dev/null 2>&1 || apt_install python3
PYVER=$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')
if python3 -c 'import cryptography' 2>/dev/null; then
  log "python3 $PYVER, AES backend: cryptography"
elif python3 -c 'import Crypto' 2>/dev/null; then
  log "python3 $PYVER, AES backend: pycryptodome"
else
  log "python3 $PYVER has no fast AES backend; installing python3-cryptography"
  apt_install python3-cryptography
  python3 -c 'import cryptography' 2>/dev/null || fail "python3-cryptography installed but not importable"
fi

# ───── 2. Already on the wanted version? ─────
if [[ -f "$SCRIPT_PATH" && "$(cat "$VERSION_FILE" 2>/dev/null)" == "$WANT_VERSION" ]]; then
  log "mtprotoproxy $WANT_VERSION is already installed, which is the wanted version"
else
  # ───── 3. Download, check, patch ─────
  TMPDIR=$(mktemp -d)
  trap 'rm -rf "$TMPDIR"' EXIT
  URL="https://github.com/alexbers/mtprotoproxy/archive/refs/tags/${TAG}.tar.gz"
  log "Downloading $URL"
  curl -fsSL "$URL" -o "$TMPDIR/src.tar.gz" || fail "download failed: $URL"
  GOT_SHA=$(sha256sum "$TMPDIR/src.tar.gz" | awk '{print $1}')
  [[ "$GOT_SHA" == "$WANT_SHA" ]] || fail "checksum mismatch: got $GOT_SHA, expected $WANT_SHA"
  log "Checksum OK ($GOT_SHA)"
  mkdir -p "$TMPDIR/tree"
  # --strip-components=1: the directory inside is named after the tag, and the
  # agent's script path must not move with the version.
  tar -xzf "$TMPDIR/src.tar.gz" -C "$TMPDIR/tree" --strip-components=1
  [[ -f "$TMPDIR/tree/mtprotoproxy.py" ]] || fail "mtprotoproxy.py not found in the tarball"

  # Upstream's direct mode knows five datacenters and indexes them with
  # `abs(dc) - 1`; Telegram also hands out dc 203 (a CDN datacenter, where
  # large channels' media lives), the index runs off the list and the
  # connection drops having sent nothing and logged nothing: text works, media
  # does not. The patch adds that datacenter and a counter for a connection
  # that named a user and relayed nothing. Kept as a diff so what is pinned
  # stays byte-identical to upstream. One that does not apply is fatal: the
  # pinned version moved those lines.
  command -v patch >/dev/null 2>&1 || apt_install patch
  PATCH_FILE="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/mtprotoproxy-cdn-datacenters.patch"
  [[ -f "$PATCH_FILE" ]] || fail "missing $PATCH_FILE; without it dc 203 is dropped silently"
  patch -p1 -d "$TMPDIR/tree" --forward <"$PATCH_FILE" \
    || fail "the datacenter patch did not apply to mtprotoproxy $WANT_VERSION; re-pin it against this version"
  grep -q TG_EXTRA_DATACENTERS_V4 "$TMPDIR/tree/mtprotoproxy.py" \
    || fail "the patch reported success but the datacenter table is not there"
  grep -q "def update_dropped" "$TMPDIR/tree/mtprotoproxy.py" \
    || fail "the patch reported success but the dropped-connection counter is not there"

  # Compiled, not run: running would bind a port and dial Telegram.
  python3 -m py_compile "$TMPDIR/tree/mtprotoproxy.py" \
    || fail "mtprotoproxy.py does not compile under python3 $PYVER"
  printf '%s\n' "$WANT_VERSION" >"$TMPDIR/tree/.iceslab-version"

  # ───── 4. Install ─────
  # The running proxy keeps its open file; the agent restarts it on the next
  # push or restart.
  chown -R root:root "$TMPDIR/tree"
  rm -rf "$INSTALL_DIR.new"
  mv "$TMPDIR/tree" "$INSTALL_DIR.new"
  rm -rf "$INSTALL_DIR"
  mv "$INSTALL_DIR.new" "$INSTALL_DIR"
  log "mtprotoproxy $WANT_VERSION installed to $INSTALL_DIR"
fi

# ───── 5. Config dir ─────
# 0700: the agent writes every user's secret into config.py here.
mkdir -p "$CONFIG_DIR"
chmod 0700 "$CONFIG_DIR"

# ───── 6. Agent env ─────
wire_env
node_env_done mtprotoproxy
log "mtprotoproxy $WANT_VERSION is ready at $SCRIPT_PATH"
