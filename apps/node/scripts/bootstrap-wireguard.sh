#!/usr/bin/env bash
# Provision a fresh Ubuntu/Debian VPS to run a plain (upstream) WireGuard inbound.
#
# A much smaller job than its AmneziaWG sibling: the kernel module has been in
# the kernel itself since Linux 5.6, so there is no DKMS build, no headers and
# no reboot. `wireguard-tools` brings `wg` and `wg-quick`, from the distro
# (the tools are WireGuard's own, github.com/WireGuard/wireguard-tools; the
# manifest lists them without a pin, because the distro decides the version).
#
# Ends by writing the wireguard block of the agent's env (lib/node-env.sh). The
# block is what REGISTERS the plain adapter: the agent never turns it on by the
# presence of /usr/bin/wg, because bootstrap-amneziawg.sh installs wireguard-tools
# too and every AWG node would otherwise show the engine as installed.
#
# It lives BESIDE AmneziaWG, not instead of it: its own interface (wg0 against
# awg0), config directory (/etc/wireguard) and UDP port.
#
# Idempotent, safe to rerun.
#
# Flags:
#   --restart-agent  restart iceslab-node at the end
#   --remove         take plain WireGuard off the node instead (refused while an
#                    interface is up)
set -euo pipefail

log()  { printf '\033[1;34m[bootstrap]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

# shellcheck source=lib/node-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/node-env.sh"
node_env_flags "$@" || fail "usage: $0 [--restart-agent] [--remove]"

[[ $EUID -eq 0 ]] || fail "Must be run as root (sudo bash $0)"

CONFIG_DIR=/etc/wireguard

# Where the tools are, as the agent has to be told (it would otherwise look at
# /usr/bin).
wire_env() {
  node_env_block wireguard \
    "WIREGUARD_BIN=$(command -v wg 2>/dev/null || echo /usr/bin/wg)" \
    "WIREGUARD_QUICK_BIN=$(command -v wg-quick 2>/dev/null || echo /usr/bin/wg-quick)"
}

unwire_env() {
  node_env_unblock wireguard WIREGUARD_BIN WIREGUARD_QUICK_BIN WIREGUARD_INTERFACE
}

# Running = a WireGuard interface of the kernel is up. awg0 is not one of them
# (type amneziawg), so this node's AmneziaWG does not hold the removal.
wg_interfaces_up() {
  local up
  up="$(ip -o link show type wireguard 2>/dev/null | awk -F': ' '{print $2}' | tr '\n' ' ' || true)"
  up="${up% }"
  [[ -n "$up" ]] && printf 'interfaces up: %s' "$up"
  return 0
}

# --remove: the agent's env block and the config and state it rendered (the
# server key and the peers: left behind, they would bring the old key back up on
# the next install instead of what the panel sends; an operator's own wg0.conf
# is not touched). Kept: the package, which
# bootstrap-amneziawg.sh and the operator may rely on, IP forwarding and ufw's
# FORWARD policy, which other traffic on the node may rely on.
remove_core() {
  local iface
  iface="$(node_env_keep WIREGUARD_INTERFACE wg0)"
  node_env_refuse_if_running wireguard "$(wg_interfaces_up)"
  # Only what the agent wrote: its state file beside the config says so. An
  # /etc/wireguard/wg0.conf the operator keeps for their own tunnel has none.
  if [[ -f "$CONFIG_DIR/$iface.state.json" ]]; then
    rm -f "$CONFIG_DIR/$iface.conf" "$CONFIG_DIR/$iface.state.json"
  fi
  unwire_env
  log "WireGuard removed from the agent (the wireguard-tools package stays)"
}

if [[ "$NODE_ENV_REMOVE" == 1 ]]; then
  remove_core
  node_env_done wireguard
  exit 0
fi

# ───── 1. Distro check ─────
[[ -r /etc/os-release ]] || fail "Cannot read /etc/os-release; unsupported distro"
. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) ;;
  *) fail "Only Ubuntu/Debian supported. Detected ID=${ID:-unknown}." ;;
esac
log "Detected $PRETTY_NAME"

# ───── 2. Userspace tools ─────
if command -v wg >/dev/null 2>&1 && command -v wg-quick >/dev/null 2>&1; then
  log "wireguard-tools already installed: $(wg --version 2>&1 | head -1)"
else
  log "Installing wireguard-tools"
  apt_update
  DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y wireguard-tools
fi
command -v wg       >/dev/null 2>&1 || fail "wg binary not found after install"
command -v wg-quick >/dev/null 2>&1 || fail "wg-quick binary not found after install"

# ───── 3. Kernel module ─────
# In the kernel since 5.6, so modprobe is normally a no-op that only loads it
# now. A container or a stripped kernel can lack it: wg-quick then falls back to
# wireguard-go when that is installed. A warning, not a failure: the agent still
# registers and the operator sees why the interface will not come up.
log "Running kernel: $(uname -r)"
if modprobe wireguard 2>/dev/null; then
  log "wireguard kernel module available"
else
  warn "modprobe wireguard failed. On a kernel older than 5.6 or in a container, install"
  warn "wireguard-dkms (or wireguard-go, slower, in userspace)."
fi

# ───── 4. Config dir ─────
# wg-quick reads /etc/wireguard/<iface>.conf and the agent writes it there. 0700:
# the file carries the server's private key.
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

# ───── 5. IP forwarding ─────
SYSCTL_CONF=/etc/sysctl.d/99-wg.conf
if [[ ! -f "$SYSCTL_CONF" ]]; then
  log "Enabling IP forwarding"
  # The directory is not guaranteed: a minimal Debian root (a container image, a
  # debootstrap install) has no /etc/sysctl.d, and under `set -e` the failed
  # redirect aborted the script BEFORE its summary (caught on debian:13).
  mkdir -p "$(dirname "$SYSCTL_CONF")"
  echo "net.ipv4.ip_forward=1" > "$SYSCTL_CONF"
  echo "net.ipv6.conf.all.forwarding=1" >> "$SYSCTL_CONF"
  # procps ships `sysctl`; without it the file applies at the next boot: a
  # warning, not an abort.
  if command -v sysctl >/dev/null 2>&1; then
    sysctl --system >/dev/null
  else
    warn "sysctl not found; ip_forward is written but applies only after a reboot"
  fi
fi
# Outside the guard: a node installed before this still needs it (see
# ra_keep_default_route in node-env.sh).
ra_keep_default_route "$SYSCTL_CONF"
if command -v sysctl >/dev/null 2>&1; then sysctl --system >/dev/null 2>&1 || true; fi

# ───── 6. Agent env ─────
wire_env
node_env_done wireguard

# ───── 7. Summary ─────
echo
log "WireGuard is ready."
log "    wg:       $(wg --version 2>&1 | head -1)"
log "    wg-quick: $(command -v wg-quick)"
log "The interface and its port come from the profile's inbound; this script opens no firewall port (the installer opens 443/udp and 1234/udp)"
