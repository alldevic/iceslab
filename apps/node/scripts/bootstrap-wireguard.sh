#!/usr/bin/env bash
# Provision a fresh Ubuntu/Debian VPS to run a plain WireGuard inbound.
#
# Much smaller job than its AmneziaWG sibling: the WireGuard kernel module has
# been in-tree since Linux 5.6, so there is no DKMS build, no kernel headers,
# and no reboot dance — `wireguard-tools` supplies `wg` / `wg-quick` and the
# module loads on demand.
#
# The two can coexist on one host: separate interfaces (wg0 vs awg0), separate
# config directories, separate UDP ports.
#
# Idempotent, safe to rerun.
set -euo pipefail

log()  { printf '\033[1;34m[bootstrap]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "Must be run as root (sudo bash $0)"

# shellcheck source=lib-apt.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib-apt.sh"

# ───── 1. Distro check ─────
[[ -r /etc/os-release ]] || fail "Cannot read /etc/os-release; unsupported distro"
. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) ;;
  *) fail "Only Ubuntu/Debian supported. Detected ID=${ID:-unknown}." ;;
esac
log "Detected $PRETTY_NAME"

# ───── 2. Userspace tools ─────
if command -v wg >/dev/null && command -v wg-quick >/dev/null; then
  log "wireguard-tools already installed: $(wg --version 2>&1 | head -1)"
else
  log "Installing wireguard-tools"
  apt_get update -y
  apt_get install -y wireguard-tools
fi

command -v wg       >/dev/null || fail "wg binary not found after install"
command -v wg-quick >/dev/null || fail "wg-quick binary not found after install"

# ───── 3. Kernel module ─────
# In-tree since 5.6, so `modprobe` is normally a no-op that just pins it. A
# container or a stripped kernel can still lack it, in which case wg-quick
# falls back to the userspace wireguard-go if that is installed; we warn
# rather than fail so the agent still registers and the operator sees why.
KERNEL_VER=$(uname -r)
log "Running kernel: $KERNEL_VER"
if modprobe wireguard 2>/dev/null; then
  log "wireguard kernel module available"
else
  warn "modprobe wireguard failed. On kernels < 5.6 or in a container, install"
  warn "wireguard-dkms (or wireguard-go for a slower userspace fallback)."
fi

# ───── 4. Config dir ─────
# wg-quick reads /etc/wireguard/<iface>.conf; the node-agent writes it there.
# 0700 because the file it will hold carries the server's private key.
mkdir -p /etc/wireguard
chmod 700 /etc/wireguard

# ───── 5. IP forwarding ─────
SYSCTL_CONF=/etc/sysctl.d/99-wg.conf
if [[ ! -f "$SYSCTL_CONF" ]]; then
  log "Enabling IP forwarding"
  # The directory is not guaranteed: a minimal Debian root (a container image,
  # a debootstrap install) has no /etc/sysctl.d until something creates it, and
  # `set -e` turned the failed redirect into an abort BEFORE the summary - the
  # script looked like it had simply produced no output. Caught on debian:13.
  mkdir -p "$(dirname "$SYSCTL_CONF")"
  echo "net.ipv4.ip_forward=1" > "$SYSCTL_CONF"
  echo "net.ipv6.conf.all.forwarding=1" >> "$SYSCTL_CONF"
  # procps ships `sysctl`; if it is absent the file still applies at next boot,
  # which is worth a warning rather than an abort.
  if command -v sysctl >/dev/null; then
    sysctl --system >/dev/null
  else
    warn "sysctl not found; ip_forward is written but applies only after reboot"
  fi
fi

# ───── 6. Summary ─────
echo
log "WireGuard is ready."
log "    wg:       $(wg --version 2>&1 | head -1)"
log "    wg-quick: $(command -v wg-quick)"
