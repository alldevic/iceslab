# node-env.sh: how a bootstrap wires its core into the node-agent.
#
# Sourced by apps/node/scripts/bootstrap-*.sh, never run on its own.
#
# E20, stand 2026-09-24: a bootstrap put the binary on the machine and PRINTED
# the env lines the agent needs, and the agent, which reads its env and nothing
# else, went on answering "no singbox binary on this node" with sing-box in
# /usr/local/bin. The owner wrote the lines by hand on four nodes. The panel's
# "how to install" promised a working core; the command delivered half of one.
#
# So each bootstrap now writes its own block of /etc/iceslab-node/env between
# two marker lines, the same idea as the generated core-pins blocks:
#
#   # >>> iceslab-node env:<core> >>>
#   KEY=value
#   # <<< iceslab-node env:<core> <<<
#
# The rules the block keeps, all of them tested (apps/node/bootstrap_env_test.go):
#   - rewritten whole on every run, so two runs leave the same file;
#   - a line OUTSIDE any block that sets a key the block owns is dropped: that
#     is the hand-written copy from before, and the block is now where the key
#     lives (systemd takes the last assignment, so leaving both would make the
#     order of the file decide which one is real);
#   - everything else is left exactly where it is: NODE_PAYLOAD and the mTLS
#     material, other cores' blocks, an operator's own lines;
#   - no env file means no agent on this machine yet: the block is not written
#     and the bootstrap says so. The installer writes the file first and runs
#     the bootstraps after it.
#
# ICESLAB_NODE_ENV points the functions at another file, for the tests.

ICESLAB_NODE_ENV="${ICESLAB_NODE_ENV:-/etc/iceslab-node/env}"
NODE_ENV_RESTART_AGENT=0
NODE_ENV_REMOVE=0

# node_env_flags "$@": the flags every bootstrap takes.
#   --restart-agent  restart iceslab-node once the core is in place (or gone),
#                    so the agent reads the env again. The installer does not
#                    pass it: it starts the agent itself, once, at the end.
#   --remove         take the core OFF the machine instead (core-lifecycle.md
#                    section 8). See node_env_refuse_if_running and
#                    node_env_unblock below.
node_env_flags() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --restart-agent) NODE_ENV_RESTART_AGENT=1 ;;
      --remove)        NODE_ENV_REMOVE=1 ;;
      *) printf '[node-env] unknown flag: %s\n' "$arg" >&2; return 2 ;;
    esac
  done
}

# node_env_refuse_if_running <core> <what is running, or empty>: the one fact a
# --remove refuses on. The script has no panel, so it cannot know which hosts
# or cascades still need the core, and does not pretend to; what it CAN see is
# the core still running with the agent's config. Taking the binary away under
# live sessions would drop them, and the agent would keep trying to start it
# again. No --force: the way out is to stop the core through the panel.
#
# The way to a stopped core is the panel: take its hosts and cascade legs off
# this node, and the next push, which no longer names the core, makes the
# agent stop it (core.Idler, internal/server/server.go idleUnnamed). An agent
# older than that leaves the core running on its last config; restarting the
# agent then brings back only what the last push names.
node_env_refuse_if_running() {
  local name="$1" running="$2"
  [[ -z "$running" ]] && return 0
  printf '[node-env] %s is running with the agent'"'"'s config (%s): not removed.\n' "$name" "$running" >&2
  printf '[node-env] Stop it first: take its hosts and cascade legs off this node in the panel; the next push stops it.\n' >&2
  printf '[node-env] Then run this again. (An agent older than that stops it only on: systemctl restart iceslab-node)\n' >&2
  exit 1
}

# node_env_pids <process name>: "<name> pid 1 2" for every process of exactly
# that name, empty when there is none.
node_env_pids() {
  local pids
  pids="$(pgrep -x "$1" 2>/dev/null | tr '\n' ' ' || true)"
  pids="${pids% }"
  [[ -n "$pids" ]] && printf '%s pid %s' "$1" "$pids"
  return 0
}

# node_env_unblock <core> KEY ...: take this core out of the agent's env: its
# block, and any loose line setting one of KEY (the copies written by hand or
# by the installer before the blocks existed). Everything else stays.
node_env_unblock() {
  local name="$1"
  shift
  local begin="# >>> iceslab-node env:${name} >>>"
  local end="# <<< iceslab-node env:${name} <<<"
  local file="$ICESLAB_NODE_ENV" tmp
  [[ -f "$file" ]] || return 0
  tmp="$(mktemp "${file}.XXXXXX")"
  awk -v begin="$begin" -v end="$end" -v keys="$*" '
    BEGIN { n = split(keys, k, " "); for (i = 1; i <= n; i++) own[k[i]] = 1 }
    $0 == begin { skip = 1; next }
    $0 == end   { skip = 0; next }
    skip        { next }
    /^# >>> iceslab-node env:/ { inother = 1 }
    /^# <<< iceslab-node env:/ { inother = 0; print; next }
    !inother && /^[A-Z][A-Z0-9_]*=/ { key = substr($0, 1, index($0, "=") - 1); if (key in own) next }
    { print }
  ' "$file" >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$file"
  printf '[node-env] %s: taken out of %s\n' "$name" "$file"
}

# node_env_value KEY: the value the env file gives KEY now (its last
# assignment), empty when it gives none. For values a rerun must keep, like a
# secret the core's own config already carries.
node_env_value() {
  local key="$1"
  [[ -f "$ICESLAB_NODE_ENV" ]] || return 0
  awk -v k="$key" 'index($0, k "=") == 1 { v = substr($0, length(k) + 2) } END { printf "%s", v }' "$ICESLAB_NODE_ENV"
}

# node_env_keep KEY default: the value KEY has now, or `default` when it has
# none. What makes a second run write the same block as the first.
node_env_keep() {
  local v
  v="$(node_env_value "$1")"
  printf '%s' "${v:-$2}"
}

# node_env_block <core> KEY=value ...: write this core's block.
node_env_block() {
  local name="$1"
  shift
  local begin="# >>> iceslab-node env:${name} >>>"
  local end="# <<< iceslab-node env:${name} <<<"
  local file="$ICESLAB_NODE_ENV" line keys="" tmp

  if [[ ! -f "$file" ]]; then
    printf '[node-env] %s does not exist (no agent on this machine yet); %s not wired in, the installer will do it\n' \
      "$file" "$name" >&2
    return 0
  fi
  for line in "$@"; do
    [[ "$line" =~ ^[A-Z][A-Z0-9_]*= ]] || { printf '[node-env] not a KEY=value line: %s\n' "$line" >&2; return 2; }
    keys+="${line%%=*} "
  done

  tmp="$(mktemp "${file}.XXXXXX")"
  # Everything but this block and the loose copies of its keys. Other blocks
  # pass through untouched, loose lines included only when no block owns them.
  awk -v begin="$begin" -v end="$end" -v keys="$keys" '
    BEGIN { n = split(keys, k, " "); for (i = 1; i <= n; i++) own[k[i]] = 1 }
    $0 == begin { skip = 1; next }
    $0 == end   { skip = 0; next }
    skip        { next }
    /^# >>> iceslab-node env:/ { inother = 1 }
    /^# <<< iceslab-node env:/ { inother = 0; print; next }
    !inother && /^[A-Z][A-Z0-9_]*=/ { key = substr($0, 1, index($0, "=") - 1); if (key in own) next }
    { print }
  ' "$file" >"$tmp"
  {
    printf '%s\n' "$begin"
    printf '%s\n' "$@"
    printf '%s\n' "$end"
  } >>"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$file"
  printf '[node-env] %s: %s written to %s\n' "$name" "${keys% }" "$file"
}

# node_env_own_by_root <path>: a binary root runs belongs to root:root and is
# writable by nobody else. A fresh install sees to that (`install -o root`);
# this is for the run that finds the wanted version already there and does not
# reinstall it: mtg stayed 501:staff on nl-01 and ru-02 after 04a498b, because
# that path never touched the file.
node_env_own_by_root() {
  local path="$1" owner
  [[ -e "$path" ]] || return 0
  owner="$(stat -c '%u:%g' "$path")"
  if [[ "$owner" != "0:0" ]]; then
    chown root:root "$path"
    printf '[node-env] %s was owned by %s, now root:root\n' "$path" "$owner"
  fi
  chmod go-w "$path"
}

# node_env_done <core>: restart the agent if asked, or say that it is needed.
node_env_done() {
  local name="$1" what="wired in"
  [[ "$NODE_ENV_REMOVE" == 1 ]] && what="removed"
  if [[ "$NODE_ENV_RESTART_AGENT" == 1 ]]; then
    printf '[node-env] restarting iceslab-node so it sees %s %s\n' "$name" "$what"
    systemctl restart iceslab-node
  elif [[ -f "$ICESLAB_NODE_ENV" ]]; then
    printf '[node-env] %s is %s; the agent sees it after: systemctl restart iceslab-node\n' "$name" "$what"
  fi
}

# ───── Where the core's bytes come from ─────
#
# A node whose route to GitHub is closed (a hosting firewall, a country) can
# still reach its panel, and the panel image carries every core the manifest
# lists (modules/cores, the Dockerfile `cores` stage). So a bootstrap asks the
# panel FIRST, at the address and with the token the node's own payload
# carries (the heartbeat's), and only then GitHub. Either way the file lands
# where curl would have put it and the bootstrap's own sha256 check is the one
# decision to install or not: nothing here trusts the panel, and the header the
# panel sends is only compared for an early, readable message.
#
#   ICESLAB_CORE_SOURCE   panel       the panel first, GitHub when the panel cannot serve it (default)
#                         panel-only  the panel or nothing: a failure stops the bootstrap, GitHub is not tried
#                         github      GitHub only, the panel is not asked (the behaviour before this existed)
#   ICESLAB_CORE_ALLOW_HTTP=1         accept an http:// panel address. Off by default, the token is a
#                                     bearer; a panel on a bare IP without TLS needs it, and the sha256
#                                     check is what keeps the file honest either way
#   ICESLAB_CORE_RETRY_PAUSE          seconds to wait after a 429 (default 20; the route allows
#                                     RATE_LIMIT_CORE_PER_MIN per address, 20 a minute by default)
#
# The address and the token come from NODE_PAYLOAD in the env file (the
# installer has written it before the first bootstrap runs; on a live node it is
# there already), read here in bash: base64url JSON, and the two fields are
# plain strings. Nothing needs the agent binary, so the update command of an
# old node works too. The token is handed to curl on stdin, never on its command
# line, and is not printed.

ICESLAB_CORE_SOURCE="${ICESLAB_CORE_SOURCE:-panel}"
case "$ICESLAB_CORE_SOURCE" in
  panel|panel-only|github) ;;
  *) printf '[core-source] ICESLAB_CORE_SOURCE=%s: use panel, panel-only or github\n' "$ICESLAB_CORE_SOURCE" >&2; exit 2 ;;
esac

# core_payload_field <name>: a string field of the node's payload, empty when
# the file, the payload or the field is missing.
core_payload_field() {
  local p
  p="$(node_env_value NODE_PAYLOAD)"
  [[ -n "$p" ]] || return 0
  p="${p//-/+}"
  p="${p//_//}"
  while ((${#p} % 4)); do p+='='; done
  printf '%s' "$p" | { base64 -d 2>/dev/null || true; } \
    | { grep -o "\"$1\":\"[^\"]*\"" || true; } | sed -n 1p | sed 's/^"[^"]*":"//; s/"$//'
}

# core_panel_unavailable <what> <why>: the panel could not serve it. In
# panel-only the bootstrap ends here, otherwise it says so and goes to GitHub.
core_panel_unavailable() {
  if [[ "$ICESLAB_CORE_SOURCE" == panel-only ]]; then
    printf '\033[1;31m[fail]\033[0m %s: %s (ICESLAB_CORE_SOURCE=panel-only, GitHub is not tried)\n' "$1" "$2" >&2
    exit 1
  fi
  printf '\033[1;33m[warn]\033[0m %s: %s; trying GitHub\n' "$1" "$2" >&2
  return 1
}

# core_panel_get <what> <route path> <dest> <want sha256>: the file at <route
# path> of the panel into <dest>. Returns 0 with the file there, 1 when GitHub
# is to be tried (and says why); never returns for panel-only. A file that
# arrived is NOT judged here beyond the panel's own header: the caller checks
# its sha256 and a mismatch there is final, GitHub is not asked next.
core_panel_get() {
  local what="$1" path="$2" dest="$3" want="$4"
  local base token url hdrs errf code got msg pause attempt ra
  [[ "$ICESLAB_CORE_SOURCE" != github ]] || return 1

  base="$(core_payload_field panelUrl)"
  token="$(core_payload_field heartbeatToken)"
  if [[ -z "$base" || -z "$token" ]]; then
    core_panel_unavailable "$what" "this node's payload names no panel address or token (issued by an older panel, or no env file yet)"
    return 1
  fi
  base="${base%/}"
  case "$base" in
    https://*) ;;
    http://*)
      if [[ "${ICESLAB_CORE_ALLOW_HTTP:-0}" != 1 ]]; then
        core_panel_unavailable "$what" "the panel address $base is not https, and the token is not sent in the clear (ICESLAB_CORE_ALLOW_HTTP=1 allows it)"
        return 1
      fi ;;
    *) core_panel_unavailable "$what" "the panel address '$base' is not an http(s) URL"; return 1 ;;
  esac

  url="$base$path"
  hdrs="$(mktemp)"
  errf="$(mktemp)"
  printf '[core-source] %s: asking the panel, %s\n' "$what" "$url"
  pause="${ICESLAB_CORE_RETRY_PAUSE:-20}"
  for attempt in 1 2 3 4; do
    # No redirects: the panel answers itself. The token goes in as a curl
    # config on stdin, out of `ps`.
    code="$(printf 'header = "Authorization: Bearer %s"\n' "$token" \
      | curl -K - --proto '=http,https' --max-redirs 0 -sS --connect-timeout 15 --max-time 900 \
          -o "$dest" -D "$hdrs" -w '%{http_code}' "$url" 2>"$errf")" || code=000
    [[ "$code" == 429 && "$attempt" -lt 4 ]] || break
    ra="$(awk -F': *' 'tolower($1) == "retry-after" { gsub(/\r/, "", $2); print $2 }' "$hdrs" | tail -n 1)"
    [[ "$ra" =~ ^[0-9]+$ && "$ra" -le 90 ]] && pause="$ra"
    printf '[core-source] %s: the panel says too many requests, waiting %ss (%s of 4)\n' "$what" "$pause" "$attempt"
    sleep "$pause"
  done

  # What the panel said, for the 4xx/5xx: its own `message` when it has one.
  msg=""
  [[ "$code" == 200 ]] || msg="$(sed -n 's/.*"message":"\([^"]*\)".*/\1/p' "$dest" 2>/dev/null | sed -n 1p)"
  case "$code" in
    200)
      got="$(awk -F': *' 'tolower($1) == "x-iceslab-sha256" { gsub(/\r/, "", $2); print $2 }' "$hdrs" | tail -n 1)"
      rm -f "$hdrs" "$errf"
      if [[ -n "$got" && "$got" != "$want" ]]; then
        rm -f "$dest"
        core_panel_unavailable "$what" "the panel carries another file than the pinned one (its sha256 $got, pinned $want)"
        return 1
      fi
      printf '[core-source] %s: from the panel\n' "$what"
      return 0 ;;
    401) msg="the panel refused this node's token (the node was deleted, or its token replaced?)" ;;
    410) msg="the panel says this node was deleted" ;;
    404) msg="${msg:-the panel has no such file}" ;;
    429) msg="the panel kept answering too many requests" ;;
    000) msg="the panel is not reachable: $(tr '\n' ' ' <"$errf" | sed 's/ *$//')" ;;
    *)   msg="the panel answered HTTP $code${msg:+: $msg}" ;;
  esac
  rm -f "$hdrs" "$errf" "$dest"
  core_panel_unavailable "$what" "$msg"
}

# core_panel_artifact <component> <version> <arch> <dest> <want sha256>: one
# core release file (component as the manifest names it: xray, singbox,
# hysteria, mtg, mita).
core_panel_artifact() {
  core_panel_get "$1 $2 ($3)" "/api/internal/cores/$1/$2/$3" "$4" "$5"
}

# core_panel_script <name> <ref> <dest> <want sha256>: a pinned script the
# panel carries (xray's install-release.sh, name xray-install).
core_panel_script() {
  core_panel_get "$1 @ ${2:0:12}" "/api/internal/cores/scripts/$1/$2" "$3" "$4"
}

# apt_update: `apt-get update`, waiting out the lock DPkg::Lock::Timeout does
# not cover. That option is for dpkg's locks; /var/lib/apt/lists/lock, the one
# `apt-get update` takes first, fails at once (rc 100, "Could not get lock") when
# unattended-upgrades holds it on a fresh cloud image. Only a lock message is
# retried, for APT_LOCK_WAIT_SECS (300) at most, one log line per retry; any
# other failure comes back at once, unchanged. Same function in
# scripts/install-iceslab-node.sh, which runs before a checkout exists.
apt_update() {
  # The budget and the pause are defaulted HERE, not beside the function: an
  # unset value would make the comparison true on the first pass and the retry
  # a no-op. `|| rc=$?` keeps a failing apt from ending a `set -e` script here.
  local out rc started=$SECONDS budget=${APT_LOCK_WAIT_SECS:-300} pause=${APT_LOCK_RETRY_SECS:-5}
  while :; do
    rc=0
    out=$(DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 update -y 2>&1) || rc=$?
    if (( rc == 0 )); then
      printf '%s\n' "$out"
      return 0
    fi
    if [[ "$out" != *"Could not get lock"* && "$out" != *"Unable to lock"* ]] ||
       (( SECONDS - started >= budget )); then
      printf '%s\n' "$out" >&2
      return "$rc"
    fi
    printf 'apt is locked by another process, waiting: %s\n' \
      "$(printf '%s' "$out" | grep -m1 -i 'lock' || true)" >&2
    sleep "$pause"
  done
}

# ra_keep_default_route CONF: with net.ipv6.conf.all.forwarding=1 the kernel
# stops taking router advertisements on an interface whose accept_ra is 1, and
# the node loses its IPv6 default route (stand, m18.10: accept_ra=2 learns it).
# For the interface(s) carrying the host's default route (IPv4 or IPv6) whose
# accept_ra is exactly 1 (the kernel/distro default) write accept_ra=2 to CONF
# and apply it. A host with accept_ra=0 (addressing configured statically) or
# already 2 is not touched, and neither is any interface off the default route.
# Idempotent: a line already in CONF is not repeated. Persisted in CONF, so
# --remove keeps it like the forwarding lines.
ra_keep_default_route() {
  local conf=$1 conf_dir=${ICESLAB_IPV6_CONF_DIR:-/proc/sys/net/ipv6/conf} dev cur key
  local -a devs=()
  while read -r dev; do
    [[ -n "$dev" ]] && devs+=("$dev")
  done < <({ ip -4 route show default 2>/dev/null; ip -6 route show default 2>/dev/null; } |
    awk '{for (i = 1; i < NF; i++) if ($i == "dev") print $(i + 1)}' | sort -u)
  for dev in "${devs[@]}"; do
    cur=$(cat "$conf_dir/$dev/accept_ra" 2>/dev/null || true)
    [[ "$cur" == 1 ]] || continue
    # sysctl keys write a dot in an interface name as a slash.
    key="net.ipv6.conf.${dev//./\/}.accept_ra"
    grep -qxF "$key=2" "$conf" 2>/dev/null || echo "$key=2" >> "$conf"
    log "IPv6 forwarding is on: accept_ra=2 on $dev to keep its router-advertised default route"
  done
}
