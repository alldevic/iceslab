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
    docker exec \
        -e "PATH=/opt/ice-stub/bin:/usr/local/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
        "$CONTAINER" bash -c "bash /opt/install-iceslab-node.sh $* >>${INSTALL_LOG} 2>&1"
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

printf '\n'
if [[ "$FAIL" -eq 0 ]]; then
    printf '\033[1;32m%d/%d ok\033[0m\n' "$PASS" "$((PASS + FAIL))"
    exit 0
fi
printf '\033[1;31m%d failed\033[0m of %d\n' "$FAIL" "$((PASS + FAIL))"
exit 1
