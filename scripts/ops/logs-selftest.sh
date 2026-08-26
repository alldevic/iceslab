#!/usr/bin/env bash
# logs-selftest.sh
#
# `logs.sh` is the first thing an operator runs when the panel misbehaves, and
# what it must never do is stay silent about a service that is not there. It
# had two guards that read correctly and could not fire, the same shape as the
# four the round-trips have already found in this layer:
#
#   * `journalctl -u caddy ... || log_warn "unit not found"` — journalctl exits
#     0 for a unit that was never installed (it prints "-- No entries --"), so
#     on a bare-IP install the caddy block was empty with no explanation, which
#     is exactly what an installed, working, quiet caddy also looks like.
#   * `docker compose logs <svc> || log_warn "not running"` — compose answers 0
#     with an empty body for a declared service that has no container, so the
#     most likely reason anyone opens this script — the backend is down —
#     printed as a heading with nothing under it.
#
# Both are now asked of something that can answer: `systemctl list-unit-files`
# and `compose ps -q`. This checks that they answer.
#
# `docker`, `systemctl` and `journalctl` are replaced on PATH by stubs, so
# nothing here reads a real stack or a real journal.
#
# Needs bash and git. No docker, no network.
#
# Usage:
#   ./scripts/ops/logs-selftest.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PASS=0
FAIL=0
ok()   { printf '  \033[1;32mok\033[0m    %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[1;31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL + 1)); }
note() { printf '\033[1;36m[logs-selftest]\033[0m %s\n' "$1"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# A project root is all logs.sh needs; it does not touch git.
ROOT="${WORK}/root"
mkdir -p "$ROOT"
printf 'services: {}\n' > "${ROOT}/docker-compose.prod.yml"
printf 'JWT_SECRET=not-a-real-secret\n' > "${ROOT}/.env.production"

BIN="${WORK}/bin"
mkdir -p "$BIN"

# `ps -q <svc>` decides "is it running": prints an id for the services named in
# $FAKE_RUNNING and nothing for the rest. `logs` always succeeds with a line,
# which is the point — the real one succeeds for a service that is not there
# too, and inferring liveness from it is the defect.
cat > "${BIN}/docker" <<'STUB'
#!/usr/bin/env bash
# argv goes to a file as well as the answer to stdout: the cases that ask
# "did the flag reach compose" have nowhere else to read it from.
[[ -n "${FAKE_DOCKER_LOG:-}" ]] && printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
svc="${@: -1}"
case "$*" in
    *' ps -q '*)
        case " ${FAKE_RUNNING:-} " in
            *" $svc "*) echo "container-$svc" ;;
        esac
        ;;
    *' logs '*) echo "LOGLINE from $svc" ;;
esac
exit 0
STUB
chmod +x "${BIN}/docker"

# journalctl exits 0 whatever you ask it for. That is not a simplification of
# the real one; it is what the real one does, and it is why the guard it used
# to back could not fire.
cat > "${BIN}/journalctl" <<'STUB'
#!/usr/bin/env bash
echo "-- No entries --"
exit 0
STUB
chmod +x "${BIN}/journalctl"

cat > "${BIN}/systemctl" <<'STUB'
#!/usr/bin/env bash
case "$*" in
    'list-unit-files caddy.service')
        [[ "${FAKE_CADDY_UNIT:-0}" == "1" ]] || exit 1
        echo "caddy.service enabled"
        ;;
esac
exit 0
STUB
chmod +x "${BIN}/systemctl"

# The "this host has no systemctl" cases need a PATH that really does not have
# one, so $BIN carries its own copies of the few externals the script reaches
# for and those cases run with PATH=$BIN alone. Hiding the stub while the
# system directories are still on PATH would just find /usr/bin/systemctl —
# which answers about THIS machine's caddy, and the case would pass for a
# reason that has nothing to do with the code.
for tool in bash dirname basename sed grep cat; do
    ln -sf "$(command -v "$tool")" "${BIN}/${tool}"
done

OUT="${WORK}/out.txt"
LOG="${WORK}/docker.log"
run_logs() {
    : > "$LOG"
    (
        cd "$ROOT"
        PATH="${USE_PATH:-${BIN}:${PATH}}" \
        FAKE_RUNNING="${RUNNING:-}" \
        FAKE_CADDY_UNIT="${CADDY_UNIT:-0}" \
        FAKE_DOCKER_LOG="$LOG" \
        bash "${SCRIPT_DIR}/logs.sh" "$@" >"$OUT" 2>&1
    )
    echo $?
}

# ───── The harness's own control ─────
#
# Every case reads $OUT for a phrase, so a run that produced nothing would pass
# by finding no wrong phrase in it.
note "the harness itself"
rc="$(RUNNING="backend frontend postgres redis" CADDY_UNIT=1 run_logs)"
if [[ "$rc" == "0" ]]; then
    ok "an all-services run with everything up exits 0"
else
    bad "an all-services run exited $rc:
$(sed 's/^/      /' "$OUT")"
fi
if grep -q 'LOGLINE from backend' "$OUT"; then
    ok "and printed the logs it was given"
else
    bad "no service output reached the report; every case below is vacuous"
fi

# ───── A service that is not there has to SAY so ─────
note "a service with no container"
rc="$(RUNNING="frontend postgres redis" CADDY_UNIT=1 run_logs)"
if grep -q "backend' has no container running" "$OUT"; then
    ok "the down service is named"
else
    bad "a backend with no container produced a heading and nothing else:
$(sed 's/^/      /' "$OUT")"
fi
if grep -q 'LOGLINE from frontend' "$OUT"; then
    ok "and the ones that ARE up are still reported"
else
    bad "one missing service silenced the rest"
fi
if [[ "$rc" == "0" ]]; then
    ok "a down service is reported, not treated as a failure of the tool"
else
    bad "logs.sh exited $rc because a service was down"
fi

# ───── Caddy: installed, not installed, no systemd ─────
note "caddy"
RUNNING="backend frontend postgres redis" CADDY_UNIT=0 run_logs >/dev/null
if grep -q 'no caddy systemd unit on this host' "$OUT"; then
    ok "a host with no caddy unit is told so"
else
    bad "the caddy block was empty and unexplained, which is what a healthy quiet caddy also looks like:
$(sed 's/^/      /' "$OUT")"
fi

RUNNING="backend frontend postgres redis" CADDY_UNIT=1 run_logs >/dev/null
if grep -q 'no caddy systemd unit' "$OUT"; then
    bad "a host WITH the unit was told it has none"
else
    ok "a host with the unit is not told it has none"
fi

# The control on the control: without systemd at all, it must still read the
# journal rather than refuse. A container image with journalctl and no
# systemctl is an ordinary shape.
mv "${BIN}/systemctl" "${WORK}/systemctl.hidden"
rc="$(USE_PATH="$BIN" RUNNING="backend frontend postgres redis" run_logs caddy)"
if [[ "$rc" == "0" ]] && ! grep -q 'no caddy systemd unit' "$OUT"; then
    ok "with no systemctl it reads the journal instead of refusing"
else
    bad "a host without systemctl was refused (exit $rc):
$(sed 's/^/      /' "$OUT")"
fi
mv "${WORK}/systemctl.hidden" "${BIN}/systemctl"

# And with no journalctl either, it says which tool is missing rather than
# printing an empty block.
mv "${BIN}/journalctl" "${WORK}/journalctl.hidden"
USE_PATH="$BIN" RUNNING="backend frontend postgres redis" run_logs caddy >/dev/null
if grep -q "journalctl not available" "$OUT"; then
    ok "with no journalctl it names the missing tool"
else
    bad "no journalctl and no explanation:
$(sed 's/^/      /' "$OUT")"
fi
mv "${WORK}/journalctl.hidden" "${BIN}/journalctl"

# ───── Arguments ─────
note "arguments"
rc="$(RUNNING="backend" run_logs --definitely-not-a-flag)"
if [[ "$rc" == "2" ]]; then
    ok "an unknown flag exits 2"
else
    bad "an unknown flag exited $rc"
fi

RUNNING="backend frontend postgres redis" CADDY_UNIT=1 run_logs be >/dev/null
if grep -q 'LOGLINE from backend' "$OUT" && ! grep -q 'LOGLINE from redis' "$OUT"; then
    ok "a service alias narrows the report to that service"
else
    bad "'be' did not narrow to the backend:
$(sed 's/^/      /' "$OUT")"
fi

# An unknown FLAG exits 2 naming itself; an unusable VALUE for a known flag used
# to go straight through to compose, which answers with its own error text about
# something the operator was not asking about.
for bad_tail in "--tail=abc" "--tail=" "--tail=-5"; do
    rc="$(RUNNING="backend" run_logs "$bad_tail")"
    if [[ "$rc" == "2" ]] && grep -q 'wants a number of lines' "$OUT"; then
        ok "$bad_tail is refused here, with the reason"
    else
        bad "$bad_tail exited $rc and said:
$(sed 's/^/      /' "$OUT")"
    fi
done

# ...and the values that ARE usable must still pass, or the check above just
# broke the flag. `all` is docker's own word for "no limit".
for good_tail in "--tail=500" "--tail=all"; do
    rc="$(RUNNING="backend frontend postgres redis" CADDY_UNIT=1 run_logs "$good_tail")"
    want="${good_tail#--tail=}"
    if [[ "$rc" == "0" ]] && grep -q -- "--tail=$want" "$LOG"; then
        ok "$good_tail reaches compose unchanged"
    else
        bad "$good_tail exited $rc; docker calls were:
$(sed 's/^/      /' "$LOG")"
    fi
done

# Follow mode is what an operator watching an incident actually runs, and the
# only thing that makes it follow is the flag reaching compose.
RUNNING="backend frontend postgres redis" CADDY_UNIT=1 run_logs be -f >/dev/null
if grep -qE 'logs .*-f( |$)' "$LOG"; then
    ok "-f is passed through to compose"
else
    bad "-f never reached compose; docker calls were:
$(sed 's/^/      /' "$LOG")"
fi

echo
if [[ $FAIL -eq 0 ]]; then
    printf '\033[1;32m%d/%d check(s) passed\033[0m\n' "$PASS" "$((PASS + FAIL))"
    exit 0
fi
printf '\033[1;31m%d/%d check(s) passed, %d failed\033[0m\n' "$PASS" "$((PASS + FAIL))" "$FAIL"
exit 1
