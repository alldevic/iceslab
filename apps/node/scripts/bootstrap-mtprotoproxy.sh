#!/usr/bin/env bash
# Install alexbers/mtprotoproxy, the second MTProto engine, on a node.
#
# The node-agent spawns it as `python3 <script> <config>` when
# MTPROTOPROXY_SCRIPT is set. This script unpacks the pinned source, makes sure
# python3 can run it fast, and writes the mtprotoproxy block of the agent's env
# (lib/node-env.sh). The agent writes config.py itself on the panel's push, with
# the port of the inbound (2084 until one is pushed).
#
# It installs BESIDE mtg, not instead of it: two engines of one protocol, a
# profile picks one. Nothing here touches /usr/local/bin/mtg or /etc/mtg.
#
# This script does NOT open the proxy's port in a firewall: it is the port the
# profile's inbound names, which nothing knows at install time. Open that port
# (tcp) yourself once the profile is on the node.
#
# Idempotent, safe to rerun: the pinned source is unpacked and patched again
# each time, the env block is written either way. A node installed before the
# patch and the version file existed is brought up to date by running this again.
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
# every arch: it is Python source, GitHub's archive of the tag.
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
MPP_VERSION="${MTPROTOPROXY_VERSION:-$MTPROTOPROXY_PINNED_VERSION}"
MPP_VERSION="${MPP_VERSION#v}"

# ───── 1. Arch (only to ask the panel for the file) ─────
# The archive is the same for every arch; the panel keeps one entry per arch.
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  MPP_ARCH="amd64" ;;
  aarch64) MPP_ARCH="arm64" ;;
  armv7l)  MPP_ARCH="armv7" ;;
  *)       fail "Unsupported architecture: $ARCH" ;;
esac
WANT_SHA="${MTPROTOPROXY_SHA256:-${MTPROTOPROXY_PINNED_SHA256[$MPP_ARCH]:-}}"
[[ -n "$WANT_SHA" ]] || fail "no pinned checksum for mtprotoproxy $MPP_VERSION on $MPP_ARCH"
ARCHIVE="${MTPROTOPROXY_PINNED_FILE[$MPP_ARCH]:-}"
[[ -n "$ARCHIVE" ]] || fail "no pinned file for mtprotoproxy on $MPP_ARCH"
ARCHIVE="${ARCHIVE//"$MTPROTOPROXY_PINNED_VERSION"/$MPP_VERSION}"
TAG="${MTPROTOPROXY_PINNED_TAG//"$MTPROTOPROXY_PINNED_VERSION"/$MPP_VERSION}"

# ───── 2. Download and check ─────
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
DOWNLOAD_URL="https://github.com/alexbers/mtprotoproxy/archive/refs/tags/${TAG}.tar.gz"

# The panel first (lib/node-env.sh, ICESLAB_CORE_SOURCE); the check below is
# the same whichever way the file came, and comes before anything is unpacked.
if ! core_panel_artifact mtprotoproxy "$MPP_VERSION" "$MPP_ARCH" "$TMPDIR/$ARCHIVE" "$WANT_SHA"; then
  log "Downloading $DOWNLOAD_URL"
  curl -fsSL "$DOWNLOAD_URL" -o "$TMPDIR/$ARCHIVE" || fail "download failed: $DOWNLOAD_URL"
fi
GOT_SHA=$(sha256sum "$TMPDIR/$ARCHIVE" | awk '{print $1}')
[[ "$GOT_SHA" == "$WANT_SHA" ]] || fail "checksum mismatch for $ARCHIVE: got $GOT_SHA, expected $WANT_SHA"
log "Checksum OK ($GOT_SHA)"

# ───── 3. Python, and the AES backend that decides whether this is usable ─────
# mtprotoproxy picks cryptography, then pycryptodome, then the pure-Python
# pyaes it bundles, and on that last one it starts and serves at 0.4 MB/s
# (measured against 3777 MB/s with cryptography). The agent refuses to run it
# without a fast backend, so it is installed here, not discovered as "Telegram
# is slow". When it cannot be installed this stops: a node with an engine the
# agent will not start is worse than a node without it.
apt_install() {
  [[ -x /usr/bin/apt-get ]] || fail "no apt-get; install $* by hand, then rerun"
  apt_update || warn "apt-get update failed; trying the install on the lists there are"
  DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y "$@" >/dev/null \
    || fail "could not install $*"
}
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

mkdir -p "$TMPDIR/tree"
# --strip-components=1: the directory inside is named after the tag, and the
# agent's script path must not move with the version.
tar -xzf "$TMPDIR/$ARCHIVE" -C "$TMPDIR/tree" --strip-components=1
[[ -f "$TMPDIR/tree/mtprotoproxy.py" ]] || fail "mtprotoproxy.py not found in $ARCHIVE"

# ───── 4a. The patch: the datacenter table, and the counters that name a drop ─────
# Upstream's direct mode knows five datacenters and indexes them with
# `abs(dc) - 1`. Telegram also hands clients dc 203, a CDN datacenter and the
# one large public channels' media comes from, so that expression runs off the
# end of the list and the connection is dropped having sent no byte and logged
# no line: text works, media does not, and nothing says why. The patch adds the
# datacenter, a counter and a log line for an unknown one, and `connects_dropped`
# (with `connects_dropped_reason`) for a connection that named a user and then
# relayed nothing, which no upstream counter shows.
#
# Applied here rather than carried as a fork of the file: what the panel pins and
# serves stays byte-identical to upstream's archive, and the diff next to this
# script is the whole of what is added. It is written for the pinned tag: when
# the pin moves and the patch no longer applies, this stops (a node without the
# patch is the silence the patch removes) and the patch is re-issued with the pin.
if ! command -v patch >/dev/null 2>&1; then
  log "patch(1) not present; installing"
  apt_install patch
fi
PATCH_FILE="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/mtprotoproxy-cdn-datacenters.patch"
[[ -f "$PATCH_FILE" ]] || fail "missing $PATCH_FILE, which is not optional: without it dc 203 is dropped silently"
patch -p1 -d "$TMPDIR/tree" --forward < "$PATCH_FILE" \
  || fail "the datacenter patch did not apply to mtprotoproxy $MPP_VERSION; re-issue it against that version before shipping"
# Both halves are checked: `patch --forward` exits 0 on a hunk it judged already
# applied, and half a patch is the failure this step exists to prevent.
grep -q TG_EXTRA_DATACENTERS_V4 "$TMPDIR/tree/mtprotoproxy.py" \
  || fail "the patch reported success but the datacenter table is not in mtprotoproxy.py"
grep -q "def update_dropped" "$TMPDIR/tree/mtprotoproxy.py" \
  || fail "the patch reported success but the dropped-connection counter is not in mtprotoproxy.py"
log "Patched (dc 203, and counters for a connection that named a user and relayed nothing)"

# ───── 4b. Smoke-test ─────
# Compiled, not run: running would bind a port and dial Telegram. Compiled in
# memory, so nothing but the tree itself is written.
python3 -c 'import sys; compile(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1], "exec")' "$TMPDIR/tree/mtprotoproxy.py" \
  || fail "mtprotoproxy.py does not compile under python3 $PYVER"
log "Smoke-test passed: mtprotoproxy.py compiles under python3 $PYVER"

# ───── 5. Install ─────
# The version is written last before the tree moves, so it exists only for a tree
# whose checksum and patch both passed; the agent reads it as the engine's version
# (upstream has no version string of its own).
printf '%s\n' "$MPP_VERSION" > "$TMPDIR/tree/.iceslab-version"
# The running proxy keeps its open file; the agent restarts it on the next
# push or restart.
chown -R root:root "$TMPDIR/tree"
rm -rf "$INSTALL_DIR.new"
mv "$TMPDIR/tree" "$INSTALL_DIR.new"
rm -rf "$INSTALL_DIR"
mv "$INSTALL_DIR.new" "$INSTALL_DIR"
log "mtprotoproxy $MPP_VERSION installed to $INSTALL_DIR"

# ───── 6. Config dir ─────
# 0700: the agent writes every user's secret into config.py here.
mkdir -p "$CONFIG_DIR"
chmod 0700 "$CONFIG_DIR"
log "Created $CONFIG_DIR (mode 0700; node-agent will populate config.py on ApplyInbound)"

# ───── 7. Agent env ─────
wire_env
node_env_done mtprotoproxy
log "mtprotoproxy $MPP_VERSION is ready at $SCRIPT_PATH"
log "The proxy's port is the one the profile's inbound names (2084 until then); this script opens no firewall port: open it (tcp) yourself"
log "Migrating off mtg? A tg:// link is not a subscription, so saved mtg links stop working the moment mtg does. To keep them working set MTPROTOPROXY_ACCEPT_LEGACY=1 in the node env and give this engine mtg's port once mtg is stopped (the links name it); restart iceslab-node."
log "The old shared secret is then carried as the user legacy-mtg. Drop the flag and restart once its counter on the metrics port stops growing: that secret is held by everybody and owned by nobody."
