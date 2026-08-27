#!/usr/bin/env bash
# installer-systemd-selftest.sh
#
# The half of install-iceslab-node.sh that needs an init.
#
# installer-selftest.sh covers everything reachable without one: argument
# parsing, the `--uninstall` fast path, `resolve_*`, `cleanup_stale_apt_locks`,
# `pinned_fetch`, and `do_uninstall` inside `unshare -rm`. What it cannot reach
# is the second half of the install — the systemd unit, `enable`, `restart`, the
# readiness wait, the sysctl and journald drop-ins, the firewall decisions — and
# that is where the installer stops writing files and starts making claims about
# a machine.
#
# Two of those claims are contracts with the OTHER half of this repo, and both
# are the kind that fails silently:
#
#   RestartPreventExitStatus=42 — the agent exits 42 when the panel disowns the
#     node ("heartbeat self-destruct"). If the unit lost that line, systemd's
#     Restart=always would bring a disowned node straight back up, forever, and
#     nothing anywhere would say so. The agent's side of this is tested in Go;
#     the unit's side has never been observed at all.
#
#   ProtectSystem=strict + ReadWritePaths — that list grew one entry at a time,
#     each after a live incident, and each comment says so: /run for ufw's
#     lockfile, /etc/ufw for the allow-from rule a cascade link-in needs,
#     /var/lib/iceslab-node for the geo assets. A dropped entry does not fail
#     the install; it makes one feature quietly EROFS on a node months later.
#
# So the agent this harness installs is a script that probes its own sandbox and
# can be told to exit 42, and the assertions are systemd's own answers.
#
# What is stubbed, and why, is documented in installer-systemd/stubs.sh. In
# short: git and go, because the installer clones UPSTREAM at v0.2.0 and builds
# it; apt-get, because package installation is not what this is about; ufw,
# because every call is `|| true` and argv is the only observable; curl and tc.
# Everything else is the real installer against the real systemd.
#
# Isolation: a throwaway --privileged container, built here from debian:13 (the
# base image has no systemd). Nothing touches this host, and unlike the
# `unshare` harness there is no path by which it could — but the same refusal is
# kept anyway, because `--uninstall` and `--reset` both call do_uninstall.
#
# Needs: docker, --privileged, cgroup v2. ~2 minutes, ~150 MB image (cached).
#
# Usage:
#   ./scripts/ops/installer-systemd-selftest.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
INSTALLER="${REPO_ROOT}/scripts/install-iceslab-node.sh"
STUBS="${SCRIPT_DIR}/installer-systemd/stubs.sh"

IMAGE=iceslab-node-systemd:selftest
CONTAINER="iceslab-installer-systemd-$$"

PASS=0
FAIL=0
ok()   { printf '  \033[1;32mok\033[0m    %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[1;31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL + 1)); }
note() { printf '\033[1;36m[installer-systemd]\033[0m %s\n' "$1"; }

for f in "$INSTALLER" "$STUBS"; do
    [[ -r "$f" ]] || { printf 'not readable: %s\n' "$f" >&2; exit 2; }
done

# ───── Preflight. Every one of these refuses loudly; none skips silently. ─────
if [[ -e /etc/iceslab-node/env || -x /usr/local/bin/iceslab-node ]]; then
    printf 'this host HAS an iceslab node installed; refusing to run an installer harness on it\n' >&2
    exit 2
fi
if ! command -v docker >/dev/null; then
    printf 'docker is required and is not on PATH; NOT skipping silently\n' >&2
    exit 2
fi
if ! docker info >/dev/null 2>&1; then
    printf 'docker is installed but not usable by this user; NOT skipping silently\n' >&2
    exit 2
fi
if [[ "$(stat -fc %T /sys/fs/cgroup 2>/dev/null)" != "cgroup2fs" ]]; then
    printf 'systemd in a container needs cgroup v2 on this host; NOT skipping silently\n' >&2
    exit 2
fi

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

note "building the systemd image (cached after the first run)"
if ! docker build -q -t "$IMAGE" - >/dev/null 2>&1 <<'DOCKEREOF'
FROM debian:13
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv procps iproute2 \
 && apt-get clean && rm -rf /var/lib/apt/lists/* \
 && rm -f /lib/systemd/system/multi-user.target.wants/* \
          /etc/systemd/system/*.wants/* \
          /lib/systemd/system/local-fs.target.wants/* \
          /lib/systemd/system/sockets.target.wants/*udev* \
          /lib/systemd/system/basic.target.wants/*
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
DOCKEREOF
then
    printf 'could not build the systemd image (network? disk?); NOT skipping silently\n' >&2
    exit 2
fi

note "booting systemd"
if ! docker run -d --name "$CONTAINER" --privileged \
        --tmpfs /run --tmpfs /run/lock \
        -v /sys/fs/cgroup:/sys/fs/cgroup:rw --cgroupns=host \
        "$IMAGE" >/dev/null 2>&1; then
    printf 'could not start a --privileged container; NOT skipping silently\n' >&2
    exit 2
fi

booted=""
for _ in $(seq 1 30); do
    state="$(docker exec "$CONTAINER" systemctl is-system-running 2>&1)"
    case "$state" in running|degraded) booted=1; break ;; esac
    sleep 1
done
if [[ -z "$booted" ]]; then
    printf 'systemd never came up inside the container (last state: %s)\n' "${state:-none}" >&2
    exit 2
fi
ok "systemd is PID 1 in the container ($(docker exec "$CONTAINER" systemctl --version | head -1))"

dex() { docker exec "$CONTAINER" "$@"; }

docker cp "$INSTALLER" "${CONTAINER}:/opt/install-iceslab-node.sh" >/dev/null
docker exec "$CONTAINER" mkdir -p /opt/ice-stub >/dev/null
docker cp "$STUBS" "${CONTAINER}:/opt/stubs.sh" >/dev/null
if ! dex bash /opt/stubs.sh >/dev/null 2>&1; then
    printf 'the stub fixture failed to install; every case below would be vacuous\n' >&2
    exit 2
fi

# A payload long enough not to trip the installer's own "suspiciously short"
# warning; its contents are opaque to the installer.
PAYLOAD="$(head -c 6000 /dev/zero | tr '\0' 'A')"

INSTALL_LOG=/opt/install.log
run_installer() {
    # Each argument is re-quoted before it goes into `bash -c`: a value with a
    # space in it (--ssh-allowlist "a, b") is otherwise split by the inner shell
    # and the installer refuses the fragment as an unknown flag. Caught by this
    # harness reporting nine failures that were all one quoting bug.
    local quoted=""
    local a
    for a in "$@"; do quoted+=" $(printf '%q' "$a")"; done
    docker exec \
        -e "PATH=/opt/ice-stub/bin:/usr/local/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
        -e "SSH_CONNECTION=${FAKE_SSH_CONNECTION:-}" \
        "$CONTAINER" bash -c "bash /opt/install-iceslab-node.sh${quoted} >>${INSTALL_LOG} 2>&1"
}

# ═════════════════════════════════════════════════════════════════════════════
#  1. A first install, all eight steps
# ═════════════════════════════════════════════════════════════════════════════
note "install"
dex bash -c ": > ${INSTALL_LOG}"
run_installer --protocol tuic --payload "$PAYLOAD" --panel-ip 203.0.113.7 --port 1337
RC=$?
LOG="$(dex cat "$INSTALL_LOG")"

# The control. Every assertion below reads state the installer is supposed to
# have produced, and absent state is also what a run that died in step 1 leaves.
if [[ "$RC" == "0" ]] && grep -q 'Iceslab node-agent is up' <<<"$LOG"; then
    ok "the installer ran to its own completion banner (rc=0)"
else
    bad "the installer exited $RC and did not reach its completion banner. Every case below would be vacuous:
$(sed 's/^/      /' <<<"$LOG" | tail -40)"
    printf '\033[1;31maborting\033[0m\n'
    exit 1
fi

# ───── The unit itself ─────
UNIT="$(dex cat /etc/systemd/system/iceslab-node.service 2>/dev/null)"
if [[ -n "$UNIT" ]]; then
    ok "a unit was written to /etc/systemd/system/iceslab-node.service"
else
    bad "no unit file at /etc/systemd/system/iceslab-node.service"
fi

for want in \
    'RestartPreventExitStatus=42' \
    'Restart=always' \
    'EnvironmentFile=/etc/iceslab-node/env' \
    'ExecStart=/usr/local/bin/iceslab-node' \
    'ProtectSystem=strict' \
    'WantedBy=multi-user.target'
do
    if grep -qF "$want" <<<"$UNIT"; then
        ok "unit carries ${want}"
    else
        bad "unit is missing ${want}"
    fi
done

# ───── What systemd made of it ─────
if [[ "$(dex systemctl is-enabled iceslab-node 2>&1)" == "enabled" ]]; then
    ok "systemd reports the unit enabled (it would not survive a reboot otherwise)"
else
    bad "systemctl is-enabled says: $(dex systemctl is-enabled iceslab-node 2>&1)"
fi
if [[ "$(dex systemctl is-active iceslab-node 2>&1)" == "active" ]]; then
    ok "the agent is running under systemd"
else
    bad "systemctl is-active says: $(dex systemctl is-active iceslab-node 2>&1)"
fi

# The installer's readiness step asks systemd rather than curling /healthz (the
# mTLS server rejects a probe with no client cert). It has a warn branch that
# leaves the install "successful" with a dead agent, so which branch ran matters.
if grep -q 'iceslab-node active in' <<<"$LOG"; then
    ok "the readiness step observed the unit come up"
elif grep -q 'did NOT reach active state' <<<"$LOG"; then
    bad "the readiness step took its warn branch: the install 'succeeded' with a dead agent"
else
    bad "the readiness step printed neither of its two outcomes"
fi

# ───── The drop-ins ─────
SYSCTL="$(dex cat /etc/sysctl.d/99-iceslab.conf 2>/dev/null)"
if grep -q 'tcp_congestion_control = bbr' <<<"$SYSCTL" && grep -q 'rmem_max = 16777216' <<<"$SYSCTL"; then
    ok "the sysctl drop-in is on disk with BBR and the 16 MiB buffers"
else
    bad "sysctl drop-in missing or incomplete: ${SYSCTL:-<absent>}"
fi
if dex test -f /etc/systemd/journald.conf.d/iceslab-cap.conf; then
    ok "journald is capped by a drop-in (a node running for months fills the disk otherwise)"
else
    bad "no journald cap drop-in"
fi

# ───── The env file ─────
if [[ "$(dex stat -c %a /etc/iceslab-node/env 2>&1)" == "600" ]]; then
    ok "the env file is 0600 (it holds the node's payload)"
else
    bad "env file mode is $(dex stat -c %a /etc/iceslab-node/env 2>&1), want 600"
fi
if dex grep -q "^NODE_PORT=1337$" /etc/iceslab-node/env; then
    ok "--port reached the env file"
else
    bad "--port 1337 is not in the env file"
fi

# ───── The firewall decisions, read off the argv ─────
UFW="$(dex cat /opt/ice-stub/log/ufw.log 2>/dev/null)"
if grep -q 'ufw allow 22/tcp' <<<"$UFW"; then
    ok "SSH is allowed, and before the deny-by-default flip"
else
    bad "no 'ufw allow 22/tcp' — enabling ufw would lock the operator out"
fi
if grep -q "ufw allow from 203.0.113.7 to any port 1337 proto tcp" <<<"$UFW"; then
    ok "--panel-ip narrowed the mTLS port to the panel"
else
    bad "the mTLS port was not narrowed to --panel-ip:
$(sed 's/^/      /' <<<"$UFW")"
fi
if grep -qE '^ufw allow 1337/tcp$' <<<"$UFW"; then
    bad "the mTLS port was ALSO opened to the world despite --panel-ip"
else
    ok "and was not also opened to the world"
fi

# ═════════════════════════════════════════════════════════════════════════════
#  2. What the unit's sandbox actually permits
# ═════════════════════════════════════════════════════════════════════════════
note "ProtectSystem=strict, from inside the unit"
probe_now() { dex journalctl -u iceslab-node --no-pager -o cat 2>/dev/null | grep '^PROBE '; }
PROBE="$(probe_now)"
if [[ -z "$PROBE" ]]; then
    bad "the agent logged no sandbox probes; the cases below would be vacuous"
else
    ok "the agent reported what its sandbox permits"
    # Every config directory the installer pre-creates, in the order it creates
    # them. The pre-creation exists for exactly one reason (a ReadWritePaths
    # entry opens an existing path, it does not make one), so a directory that
    # is created and then not writable is a decision that lost half of itself.
    for d in /etc/iceslab-node /etc/xray /etc/sing-box /etc/hysteria /etc/caddy \
             /etc/mtg /etc/mita /etc/wireguard /etc/amnezia/amneziawg /etc/ufw
    do
        if grep -qF "PROBE rw $d" <<<"$PROBE"; then
            ok "the unit can write ${d}"
        else
            bad "the unit CANNOT write ${d}; whatever needs it fails EROFS on a live node"
        fi
    done
    # The other direction: without this, "it can write everything" would also
    # satisfy every case above.
    if grep -qF "PROBE ro /etc" <<<"$PROBE"; then
        ok "and cannot write /etc at large, so the sandbox is doing something"
    else
        bad "the unit can write all of /etc: ProtectSystem=strict is not in effect"
    fi

    # The geo-asset dir is the one entry that is deliberately conditional: the
    # installer creates it only in the xray branch, and only that branch puts
    # XRAY_GEO_DIR in the env. Both halves have to agree, or the node either
    # fails EROFS on every pushed database or carries a writable directory it
    # was never told about. This is the tuic install, so both must be absent;
    # the xray re-install below asks for the other side.
    if dex grep -q '^XRAY_GEO_DIR=' /etc/iceslab-node/env; then
        bad "a tuic node was given XRAY_GEO_DIR"
    elif grep -qF "PROBE rw /var/lib/iceslab-node" <<<"$PROBE"; then
        bad "the geo dir is writable on a node that was never told to use it"
    else
        ok "geo assets are off on a tuic node, on both halves at once"
    fi
fi

# ═════════════════════════════════════════════════════════════════════════════
#  3. The self-destruct exit code, as systemd sees it
# ═════════════════════════════════════════════════════════════════════════════
note "RestartPreventExitStatus=42"

restarts_of() { dex systemctl show -p NRestarts --value iceslab-node 2>/dev/null | tr -d '\r'; }

# First the control: an ORDINARY failure must be restarted, or "42 was not
# restarted" is true of a unit that never restarts anything.
dex bash -c 'echo crash > /etc/iceslab-node/agent-mode'
dex systemctl reset-failed iceslab-node >/dev/null 2>&1
dex systemctl restart iceslab-node >/dev/null 2>&1
sleep 12
if [[ "$(restarts_of)" -ge 1 ]]; then
    ok "an ordinary crash (exit 7) is restarted: Restart=always is live"
else
    bad "exit 7 was not restarted (NRestarts=$(restarts_of)); the case below proves nothing"
fi

dex bash -c 'echo exit42 > /etc/iceslab-node/agent-mode'
dex systemctl reset-failed iceslab-node >/dev/null 2>&1
dex systemctl stop iceslab-node >/dev/null 2>&1
dex systemctl restart iceslab-node >/dev/null 2>&1
sleep 12
STATE="$(dex systemctl is-active iceslab-node 2>&1)"
RESULT="$(dex systemctl show -p Result --value iceslab-node 2>/dev/null | tr -d '\r')"
if [[ "$STATE" != "active" ]] && [[ "$RESULT" == "exit-code" ]]; then
    ok "exit 42 stays down: a node the panel disowned is not brought back by systemd"
else
    bad "after exit 42 the unit is '$STATE' (Result=$RESULT); a disowned node would restart forever"
fi

dex bash -c 'echo idle > /etc/iceslab-node/agent-mode'
dex systemctl reset-failed iceslab-node >/dev/null 2>&1

# ═════════════════════════════════════════════════════════════════════════════
#  4. --reset over an existing install
# ═════════════════════════════════════════════════════════════════════════════
note "--reset"

# A file the operator put in a config dir the installer manages. do_uninstall
# already has a case for leaving a stranger's file alone under `unshare`; here
# the question is whether a full --reset re-install ends with a WORKING node.
dex bash -c 'echo keep-me > /etc/hysteria/operators-note.txt'

# Switching protocol at the same time, because it is the same command an
# operator runs to change a node's protocol, and because the xray branch is the
# one that turns the geo-asset dir on.
dex bash -c ": > ${INSTALL_LOG}"
run_installer --protocol xray --payload "$PAYLOAD" --panel-ip 203.0.113.7 --port 1337 --reset
RC=$?
LOG="$(dex cat "$INSTALL_LOG")"
if [[ "$RC" == "0" ]] && grep -q 'Iceslab node-agent is up' <<<"$LOG"; then
    ok "--reset re-installs over an existing node and finishes"
else
    bad "--reset exited $RC:
$(sed 's/^/      /' <<<"$LOG" | tail -30)"
fi
if grep -q 'wiping previous installation' <<<"$LOG"; then
    ok "and said it was wiping the previous install rather than doing it silently"
else
    bad "--reset did not announce the wipe"
fi
if [[ "$(dex systemctl is-active iceslab-node 2>&1)" == "active" ]]; then
    ok "the node is running again after the reset"
else
    bad "after --reset the unit is $(dex systemctl is-active iceslab-node 2>&1)"
fi

# The other half of the geo pairing, now that the protocol is xray.
dex bash -c 'echo "" > /dev/null'
PROBE2="$(dex journalctl -u iceslab-node --no-pager -o cat --since '-1 min' 2>/dev/null | grep '^PROBE ')"
if dex grep -q '^XRAY_GEO_DIR=/var/lib/iceslab-node/geo$' /etc/iceslab-node/env; then
    if grep -qF "PROBE rw /var/lib/iceslab-node" <<<"$PROBE2"; then
        ok "an xray node gets the geo dir AND the unit can write it"
    else
        bad "an xray node was told to manage geo assets in a directory its unit cannot write"
    fi
else
    bad "the xray install did not set XRAY_GEO_DIR; the pairing cannot be checked"
fi
if dex test -d /usr/local/etc/xray; then
    ok "the xray config dir exists, so its ReadWritePaths entry has something to open"
else
    bad "/usr/local/etc/xray was not created; every config push dies on read-only"
fi

# ───── An xray node with no REALITY pre-seed ─────
#
# The else half of the flag body: with no key to seed from, the env file gets
# the commented placeholders and the adapter waits for a panel push. What must
# NOT happen is a half-written block — a live XRAY_PORT or SNI beside no key
# reads to anyone grepping the file as a configured node.
XRAYENV="$(dex cat /etc/iceslab-node/env 2>/dev/null)"
if grep -q '^# XRAY_REALITY_PRIVATE_KEY=$' <<<"$XRAYENV"; then
    ok "an xray install with no pre-seed flags leaves the REALITY keys commented out"
else
    bad "no commented REALITY placeholder in the env file:
$(grep -i reality <<<"$XRAYENV" | sed 's/^/      /')"
fi
if grep -qE '^XRAY_(REALITY_|PORT)' <<<"$XRAYENV"; then
    bad "part of the REALITY block was written live with no private key to seed it:
$(grep -E '^XRAY_' <<<"$XRAYENV" | sed 's/^/      /')"
else
    ok "and writes no live half of the block beside them"
fi

# ═════════════════════════════════════════════════════════════════════════════
#  5. An existing install with neither --reset nor a terminal
# ═════════════════════════════════════════════════════════════════════════════
note "an existing install, no --reset"
dex bash -c ": > ${INSTALL_LOG}"
run_installer --protocol tuic --payload "$PAYLOAD"
RC=$?
LOG="$(dex cat "$INSTALL_LOG")"
if [[ "$RC" != "0" ]] && grep -qE 'Aborted by user|Previous install detected' <<<"$LOG"; then
    ok "a second install without --reset refuses, and names the flag that would work"
else
    bad "a second install without --reset exited $RC:
$(sed 's/^/      /' <<<"$LOG" | tail -20)"
fi
# It must refuse BEFORE touching the running node.
if [[ "$(dex systemctl is-active iceslab-node 2>&1)" == "active" ]]; then
    ok "and left the running node alone"
else
    bad "the refused install took the node down anyway: $(dex systemctl is-active iceslab-node 2>&1)"
fi

# ═════════════════════════════════════════════════════════════════════════════
#  6. The hardening flags, whose bodies nothing had ever run
# ═════════════════════════════════════════════════════════════════════════════
#
# Their PARSING is covered in installer-selftest.sh (every value-taking flag
# eats its value; --help and the parser name the same flags). What each one then
# DOES is executable body in the middle of the script, reachable only by running
# it — which is what this harness is for.
note "--with-singbox, --fail2ban, --ssh-allowlist, --harden-ufw"

# The operator's own fail2ban config, put here first. --uninstall used to delete
# a file it never wrote; the same question is worth asking of an install.
dex bash -c 'install -d -m 755 /etc/fail2ban/jail.d && echo "# operator" > /etc/fail2ban/jail.d/zz-operator.local'

dex bash -c ": > ${INSTALL_LOG}"
dex bash -c ': > /opt/ice-stub/log/ufw.log'
# An SSH session from an address deliberately OUTSIDE the allowlist: that is the
# only state in which the lockout guard fires.
FAKE_SSH_CONNECTION="198.51.100.4 51000 203.0.113.10 22" \
run_installer --protocol xray --payload "$PAYLOAD" --panel-ip 203.0.113.7 --port 1337 \
    --reset --with-singbox --fail2ban --harden-ufw --ssh-allowlist "192.0.2.0/24, 192.0.2.9" \
    --ssh-port 2222 \
    --xray-reality-private-key sI_p9bg7cyPRIVATE --xray-reality-short-ids abc123,def456 \
    --xray-reality-server-names www.example.com --xray-reality-dest www.example.com:443 \
    --xray-port 8443
RC=$?
LOG="$(dex cat "$INSTALL_LOG")"
if [[ "$RC" == "0" ]] && grep -q 'Iceslab node-agent is up' <<<"$LOG"; then
    ok "an install with every hardening flag on finishes"
else
    bad "the hardened install exited $RC:
$(sed 's/^/      /' <<<"$LOG" | tail -30)"
fi

# ───── --with-singbox ─────
ENVFILE="$(dex cat /etc/iceslab-node/env 2>/dev/null)"
if grep -q '^SINGBOX_BINARY=/usr/local/bin/sing-box$' <<<"$ENVFILE"; then
    ok "--with-singbox wrote the engine env, so the agent registers the sing-box adapters"
else
    bad "no SINGBOX_BINARY in the env file; the binary would be installed and never used"
fi
if grep -q '^XRAY_BINARY=' <<<"$ENVFILE"; then
    ok "and the primary protocol's env is still there beside it"
else
    bad "the sing-box env replaced the primary protocol's instead of adding to it"
fi
# The auto-wiring exists because sing-box ships no stats CLI: without it every
# sing-box user's counters stay at zero and nothing says why.
if grep -q '^SINGBOX_STATS_BIN=' <<<"$ENVFILE"; then
    ok "and per-user stats were auto-wired to the xray binary present on this node"
else
    bad "SINGBOX_STATS_BIN was not auto-wired though xray is installed; sing-box counters stay at zero"
fi

# ───── The Xray REALITY pre-seed, all five flags ─────
#
# The point of the pre-seed is a node that serves REALITY the moment it boots,
# instead of waiting for the panel to push an inbound. It is one `cat >>` inside
# one branch, and until now the only thing that had ever run it was a live
# install nobody read afterwards. Every value is distinct from its default here,
# so a flag that silently kept the default cannot pass.
for want in \
    'XRAY_REALITY_PRIVATE_KEY=sI_p9bg7cyPRIVATE' \
    'XRAY_REALITY_SHORT_IDS=abc123,def456' \
    'XRAY_REALITY_SERVER_NAMES=www.example.com' \
    'XRAY_REALITY_DEST=www.example.com:443' \
    'XRAY_PORT=8443'
do
    if grep -qxF "$want" <<<"$ENVFILE"; then
        ok "the pre-seed wrote ${want%%=*}"
    else
        bad "${want} is not in the env file:
$(grep '^XRAY' <<<"$ENVFILE" | sed 's/^/      /')"
    fi
done
# And it said so. A pre-seed that happened silently is one the operator cannot
# tell from the deferred-key flow, which is the other outcome of the same flag.
if grep -q 'Xray REALITY env populated (port=8443, sni=www.example.com)' <<<"$LOG"; then
    ok "and reported the port and SNI it seeded"
else
    bad "the pre-seed was not announced"
fi

# ───── --fail2ban ─────
if dex test -f /etc/fail2ban/filter.d/iceslab-hysteria.conf; then
    ok "--fail2ban installed the agent's own filter"
else
    bad "no /etc/fail2ban/filter.d/iceslab-hysteria.conf"
fi
JAIL="$(dex cat /etc/fail2ban/jail.d/iceslab.local 2>/dev/null)"
if grep -q '^\[sshd\]' <<<"$JAIL" && grep -q '^\[iceslab-hysteria\]' <<<"$JAIL"; then
    ok "and both jails, in jail.d rather than over the distro's jail.conf"
else
    bad "the jail file is missing or has neither jail:
$(sed 's/^/      /' <<<"${JAIL:-<absent>}")"
fi
# The filter is what turns a log line into a ban. An expression that matches
# nothing bans nobody, and fail2ban still reports the jail as active.
FILTER="$(dex cat /etc/fail2ban/filter.d/iceslab-hysteria.conf 2>/dev/null)"
if grep -q 'hysteria auth rejected' <<<"$FILTER" && grep -q '<HOST>' <<<"$FILTER"; then
    ok "and the filter matches the agent's own reject line and captures the address"
else
    bad "the filter does not name the line it is supposed to match:
$(sed 's/^/      /' <<<"${FILTER:-<absent>}")"
fi
if [[ "$(dex cat /etc/fail2ban/jail.d/zz-operator.local 2>&1)" == "# operator" ]]; then
    ok "and the operator's own jail file was left alone"
else
    bad "the install overwrote or removed a jail file the operator put there"
fi

# ───── --ssh-allowlist + --harden-ufw ─────
UFW="$(dex cat /opt/ice-stub/log/ufw.log 2>/dev/null)"
if grep -q 'ufw limit from 192.0.2.0/24 to any port 2222 proto tcp' <<<"$UFW" \
   && grep -q 'ufw limit from 192.0.2.9 to any port 2222 proto tcp' <<<"$UFW"; then
    ok "every allowlisted address got a rate-limited SSH rule, spaces in the list and all"
else
    bad "the comma-list was not applied per address:
$(sed 's/^/      /' <<<"$UFW")"
fi
if grep -qE '^ufw (allow|limit) 22/tcp$' <<<"$UFW"; then
    bad "SSH was ALSO left open to the world despite --ssh-allowlist"
else
    ok "and 22/tcp was not left world-open beside it"
fi
# The lockout guard. It exists so `ufw --force enable` cannot cut the session
# the operator is running the installer from, and it can only fire when
# SSH_CONNECTION is set — which is the normal case for `bash <(curl ...)` over
# SSH and NOT the case in most test harnesses.
if grep -q 'ufw allow from 198.51.100.4 to any port 2222 proto tcp' <<<"$UFW"; then
    ok "the session's own address was allowed, so enabling ufw cannot lock the operator out"
else
    bad "the lockout guard did not fire for an SSH source outside the allowlist:
$(sed 's/^/      /' <<<"$UFW")"
fi
if grep -q 'is NOT in --ssh-allowlist' <<<"$LOG"; then
    ok "and it said so, so the extra /32 is not a silent hole"
else
    bad "the lockout guard added a rule and did not warn about it"
fi
# The control: without an SSH session there is nothing to protect, and the guard
# must not invent a rule for an empty address.
if grep -qE 'ufw allow from +to any port 22' <<<"$UFW"; then
    bad "a rule was written for an empty source address"
else
    ok "and it wrote no rule for an empty source"
fi

# ───── --ssh-port, on both sides of the decision it makes ─────
#
# It used to be `$SSH_PORT` read in exactly one place — the fail2ban jail — and
# set nowhere in the repository, while every firewall rule hard-coded 22. An
# operator who found the variable got a jail on their port and a firewall on the
# old one. It is a flag now, and the point is that both sides move together.
if grep -q '^port     = 2222$' <<<"$JAIL"; then
    ok "the fail2ban jail watches the port that was passed"
else
    bad "the jail is not on --ssh-port 2222:
$(sed 's/^/      /' <<<"${JAIL:-<absent>}")"
fi
# The allowlist rules must all have moved to the new port. The lockout guard's
# own rule for the session's real port is the ONE thing still allowed on 22, and
# it is asserted separately below — so this looks only at the allowlisted
# addresses, not at every mention of 22.
if grep -E '^ufw (allow|limit) from 192\.0\.2\.' <<<"$UFW" | grep -q 'port 22 '; then
    bad "an allowlisted address is still pinned to 22 after --ssh-port 2222:
$(sed 's/^/      /' <<<"$UFW")"
else
    ok "and no allowlisted address was left behind on 22"
fi
# The evidence the flag cannot override: SSH_CONNECTION's fourth field is the
# port this session actually arrived on. A wrong --ssh-port plus `ufw --force
# enable` is the one combination that ends the operator's access to the box, so
# the real port is allowed too and the mismatch is said out loud.
if grep -q 'ufw allow from 198.51.100.4 to any port 22 proto tcp' <<<"$UFW"; then
    ok "the port this session actually arrived on was allowed as well"
else
    bad "--ssh-port 2222 was taken on trust while the session was on 22; enabling ufw would cut it:
$(sed 's/^/      /' <<<"$UFW")"
fi
if grep -q 'this session arrived on port 22' <<<"$LOG"; then
    ok "and the disagreement was reported rather than papered over"
else
    bad "the session/flag port mismatch was not warned about"
fi

# ───── The world-open SSH rule a previous install left behind ─────
#
# Found on a real VM, and only there: this harness stubs ufw and starts from a
# clean slate, so it never had a leftover rule to trip over. A node installed
# once WITHOUT --ssh-allowlist carries `22/tcp ALLOW IN Anywhere`; ufw matches in
# order and the first match wins, so the allowlist rules added afterwards
# restrict nothing. The operator reads `ufw status`, sees their allowlist rule,
# and believes SSH is locked down. do_uninstall does not remove it either — it
# deletes the agent's own port and nothing else — so --reset does not clear it.
# This scenario passes --ssh-port 2222, so that is the port the removal names.
if grep -qE '^ufw --force delete (allow|limit) 2222/tcp$' <<<"$UFW"; then
    ok "a world-open SSH rule from an earlier install is removed, so the allowlist can bite"
else
    bad "nothing removes a leftover blanket SSH rule; --ssh-allowlist would restrict nothing on a re-install:
$(sed 's/^/      /' <<<"$UFW")"
fi
# Order matters: the narrow rules must already exist when the blanket one goes,
# or there is a moment with no SSH rule at all.
if [[ "$(grep -n 'ufw allow from 198.51.100.4' <<<"$UFW" | head -1 | cut -d: -f1)" \
      -lt "$(grep -n 'ufw --force delete allow 2222/tcp' <<<"$UFW" | head -1 | cut -d: -f1)" ]]; then
    ok "and only after the session's own rule is in place"
else
    bad "the blanket rule was removed before the replacement rules existed"
fi

# ───── …and NOT removed when we cannot see where the operator is ─────
note "an install with no SSH_CONNECTION in the environment"
dex bash -c ": > ${INSTALL_LOG}"
dex bash -c ': > /opt/ice-stub/log/ufw.log'
FAKE_SSH_CONNECTION="" \
run_installer --protocol xray --payload "$PAYLOAD" --panel-ip 203.0.113.7 --port 1337 \
    --reset --ssh-allowlist "192.0.2.0/24"
RC=$?
LOG="$(dex cat "$INSTALL_LOG")"
UFW2="$(dex cat /opt/ice-stub/log/ufw.log 2>/dev/null)"
if [[ "$RC" != "0" ]]; then
    bad "a console install (no SSH_CONNECTION) failed outright: rc=$RC"
elif grep -qE '^ufw --force delete (allow|limit) 22/tcp$' <<<"$UFW2"; then
    bad "removed the only rule keeping a console operator in, on a guess about where they are"
else
    ok "leaves the blanket rule alone when the session's source is unknown"
fi
if grep -q 'does NOT restrict SSH while' <<<"$LOG"; then
    ok "and says so, rather than leaving the operator believing the allowlist bit"
else
    bad "skipped the removal silently; the operator is told SSH is restricted when it is not"
fi

if [[ "$(dex systemctl is-active iceslab-node 2>&1)" == "active" ]]; then
    ok "the node is running after the hardened install"
else
    bad "after the hardened install the unit is $(dex systemctl is-active iceslab-node 2>&1)"
fi

# ───── What a full install leaves readable ─────
#
# The file modes were fixed at the source on 2026-08-27 (create 0600, do not
# chmod afterwards), and installer-selftest.sh checks that every `chmod 600`
# has an `install -m 0600` in front of it. That is the SOURCE half. This is the
# other one: after eight steps, two protocol bootstraps and a hardening pass,
# what is actually on disk.
#
# It is asked as a sweep rather than as a list of paths, because the list is
# what goes stale: a protocol bootstrap added later writes wherever it likes.
# The exceptions are named individually and each says why it is public.
note "no secret is left world-readable after a full install"
READABLE="$(dex bash -c '
    for d in /etc/iceslab-node /etc/xray /usr/local/etc/xray /etc/sing-box /etc/hysteria \
             /etc/caddy /etc/mtg /etc/mita /etc/wireguard /etc/amnezia/amneziawg; do
        [ -d "$d" ] || continue
        find "$d" -type f -perm /044 -printf "%m %p\n" 2>/dev/null
    done' 2>/dev/null)"
# The control names a case rather than counting things: the file that must be
# in the swept set is the one holding the node's mTLS payload, and it must be
# 0600 when found. A sweep that finds nothing is also a sweep that looked
# nowhere, and a count would not tell the two apart.
ENVMODE="$(dex stat -c %a /etc/iceslab-node/env 2>&1 | tr -d '\r')"
if [[ "$ENVMODE" == "600" ]]; then
    ok "the sweep's own target is there and private: /etc/iceslab-node/env is 0600"
else
    bad "/etc/iceslab-node/env is '${ENVMODE}'; the sweep below is not looking where the install writes"
fi
# Two exceptions, each for its own reason and each named rather than filtered
# by a wildcard:
#   * `cert.pem` is a certificate. It goes to every client that connects, and
#     sing-box's bootstrap chmods it 644 deliberately.
#   * `operators-note.txt` is planted by THIS harness, two sections above, as a
#     stranger's file that `--reset` must leave alone. Its mode is the
#     operator's business.
# Anything else appearing here is a finding, not a new entry for this list.
UNEXPECTED="$(grep -vE '/(cert|fullchain|chain)\.pem$|/operators-note\.txt$' <<<"$READABLE" | grep -v '^$')"
if [[ -z "$UNEXPECTED" ]]; then
    ok "and nothing else under the config dirs is readable beyond root"
else
    bad "these are readable beyond root after a plain install:
$(sed 's/^/      /' <<<"$UNEXPECTED")"
fi

# ═════════════════════════════════════════════════════════════════════════════
#  7. A pre-seed with the private key and nothing else
# ═════════════════════════════════════════════════════════════════════════════
#
# One decision — "is there enough here to serve REALITY on boot" — written in
# two repositories' worth of code. The agent's copy, buildXrayConfig() in
# apps/node/main.go, asks about XRAY_REALITY_PRIVATE_KEY and nothing else; an
# empty shortIds list is a REALITY client sending an empty shortId, which is
# valid. The installer's copy also demanded short-ids, so this exact command
# wrote the commented placeholders instead and said nothing, and the operator
# got a node whose adapter sits waiting for a panel push.
note "a pre-seed with the private key alone"
dex bash -c ": > ${INSTALL_LOG}"
run_installer --protocol xray --payload "$PAYLOAD" --port 1337 --reset \
    --xray-reality-private-key onlyTheKey
RC=$?
LOG="$(dex cat "$INSTALL_LOG")"
ENVFILE="$(dex cat /etc/iceslab-node/env 2>/dev/null)"
if [[ "$RC" == "0" ]] && grep -q 'Iceslab node-agent is up' <<<"$LOG"; then
    ok "the install finishes with only the private key given"
else
    bad "it exited $RC:
$(sed 's/^/      /' <<<"$LOG" | tail -20)"
fi
if grep -qxF 'XRAY_REALITY_PRIVATE_KEY=onlyTheKey' <<<"$ENVFILE"; then
    ok "and the key reaches the env file, the way the agent's own rule reads it"
else
    bad "the private key alone did not pre-seed anything:
$(grep -E '^#? ?XRAY' <<<"$ENVFILE" | sed 's/^/      /')"
fi
if grep -qxF 'XRAY_REALITY_SHORT_IDS=' <<<"$ENVFILE"; then
    ok "with an empty short-id list beside it rather than a missing key"
else
    bad "the short-id line is not there empty:
$(grep -E '^XRAY' <<<"$ENVFILE" | sed 's/^/      /')"
fi
if [[ "$(dex systemctl is-active iceslab-node 2>&1)" == "active" ]]; then
    ok "and the node is running"
else
    bad "the unit is $(dex systemctl is-active iceslab-node 2>&1)"
fi

printf '\n'
if [[ "$FAIL" -eq 0 ]]; then
    printf '\033[1;32m%d/%d ok\033[0m\n' "$PASS" "$((PASS + FAIL))"
    exit 0
fi
printf '\033[1;31m%d failed\033[0m of %d\n' "$FAIL" "$((PASS + FAIL))"
exit 1
