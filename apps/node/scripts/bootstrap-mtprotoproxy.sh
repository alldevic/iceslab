#!/usr/bin/env bash
# Install alexbers/mtprotoproxy — the multi-user MTProto proxy — on a node.
#
# The node-agent spawns it as `python3 <script> <config>` when
# MTPROTOPROXY_SCRIPT is set. This script places the source tree and makes sure
# the interpreter can actually run it fast; the agent writes config.py itself on
# ApplyInbound.
#
# It installs BESIDE mtg, not instead of it: the two are separate engines of the
# same protocol, an inbound picks one, and a fleet moving over needs both
# present for a while. Nothing here touches /usr/local/bin/mtg or /etc/mtg.
#
# Idempotent, safe to rerun.
set -euo pipefail

log()  { printf '\033[1;34m[bootstrap]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "Must be run as root (sudo bash $0)"

INSTALL_DIR=/opt/mtprotoproxy
SCRIPT_PATH="$INSTALL_DIR/mtprotoproxy.py"
CONFIG_DIR=/etc/mtprotoproxy

# ───── 1. Python, and the crypto backend that decides whether this is usable ─────
#
# mtprotoproxy picks its AES backend at startup: cryptography, then
# pycryptodome, then the pure-Python `pyaes` it bundles. On that last one it
# STARTS AND SERVES, printing a suggestion to the log — at 0.4 MB/s. Measured on
# a fleet node 2026-09-02 against 3777 MB/s with `cryptography`: four orders of
# magnitude, on a proxy that carries video.
#
# So this is not an optional nicety and the agent refuses to run without it. We
# install it here rather than leaving the node to discover the problem as
# "Telegram is slow".
command -v python3 >/dev/null 2>&1 || fail "python3 not found; install it first"
PYVER=$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')
log "python3 $PYVER"

if python3 -c 'import cryptography' 2>/dev/null; then
  log "AES backend: cryptography (fast)"
elif python3 -c 'import Crypto' 2>/dev/null; then
  log "AES backend: pycryptodome (fast)"
else
  log "No fast AES backend; installing python3-cryptography"
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get -qq update || true
    DEBIAN_FRONTEND=noninteractive apt-get -qq install -y python3-cryptography \
      || fail "could not install python3-cryptography"
  else
    fail "no apt-get; install a cryptography module for python3 by hand, then rerun"
  fi
  python3 -c 'import cryptography' 2>/dev/null \
    || fail "python3-cryptography installed but not importable"
  log "AES backend: cryptography (fast)"
fi

# ───── 2. The artefact ─────
#
# ICESLAB_CORE_ARTEFACT is the tarball the node installer fetched FROM THE PANEL
# and verified against the sha256 pinned in core-binaries.ts. Same path every
# other core takes; upstream attaches no release files, so what the panel serves
# is GitHub's generated source tarball, byte-identical to what it published.
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

if [[ -n "${ICESLAB_CORE_ARTEFACT:-}" ]]; then
  [[ -f "$ICESLAB_CORE_ARTEFACT" ]] || fail "ICESLAB_CORE_ARTEFACT is set to $ICESLAB_CORE_ARTEFACT, which is not a file"
  cp "$ICESLAB_CORE_ARTEFACT" "$TMPDIR/src.tar.gz"
  log "Using the panel-verified mtprotoproxy artefact"
else
  warn "no panel artefact given: falling back to GitHub, UNVERIFIED"
  VER="${MTPROTOPROXY_VERSION:-1.1.2}"
  curl -fsSL "https://github.com/alexbers/mtprotoproxy/archive/refs/tags/v${VER}.tar.gz" \
    -o "$TMPDIR/src.tar.gz" || fail "download failed"
fi

# --strip-components=1 because the directory inside is named after the tag, and
# the agent is configured with an absolute script path that must not move when
# the version does.
mkdir -p "$INSTALL_DIR"
tar -xzf "$TMPDIR/src.tar.gz" -C "$INSTALL_DIR" --strip-components=1
[[ -f "$SCRIPT_PATH" ]] || fail "mtprotoproxy.py not found after unpacking"
[[ -d "$INSTALL_DIR/pyaes" ]] || warn "bundled pyaes missing; harmless while a fast backend is present"

# ───── 3. Smoke-test ─────
#
# Compile it rather than run it: running would bind a port and try to reach
# Telegram. A syntax error against this interpreter is what we are looking for,
# and py_compile finds that without side effects.
python3 -m py_compile "$SCRIPT_PATH" || fail "mtprotoproxy.py does not compile under python3 $PYVER"
log "Smoke-test passed (compiles under python3 $PYVER)"

# ───── 4. Config dir ─────
#
# 0700: the agent writes every user's MTProto secret into config.py here.
mkdir -p "$CONFIG_DIR"
chmod 0700 "$CONFIG_DIR"
log "Created $CONFIG_DIR (mode 0700; the agent writes config.py on ApplyInbound)"

# ───── 5. Summary ─────
echo
log "mtprotoproxy is ready."
echo "    Script:  $SCRIPT_PATH"
# No version line on purpose. --strip-components=1 drops the tag-named
# directory, and upstream ships no version string anywhere in the source, so
# anything printed here would be a guess. The panel knows which version it
# pinned; the node does not, and the adapter's CoreVersion says so by returning
# empty rather than reporting the Python version as if it were the proxy's.
echo
echo "Set the following in /etc/iceslab-node/env then restart node-agent:"
echo "    MTPROTOPROXY_SCRIPT=$SCRIPT_PATH"
echo "    MTPROTOPROXY_CONFIG=$CONFIG_DIR/config.py"
echo "    MTPROTOPROXY_PORT=2084          # NOT mtg's port; both engines can run"
echo "    MTPROTOPROXY_METRICS_PORT=3130  # NOT mtg's 3129, same reason"
echo "Then: systemctl restart iceslab-node"
echo
echo "MIGRATING OFF mtg? A tg:// link is not a subscription — the client stored a"
echo "secret and has nothing to re-fetch, so every buyer's saved proxy stops"
echo "working the moment mtg does. To keep them working:"
echo "    MTPROTOPROXY_ACCEPT_LEGACY=1"
echo "and give this engine mtg's PORT once you stop mtg, because the saved links"
echo "name it. Watch user=\"legacy-mtg\" on the metrics port; when it stops"
echo "moving, everybody has a personal link — drop the flag and restart."
echo
echo "The inbound picks this engine with \`engine: mtprotoproxy\` on its profile."
