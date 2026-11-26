#!/usr/bin/env bash
# deploy-selftest.sh
#
# A round-trip on the three deploy scripts, which nothing checked.
#
# This is not a hypothesis about them. The same instrument has now been pointed
# at this layer three times and come back with four real defects — three in the
# backup pair and one in `retry`, which every `docker compose build` in these
# three scripts is wrapped in — and all four had the same shape: a guard that
# reads correctly and cannot fire. `retry` is the one that matters most here:
# it returned 0 after exhausting every attempt, so a build that failed three
# times let the deploy walk on to migrate and restart with the old images and
# report success. That was found in the library. Nothing observed it through
# the script.
#
# What the scripts promise, in their own comments, is an ORDER and a
# CONSEQUENCE: build before migrate ("migrate-first against the old image
# silently skips a freshly-added migration"), and a failure anywhere stops the
# deploy rather than reporting a version that is not running. Both are checked
# here by running the real scripts.
#
# How, without a fleet: `docker` is replaced on PATH by a stub that records
# every argv and exits as the case asks, and the project root is a throwaway
# git clone with a compose file and an .env.production that are never read by
# anything real. Nothing here touches a live stack, a registry or the network,
# and it refuses to start if the fake root is not the one it built.
#
# The deploy is the base's: six steps (sync, build, migrate, restart, host
# Caddy, verify), a hand-over to the freshly synced copy of itself
# (ICESLAB_DEPLOY_REEXEC, covered in depth by deploy_reexec_test.go, only the
# guard is checked here), `--caddy-only`, and a health wait on the backend.
# The host Caddy step is pointed at a file that does not exist
# (CADDYFILE_PATH), so it never touches the machine this runs on, and `sleep`
# is a stub, so the retry backoff does not cost 15 s per failing build.
#
# Needs: bash and git. No docker, no network, no privileges.
# Takes: about 10 s (the .env backup ring waits out the one-second resolution
# of its own file names, seven times).
#
# Run locally, from anywhere in the repository (CI runs the same file, in the
# `ops-selftests` job of ci.yml, on every change under scripts/**):
#   ./scripts/ops/deploy-selftest.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PASS=0
FAIL=0
ok()   { printf '  \033[1;32mok\033[0m    %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[1;31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL + 1)); }
note() { printf '\033[1;36m[deploy-selftest]\033[0m %s\n' "$1"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git_quiet() { git -c advice.detachedHead=false -c init.defaultBranch=main "$@" >/dev/null 2>&1; }

# ───── The throwaway project root ─────
#
# An origin plus a clone, the same shape lib-selftest.sh uses, because
# `git_sync_to_ref` runs for real: it is step 1 of all three scripts and a
# stubbed git would test the stub.
ORIGIN="${WORK}/origin"
mkdir -p "$ORIGIN"
(
    cd "$ORIGIN"
    git_quiet init
    git_quiet config user.email t@t
    git_quiet config user.name t
    echo one > file.txt
    # The two files require_compose_root looks for, committed HERE rather than
    # in the clone. Contents are irrelevant — the only thing that ever reads
    # them is the docker stub, which does not — but their being TRACKED is not:
    # step 1 of every deploy is `git_sync_to_ref`, it refuses a dirty tree, and
    # then checks the branch out from origin. A fixture that committed them
    # only in the clone gets them deleted by that checkout, and every later
    # case finds no compose file and exits before reaching the thing it is
    # checking. (Pushing from the clone is not the fix: origin has main checked
    # out, so the push is refused and the refusal is easy to miss.)
    printf 'services: {}\n' > docker-compose.prod.yml
    # Mirrors the real repository, where `.env.*` covers both the live secrets
    # file and deploy.sh's own timestamped backups of it.
    printf '.env.*\n' > .gitignore
    git_quiet add .
    git_quiet commit -m one
)

ROOT="${WORK}/root"
git clone "$ORIGIN" "$ROOT" >/dev/null 2>&1
(cd "$ROOT" && git_quiet config user.email t@t && git_quiet config user.name t)
printf 'JWT_SECRET=not-a-real-secret\n' > "${ROOT}/.env.production"
chmod 600 "${ROOT}/.env.production"

# Refuse to run anywhere near a real deployment. The backup self-test next door
# has the same rule for the same reason: these scripts restart services and
# rewrite .env backups, and the cost of pointing them at the wrong directory is
# not recoverable by reading the output afterwards.
if [[ "$ROOT" != "$WORK"/* ]] || [[ ! -e "${ROOT}/.git" ]]; then
    printf '\033[1;31mrefusing to run: the fake project root is not the one this script built\033[0m\n' >&2
    exit 1
fi

# ───── The docker stub ─────
#
# Records `docker <args...>` one call per line, and exits non-zero when its
# first two words match $FAKE_DOCKER_FAIL. That switch is what makes the
# failure cases possible: a real build cannot be asked to fail on demand.
BIN="${WORK}/bin"
mkdir -p "$BIN"
cat > "${BIN}/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
if [[ -n "${FAKE_DOCKER_FAIL:-}" ]]; then
    case "$*" in
        $FAKE_DOCKER_FAIL) exit 17 ;;
    esac
fi
case "$*" in
    # `ps -q <service>` yields the container id the health wait then inspects.
    *' ps -q '*) echo "fake-container-id" ;;
    # The health wait's own question. $FAKE_HEALTH is what makes the "a
    # backend that never comes up" case possible: a real one cannot be asked
    # to fail on demand either.
    'inspect '*) echo "${FAKE_HEALTH:-healthy}" ;;
esac
# `compose exec -T postgres pg_isready` decides the wait loop; answer yes so
# the cases below are not each paying 30 seconds for it.
exit 0
STUB
chmod +x "${BIN}/docker"
# `sleep` is the retry backoff (5 s, then 10 s) and the pg_isready pause; the
# decisions under test do not depend on the time passing.
printf '#!/usr/bin/env bash\nexit 0\n' > "${BIN}/sleep"
chmod +x "${BIN}/sleep"

# run_deploy <script> [script args...] -> prints the exit code; the docker calls
# land in $LOG and the script's own output in $LOG.out.
#
# $LOG is a fixed path rather than one the function picks: run_deploy is called
# inside `$( )`, so anything it assigns is lost with the subshell, and a case
# reading a variable set in there would be reading an empty name — which reads
# as "no such call" and passes.
#
# The failure switch travels in $FAIL_GLOB rather than the argument list, so the
# argument cases can pass real flags through.
LOG="${WORK}/docker.log"
run_deploy() {
    local script="$1"; shift
    : > "$LOG"
    : > "${LOG}.out"
    (
        cd "$ROOT"
        PATH="${BIN}:${PATH}" \
        FAKE_DOCKER_LOG="$LOG" \
        FAKE_DOCKER_FAIL="${FAIL_GLOB:-}" \
        FAKE_HEALTH="${HEALTH:-healthy}" \
        CADDYFILE_PATH="${WORK}/no-such-caddy/Caddyfile" \
        bash "${SCRIPT_DIR}/${script}" "$@" >"${LOG}.out" 2>&1
    )
    echo $?
}

# Every case below concludes something from the ABSENCE of a docker call, so
# each one first has to know the script got as far as running any. Without this
# a script that died at step 1 — the wrong directory, a refused sync — reads as
# a script that correctly declined to do anything.
saw_calls() {
    if [[ -s "$LOG" ]]; then return 0; fi
    bad "$1: the script made no docker calls at all; it exited before the part under test. Output:
$(sed 's/^/      /' "${LOG}.out")"
    return 1
}

# Position of the first docker call whose text matches a glob, or "" if none.
call_index() {
    local glob="$1" i=1 line
    while IFS= read -r line; do
        # shellcheck disable=SC2254
        case "$line" in
            $glob) echo "$i"; return 0 ;;
        esac
        i=$((i + 1))
    done < "$LOG"
    echo ""
}

# ───── The stub's own control ─────
#
# Every case below reads the log the stub writes, so a stub that recorded
# nothing would make each of them pass by finding no violation. Checked first,
# and checked against a script that is supposed to succeed.
note "the harness itself"
rc="$(run_deploy deploy.sh)"
if [[ "$rc" == "0" ]]; then
    ok "a deploy where every docker call succeeds exits 0"
else
    bad "a clean deploy exited $rc; output:
$(sed 's/^/      /' "${LOG}.out")"
fi
if [[ -s "$LOG" ]]; then
    ok "the docker stub recorded $(wc -l < "$LOG") call(s)"
else
    bad "the docker stub recorded nothing; every case below would pass vacuously"
fi

# ───── The six steps, in the order the header promises ─────
note "the six steps"
run_deploy deploy.sh >/dev/null
prev=0
in_order=1
for n in 1 2 3 4 5 6; do
    pos="$(grep -n -F "[${n}/6]" "${LOG}.out" | cut -d: -f1 | sed -n 1p)"
    if [[ -z "$pos" ]] || (( pos <= prev )); then
        in_order=0
        bad "step [${n}/6] is missing or out of order in the output"
        break
    fi
    prev="$pos"
done
if (( in_order == 1 )); then ok "steps [1/6] .. [6/6] appear in order"; fi
OUT_ALL="$(cat "${LOG}.out")"
if [[ "$OUT_ALL" == *"[5/6]"*"host Caddy"* && "$OUT_ALL" == *"no host Caddy here"* ]]; then
    ok "step 5 is the host Caddy, and on a host without one it only says so"
else
    bad "step 5 is not the host Caddy step, or it did something on a host without Caddy"
fi
restart="$(call_index 'compose*up -d --build*')"
psq="$(call_index '*ps -q backend*')"
if [[ -n "$restart" && -n "$psq" ]] && (( restart < psq )); then
    ok "the restart comes before the health wait on the backend"
else
    bad "the health wait (call '$psq') does not follow the restart (call '$restart')"
fi

note "--caddy-only"
rc="$(run_deploy deploy.sh --caddy-only)"
OUT_ALL="$(cat "${LOG}.out")"
if [[ "$rc" == "0" && "$OUT_ALL" == *"[1/1] host Caddy"* ]]; then
    ok "--caddy-only runs the host Caddy step alone and exits 0"
else
    bad "--caddy-only exited $rc; output:
$(sed 's/^/      /' "${LOG}.out")"
fi
if [[ ! -s "$LOG" ]]; then
    ok "and it ran no docker, so nothing was built or restarted"
else
    bad "--caddy-only ran docker: $(cat "$LOG")"
fi
if [[ "$OUT_ALL" != *"deploy complete"* ]]; then
    ok "and it does not announce a deployed commit"
else
    bad "--caddy-only printed 'deploy complete'"
fi

note "the hand-over guard"
# The copy deploy.sh starts after a sync that changed it has
# ICESLAB_DEPLOY_REEXEC=1: it must not sync again, and must not write a second
# .env snapshot (the first run has just made it).
rm -f "${ROOT}"/.env.production.bak.*
run_deploy deploy.sh >/dev/null
before="$(find "$ROOT" -maxdepth 1 -name '.env.production.bak.*' | wc -l)"
ICESLAB_DEPLOY_REEXEC=1 run_deploy deploy.sh >/dev/null
after="$(find "$ROOT" -maxdepth 1 -name '.env.production.bak.*' | wc -l)"
OUT_ALL="$(cat "${LOG}.out")"
if [[ "$before" == "1" && "$after" == "1" ]]; then
    ok "a handed-over run does not take a second .env snapshot"
else
    bad "snapshots: $before after a plain run, $after after a handed-over one"
fi
if [[ "$OUT_ALL" == *"done before the hand-over"* && "$OUT_ALL" == *"deploy complete"* ]]; then
    ok "it skips the sync, says so, and still completes the other steps"
else
    bad "a handed-over run did not skip the sync or did not complete:
$(sed 's/^/      /' "${LOG}.out")"
fi

# ───── The order the comments insist on ─────
note "build before migrate"
for script in deploy.sh deploy-backend.sh; do
    rc="$(run_deploy "$script")"
    saw_calls "$script" || continue
    build="$(call_index 'compose*build*')"
    migrate="$(call_index '*--exit-code-from migrate*')"
    if [[ -z "$build" || -z "$migrate" ]]; then
        bad "$script: could not find both a build ($build) and a migrate ($migrate) in:
$(sed 's/^/      /' "$LOG")"
    elif (( build < migrate )); then
        ok "$script builds the image before running migrations from it"
    else
        bad "$script ran migrate (call $migrate) before build (call $build): a deploy that adds a migration would skip it, and the new backend would boot on an un-migrated database"
    fi
done

# ───── A failure has to stop the deploy ─────
#
# This is the shape of the `retry` defect one level up. `retry 3` wraps every
# build in all three scripts; when it returned 0 after exhausting its attempts,
# the deploy went on to migrate and restart, and told the operator it was now
# serving a commit whose image had never been built.
note "a failed build stops the deploy"
for script in deploy.sh deploy-backend.sh deploy-frontend.sh; do
    rc="$(FAIL_GLOB='compose*build*' run_deploy "$script")"
    saw_calls "$script" || continue
    up="$(call_index 'compose*up -d*')"
    migrate="$(call_index '*--exit-code-from migrate*')"
    if [[ "$rc" == "0" ]]; then
        bad "$script reported success after every build attempt failed"
    else
        ok "$script exits $rc when the build cannot be made to work"
    fi
    if [[ -n "$migrate" ]]; then
        bad "$script ran migrations against an image that failed to build"
    fi
    if [[ -n "$up" ]]; then
        bad "$script restarted services after a failed build, so the old image keeps serving under a new commit's name"
    else
        ok "$script starts nothing after a failed build"
    fi
done

note "a failed service start says the deploy is not complete"
rc="$(FAIL_GLOB='compose*up -d --build*' run_deploy deploy.sh)"
if saw_calls deploy.sh; then
    out="$(cat "${LOG}.out")"
    if [[ "$rc" != "0" && "$out" == *'NOT complete'* && "$out" == *'ICESLAB_REF=<previous tag>'* ]]; then
        ok "deploy.sh exits $rc and names the way out when 'up -d --build' fails"
    else
        bad "a failed 'up -d --build' gave exit $rc without the NOT complete message"
    fi
fi

note "a failed migration stops the deploy"
for script in deploy.sh deploy-backend.sh; do
    # Only the one-shot migrate fails; postgres and the builds are fine.
    rc="$(FAIL_GLOB='*--exit-code-from migrate*' run_deploy "$script")"
    saw_calls "$script" || continue
    if [[ "$rc" == "0" ]]; then
        bad "$script reported success after the migration failed"
    else
        ok "$script exits $rc when a migration fails"
    fi
    # `up -d postgres` is expected; `up -d --build` (the service restart) is not.
    if [[ -n "$(call_index 'compose*up -d --build*')" ]]; then
        bad "$script restarted the services on a database whose migration failed"
    else
        ok "$script leaves the services alone when the migration failed"
    fi
done

# ───── Arguments ─────
note "arguments"
rc="$(run_deploy deploy.sh --definitely-not-a-flag)"
if [[ "$rc" == "2" ]]; then
    ok "an unknown flag exits 2 rather than being ignored"
else
    bad "an unknown flag exited $rc"
fi
if [[ -s "$LOG" ]]; then
    bad "an unknown flag still ran $(wc -l < "$LOG") docker call(s)"
else
    ok "and nothing was run before the refusal"
fi

run_deploy deploy.sh >/dev/null
saw_calls "default build" || true
calls="$(cat "$LOG")"
if [[ "$calls" == *'--no-cache'* ]]; then
    ok "the default build is --no-cache, as the help says"
else
    bad "the default build did not pass --no-cache"
fi
run_deploy deploy.sh --cache >/dev/null
saw_calls "--cache build" || true
calls="$(cat "$LOG")"
if [[ "$calls" == *'build --no-cache'* ]]; then
    bad "--cache still built with --no-cache"
else
    ok "--cache drops it"
fi

# ───── The secrets backup ring ─────
#
# .env.production holds the only copy of JWT_SECRET, the postgres password and
# the node mTLS CA on a panel host. deploy.sh snapshots it before touching
# anything and keeps five; a ring that quietly keeps zero looks identical in
# the log line it prints.
note ".env.production backup ring"
rm -f "${ROOT}"/.env.production.bak.*
for _ in 1 2 3 4 5 6 7; do
    run_deploy deploy.sh >/dev/null
    # The suffix has one-second resolution, so back-to-back runs would
    # overwrite each other and the ring could never fill.
    sleep 1.05
done
count="$(find "$ROOT" -maxdepth 1 -name '.env.production.bak.*' | wc -l)"
if (( count == 5 )); then
    ok "seven deploys leave exactly five snapshots"
else
    bad "seven deploys left $count snapshot(s), want 5"
fi
newest="$(find "$ROOT" -maxdepth 1 -name '.env.production.bak.*' | sort | tail -1)"
if [[ -n "$newest" && "$(cat "$newest")" == *JWT_SECRET* ]]; then
    ok "and a snapshot holds the file's contents"
else
    bad "the newest snapshot does not contain what it was copying"
fi
if [[ -n "$newest" ]] && [[ "$(stat -c '%a' "$newest")" == "600" ]]; then
    ok "with the 600 perms preserved, so a secret is not left world-readable"
else
    bad "snapshot perms are $(stat -c '%a' "$newest" 2>/dev/null), want 600"
fi

# ───── Wrong directory ─────
note "run from the wrong place"
mkdir -p "${WORK}/elsewhere"
rc="$(
    cd "${WORK}/elsewhere"
    PATH="${BIN}:${PATH}" FAKE_DOCKER_LOG="${WORK}/stray.log" \
        bash "${SCRIPT_DIR}/deploy.sh" >/dev/null 2>&1
    echo $?
)"
# require_compose_root walks up from the SCRIPT's own directory, which in this
# repository is a checkout with no .env.production, so it must refuse.
if [[ "$rc" != "0" ]]; then
    ok "a deploy launched outside a panel root refuses (exit $rc)"
else
    bad "a deploy launched outside a panel root ran anyway"
fi
if [[ ! -s "${WORK}/stray.log" ]]; then
    ok "and touched no docker"
else
    bad "it ran: $(cat "${WORK}/stray.log")"
fi

# ───── The deploy has to be over before it says so ─────
#
# Every script here ends by announcing the commit it is "now serving". Until
# 2026-08-26 nothing checked that anything was serving it: step 5 printed `ps`
# and a log tail, nobody read either, and a backend crash-looping on a bad
# migration produced exactly the same final line as one that came up. The
# operator's next signal was a user complaining.
note "an unhealthy service is not a completed deploy"
for pair in "deploy.sh:backend" "deploy-backend.sh:backend" "deploy-frontend.sh:frontend"; do
    script="${pair%%:*}"
    svc="${pair##*:}"
    # A budget-length wait would cost minutes across three scripts; `exited` is
    # the crash-loop's own state and fails on the first look, which is the
    # behaviour worth pinning anyway — a dead container should not cost the
    # operator a two-minute wait to be told so.
    rc="$(HEALTH=exited run_deploy "$script")"
    saw_calls "$script" || continue
    if [[ "$rc" == "0" ]]; then
        bad "$script reported success with $svc down"
    else
        ok "$script exits $rc when $svc never comes up"
    fi
    out="$(cat "${LOG}.out")"
    if [[ "$out" == *'deploy complete'* ]]; then
        bad "$script still printed 'deploy complete'"
    else
        ok "$script does not announce a commit it is not serving"
    fi
done

# `unhealthy` is the healthcheck's own verdict: also the end of the wait.
rc="$(HEALTH=unhealthy run_deploy deploy.sh)"
if [[ "$rc" == "1" ]]; then
    ok "deploy.sh exits 1 on an unhealthy backend"
else
    bad "an unhealthy backend gave exit $rc, want 1"
fi

# The control: the same wait must not reject a service that IS up, or every
# deploy on the fleet starts failing and the check gets removed again.
rc="$(HEALTH=healthy run_deploy deploy.sh)"
out="$(cat "${LOG}.out")"
if [[ "$rc" == "0" && "$out" == *'deploy complete'* ]]; then
    ok "a healthy backend still completes the deploy"
else
    bad "a healthy backend was reported as a failed deploy (exit $rc)"
fi
# A service with no healthcheck reports its plain state, and `running` is the
# most that can be known about it. Rejecting that would block every
# frontend-only deploy.
rc="$(HEALTH=running run_deploy deploy-frontend.sh)"
if [[ "$rc" == "0" ]]; then
    ok "a container with no healthcheck passes on 'running'"
else
    bad "a running container with no healthcheck was rejected (exit $rc)"
fi

echo
if [[ $FAIL -eq 0 ]]; then
    printf '\033[1;32m%d/%d check(s) passed\033[0m\n' "$PASS" "$((PASS + FAIL))"
    exit 0
fi
printf '\033[1;31m%d/%d check(s) passed, %d failed\033[0m\n' "$PASS" "$((PASS + FAIL))" "$FAIL"
exit 1
