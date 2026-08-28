#!/usr/bin/env bash
# Provision a fresh Ubuntu/Debian VPS to run an AmneziaWG inbound.
#
# Installation strategy: DKMS from the upstream GitHub source, plus awg-tools
# built from source. One path on every supported release. There used to be a
# second one - ppa:amnezia/amneziawg on Ubuntu jammy and earlier - and it is
# gone, which matters because the package that path needed outlived it below.
#
# Idempotent, safe to rerun.
set -euo pipefail

log()  { printf '\033[1;34m[bootstrap]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "Must be run as root (sudo bash $0)"

# shellcheck source=lib-pinned-fetch.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib-pinned-fetch.sh"

# ───── 1. Distro check ─────
[[ -r /etc/os-release ]] || fail "Cannot read /etc/os-release; unsupported distro"
. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) ;;
  *) fail "Only Ubuntu/Debian supported. Detected ID=${ID:-unknown}." ;;
esac
log "Detected $PRETTY_NAME"

# ───── 2. Prereqs ─────
log "Installing apt prereqs"
DEBIAN_FRONTEND=noninteractive apt-get update -y
# `software-properties-common` was here for `add-apt-repository`, which only
# the deleted PPA path ever called. Debian 13 (trixie) dropped the package
# altogether, so the line that nothing needed was also the line that made
# `--protocol amneziawg` impossible on a distro this installer prints as
# supported: apt exits 100 with "Unable to locate package", `set -e` takes the
# script down, and the failure lands in step 4 of 8 with the agent already
# built. Measured on a trixie guest 2026-08-28 - `apt-cache stats` had 161831
# package names and not that one.
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  gnupg ca-certificates curl \
  build-essential dkms git libmnl-dev pkg-config wireguard-tools

KERNEL_VER=$(uname -r)
log "Running kernel: $KERNEL_VER"
DEBIAN_FRONTEND=noninteractive apt-get install -y "linux-headers-${KERNEL_VER}" || \
  warn "linux-headers-${KERNEL_VER} not found, DKMS build may fail"

# ───── 3. Kernel module via DKMS ─────
AWG_MODULE_REPO=https://github.com/amnezia-vpn/amneziawg-linux-kernel-module.git
# Pin a tagged release instead of tracking master: reproducible node builds, and
# a guard against an upstream master change silently breaking provisioning under
# us. This tag is v2.0-capable and carries the use-after-free fixes (it is well
# past v1.0.20260329). Bump deliberately after smoke-testing a newer tag.
AWG_MODULE_TAG=v1.0.20260611
# The commit that tag points at, checked after the clone. A tag is a mutable
# pointer — `git clone --branch v1.0.20260611` brings back whatever it points
# at TODAY, and this repo is compiled into a kernel module and loaded as root.
# Resolved against the upstream tag on 2026-08-28 and confirmed by cloning it.
AWG_MODULE_COMMIT=2a6e1a02ac024f54a23e18f894a279b7f870b8fb
AWG_MODULE_DIR=/usr/src/amneziawg-src

if lsmod | grep -q '^amneziawg\b'; then
  log "amneziawg kernel module already loaded, skipping module install"
else
  log "Installing amneziawg kernel module via DKMS from $AWG_MODULE_REPO"

  # Fresh shallow clone pinned to a tagged release AND to the commit that tag
  # resolved to when the pin was taken (see AWG_MODULE_COMMIT above).
  pinned_clone "$AWG_MODULE_REPO" "$AWG_MODULE_TAG" "$AWG_MODULE_COMMIT" "$AWG_MODULE_DIR"

  # dkms.conf may be at root or one level deep
  DKMS_CONF=$(find "$AWG_MODULE_DIR" -maxdepth 2 -name 'dkms.conf' | head -1)
  if [[ -z "$DKMS_CONF" ]]; then
    fail "dkms.conf not found in $AWG_MODULE_DIR (repo structure may have changed)"
  fi
  log "Found dkms.conf at: $DKMS_CONF"

  # Parse version, fall back to a known good one
  AWG_VER=$(grep 'PACKAGE_VERSION' "$DKMS_CONF" | head -1 | grep -oP '"[^"]+"' | tr -d '"')
  if [[ -z "$AWG_VER" ]]; then
    AWG_VER="1.0.0"
    warn "Could not parse version from dkms.conf, using fallback $AWG_VER"
  fi
  log "amneziawg module version: $AWG_VER"

  # DKMS requires source in /usr/src/<name>-<version>/
  DKMS_SRC="/usr/src/amneziawg-${AWG_VER}"
  DKMS_ROOT=$(dirname "$DKMS_CONF")
  rm -rf "$DKMS_SRC"
  mkdir -p "$DKMS_SRC"
  cp -r "$DKMS_ROOT"/. "$DKMS_SRC/"

  # Remove stale DKMS entries then add/build/install
  dkms remove "amneziawg/${AWG_VER}" --all 2>/dev/null || true
  dkms add "amneziawg/${AWG_VER}"
  dkms build "amneziawg/${AWG_VER}"
  dkms install "amneziawg/${AWG_VER}"

  log "Loading amneziawg kernel module"
  modprobe amneziawg || warn "modprobe amneziawg failed, try rebooting"
fi

# ───── 4. AWG userspace tools ─────
AWG_TOOLS_REPO=https://github.com/amnezia-vpn/amneziawg-tools.git
# Pinned for the same reproducibility reason as the kernel module above.
AWG_TOOLS_TAG=v1.0.20260618
# Same reasoning as AWG_MODULE_COMMIT: taken and confirmed by clone 2026-08-28.
AWG_TOOLS_COMMIT=4cdc357c68b39a0d1e19417b7f03d604c1e1b4cf
AWG_TOOLS_DIR=/usr/src/amneziawg-tools-build

if command -v awg >/dev/null && command -v awg-quick >/dev/null; then
  log "awg tools already installed: $(awg --version 2>&1 | head -1)"
else
  log "Building amneziawg-tools from $AWG_TOOLS_REPO"

  pinned_clone "$AWG_TOOLS_REPO" "$AWG_TOOLS_TAG" "$AWG_TOOLS_COMMIT" "$AWG_TOOLS_DIR"

  make -C "$AWG_TOOLS_DIR/src" -j"$(nproc)"
  make -C "$AWG_TOOLS_DIR/src" install

  log "awg: $(awg --version 2>&1 | head -1)"
  log "awg-quick: $(command -v awg-quick)"
fi

# ───── 5. Verify ─────
command -v awg     >/dev/null || fail "awg binary not found after install"
command -v awg-quick >/dev/null || fail "awg-quick binary not found after install"

DKMS_OK=true
if ! lsmod | grep -q '^amneziawg\b'; then
  warn "amneziawg module not loaded, DKMS build may have failed or reboot needed"
  DKMS_OK=false
fi

# ───── 6. IP forwarding ─────
SYSCTL_CONF=/etc/sysctl.d/99-awg.conf
if [[ ! -f "$SYSCTL_CONF" ]]; then
  log "Enabling IP forwarding"
  echo "net.ipv4.ip_forward=1" > "$SYSCTL_CONF"
  echo "net.ipv6.conf.all.forwarding=1" >> "$SYSCTL_CONF"
  sysctl --system >/dev/null
fi

# ───── 7. Summary ─────
echo
if $DKMS_OK; then
  log "AmneziaWG kernel-mode is ready."
  echo "    Module: $(modinfo amneziawg 2>/dev/null | grep '^version' | head -1 || echo 'loaded')"
else
  warn "Kernel module is NOT loaded. Try rebooting, then 'modprobe amneziawg'."
  warn "Or use amneziawg-go (userspace, ~30 Mbps): https://github.com/amnezia-vpn/amneziawg-go"
fi
