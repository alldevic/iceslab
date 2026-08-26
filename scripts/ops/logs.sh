#!/usr/bin/env bash
# logs.sh: log inspector for the panel stack.
#
# Default (no args) prints the last 100 lines of every Docker service
# (backend / frontend / postgres / redis) plus a tail of the host's
# Caddy systemd unit when it's installed. Caddy runs as a native
# systemd service, not a docker container (install-iceslab.sh does
# `apt-get install caddy` in domain mode).
#
# Modes:
#   ./scripts/logs.sh              # last 100 of every service
#   ./scripts/logs.sh -f           # follow live (all services)
#   ./scripts/logs.sh be           # backend only (alias: backend)
#   ./scripts/logs.sh fe           # frontend only (alias: frontend)
#   ./scripts/logs.sh caddy        # caddy / TLS (journalctl, not Docker)
#   ./scripts/logs.sh db           # postgres
#   ./scripts/logs.sh redis        # redis
#   ./scripts/logs.sh be -f        # follow specific service
#   ./scripts/logs.sh --tail=500   # override default 100

set -euo pipefail

LIB_PREFIX="logs"
# shellcheck source=_lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
trap 'on_err $LINENO' ERR

COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env.production"
require_compose_root

DC=(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")

# Resolve short alias to either a compose service name (Docker logs) or
# the literal string "caddy" (systemd path). Keep in sync with
# docker-compose.prod.yml if services rename.
SERVICE=""
FOLLOW=0
TAIL_N=100

for arg in "$@"; do
    case "$arg" in
        be|backend)         SERVICE="backend" ;;
        fe|frontend)        SERVICE="frontend" ;;
        caddy|tls)          SERVICE="caddy" ;;
        db|postgres|pg)     SERVICE="postgres" ;;
        redis|cache)        SERVICE="redis" ;;
        -f|--follow|tail)   FOLLOW=1 ;;
        --tail=*)           TAIL_N="${arg#--tail=}" ;;
        -h|--help)
            sed -n '2,20p' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *)
            log_err "unknown arg: $arg (try: be / fe / caddy / db / redis / -f)"
            exit 2
            ;;
    esac
done

# Caddy lives outside Docker: it's a host-side systemd unit set up by
# install-iceslab.sh. Route its logs through journalctl instead of
# `docker compose logs`.
#
# The unit is checked for BEFORE reading it, because journalctl does not fail
# on a unit that does not exist: `journalctl -u never-installed` prints
# "-- No entries --" and exits 0. The `|| log_warn` this used to rely on could
# therefore never fire in the case it named, and a bare-IP install produced an
# empty caddy block with no explanation — indistinguishable from a caddy that
# is installed, working and quiet, which is the state an operator reading logs
# is usually trying to rule out.
caddy_logs() {
    local follow_flag=""
    if [[ $FOLLOW -eq 1 ]]; then follow_flag="-f"; fi
    if ! command -v journalctl >/dev/null 2>&1; then
        log_warn "journalctl not available, can't read caddy logs"
        return 0
    fi
    if command -v systemctl >/dev/null 2>&1 &&
        ! systemctl list-unit-files caddy.service >/dev/null 2>&1; then
        log_warn "no caddy systemd unit on this host (bare-IP install has none), skipping"
        return 0
    fi
    journalctl -u caddy $follow_flag --no-pager -n "$TAIL_N" \
        || log_warn "reading the caddy journal failed (permissions? try sudo)"
}

if [[ "$SERVICE" == "caddy" ]]; then
    caddy_logs
    exit 0
fi

ARGS=(--tail="$TAIL_N")
if [[ $FOLLOW -eq 1 ]]; then
    ARGS+=(-f)
fi

if [[ -n "$SERVICE" ]]; then
    "${DC[@]}" logs "${ARGS[@]}" "$SERVICE"
    exit $?
fi

# All-services mode: one block per service. Grouped output is easier to
# skim than the interleaved default.
#
# "not running" is asked of `ps -q`, not inferred from the exit code of `logs`:
# compose answers 0 with an empty body for a service that is declared and has
# no container, so the `|| log_warn` this used to rely on could not fire for
# the case it named either. An empty block then reads the same as a service
# that is up and has printed nothing — and a backend that is not running is
# the single most likely reason someone opened this script.
for s in backend frontend postgres redis; do
    printf '\n%b═══════════════════════════════════════════════════════════%b\n' "$C_INFO" "$C_RST"
    printf '%b  %s%b %b(last %s lines)%b\n' "$C_INFO" "$s" "$C_RST" "$C_DIM" "$TAIL_N" "$C_RST"
    printf '%b═══════════════════════════════════════════════════════════%b\n' "$C_INFO" "$C_RST"
    if [[ -z "$("${DC[@]}" ps -q "$s" 2>/dev/null)" ]]; then
        log_warn "service '$s' has no container running"
        continue
    fi
    "${DC[@]}" logs --tail="$TAIL_N" "$s" 2>/dev/null \
        || log_warn "reading '$s' logs failed"
done

# Caddy block last so an all-services tail still covers TLS issues.
# Output is empty plus a note when bare-IP mode skipped the install.
printf '\n%b═══════════════════════════════════════════════════════════%b\n' "$C_INFO" "$C_RST"
printf '%b  caddy%b %b(systemd, last %s lines)%b\n' "$C_INFO" "$C_RST" "$C_DIM" "$TAIL_N" "$C_RST"
printf '%b═══════════════════════════════════════════════════════════%b\n' "$C_INFO" "$C_RST"
caddy_logs
echo
