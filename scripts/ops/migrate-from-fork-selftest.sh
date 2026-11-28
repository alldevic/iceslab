#!/usr/bin/env bash
# migrate-from-fork-selftest.sh
#
# The shell half of the move from the old fork (milestone 20.3): what
# migrate-from-fork.sh promises about ORDER and about what it does NOT do.
# The data half (pre-check, transforms, verification on a real Postgres) is
# apps/panel-backend/scripts/fork-migration/*.test.ts.
#
# Promises checked here, by running the real script against a stub `docker`
# that records every call:
#   - --check changes nothing: no stop, no backup, no Redis flush, no swap;
#   - a blocking finding of the pre-check stops --run BEFORE the panel is stopped;
#   - the order of --run: image, pre-check, backup, stop, migrate, env, flush, swap, build, up;
#   - a failed migration brings the old panel back and swaps nothing;
#   - --accept-loss needs the typed sentence, --yes does not stand in for it;
#   - TRUST_PROXY_HOPS is written out explicitly when the env file lacks it;
#   - a moved installation is refused a second --run; --rollback needs the state file;
#   - arguments and wrong directories are refused in words.
#
# Needs: bash and git. No docker, no network, no privileges. About 5 s.
#   ./scripts/ops/migrate-from-fork-selftest.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0
ok()   { printf '  \033[1;32mok\033[0m    %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[1;31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL + 1)); }
note() { printf '\033[1;36m[migrate-from-fork-selftest]\033[0m %s\n' "$1"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git_quiet() { git -c advice.detachedHead=false -c init.defaultBranch=main "$@" >/dev/null 2>&1; }

# The "new fork": an origin the installation's checkout is switched to.
ORIGIN="${WORK}/new-fork"
mkdir -p "$ORIGIN"
(
    cd "$ORIGIN"
    git_quiet init
    git_quiet config user.email t@t
    git_quiet config user.name t
    echo new > file.txt
    printf 'services: {}\n' > docker-compose.prod.yml
    printf '.env.*\n.migrate-from-fork.state*\nbackups\n' > .gitignore
    git_quiet add .
    git_quiet commit -m new
)

# The installation of the "old fork": a clone with its compose file and env.
PANEL="${WORK}/panel"
OLD_ORIGIN="${WORK}/old-fork"
mkdir -p "$OLD_ORIGIN"
(
    cd "$OLD_ORIGIN"
    git_quiet init
    git_quiet config user.email t@t
    git_quiet config user.name t
    echo old > file.txt
    printf 'services: {}\n' > docker-compose.prod.yml
    printf '.env.*\n.migrate-from-fork.state*\nbackups\n' > .gitignore
    git_quiet add .
    git_quiet commit -m old
)
git clone "$OLD_ORIGIN" "$PANEL" >/dev/null 2>&1
write_env() {
    cat > "${PANEL}/.env.production" <<ENV
POSTGRES_USER=iceslab
POSTGRES_PASSWORD=pw
POSTGRES_DB=iceslab
DATABASE_URL=postgres://iceslab:pw@postgres:5432/iceslab
REDIS_URL=redis://redis:6379
JWT_SECRET=${JWT:-a-very-long-secret-of-the-old-panel}
${EXTRA_ENV:-}
ENV
}
write_env
if [[ "$PANEL" != "$WORK"/* ]]; then printf 'refusing: fake panel not built here\n' >&2; exit 1; fi

# ───── stubs ─────
BIN="${WORK}/bin"
mkdir -p "$BIN"
cat > "${BIN}/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
    ps) printf 'iceslab-prod-postgres\niceslab-prod-redis\niceslab-prod-backend\niceslab-prod-frontend\nomega-stand-postgres\nomega-stand-redis\nomega-stand-backend\nomega-stand-frontend\n' ;;
    inspect)
        case "$*" in
            *Networks*)  echo "fake_default " ;;
            *Config.Env*) echo "TRUST_PROXY_HOPS=${FAKE_HOPS:-1}" ;;
            *State.Health*|*Health.Status*) echo "${FAKE_HEALTH:-healthy}" ;;
            *.Image*) echo "sha256:oldimage" ;;
            *) echo "healthy" ;;
        esac ;;
    exec)
        case "$*" in
            *pg_database_size*) echo 1000 ;;
            *df\ -Pk*) printf 'Filesystem 1024-blocks Used Available Capacity Mounted\nfs 100 1 99999999 1%% /\n' ;;
        esac ;;
    run)
        # the compiled script: find where it writes, answer as the case wants
        cmd=""; for a in "$@"; do case "$a" in check|migrate|swap|unswap) cmd="$a" ;; esac; done
        out=""; host=""; prev=""
        for a in "$@"; do
            [[ "$prev" == "--out" ]] && out="$a"
            [[ "$prev" == "-v" && "$a" == *:/out ]] && host="${a%%:/out}"
            prev="$a"
        done
        if [[ -n "$out" && -n "$host" ]]; then printf '%s\n' "${FAKE_REPORT:-{\}}" > "$host/${out#/out/}"; fi
        var="FAKE_EXIT_$(echo "$cmd" | tr a-z A-Z)"
        exit "${!var:-0}" ;;
    compose)
        case "$*" in *' ps -q '*) echo fake-container-id ;; esac ;;
    image)
        case "$2" in ls) echo sha256:migrationimage ;; esac ;;
esac
exit 0
STUB
chmod +x "${BIN}/docker"
printf '#!/usr/bin/env bash\nexit 0\n' > "${BIN}/sleep"; chmod +x "${BIN}/sleep"
cat > "${BIN}/backup-stub" <<'STUB'
#!/usr/bin/env bash
printf 'BACKUP %s\n' "$*" >> "$FAKE_DOCKER_LOG"
exit 0
STUB
chmod +x "${BIN}/backup-stub"

LOG="${WORK}/docker.log"
run_script() { # run_script [args...] -> exit code; stdin from $STDIN_TEXT
    : > "$LOG"; : > "${LOG}.out"
    (
        cd "$WORK"
        PATH="${BIN}:${PATH}" FAKE_DOCKER_LOG="$LOG" ICESLAB_BACKUP_SCRIPT="${BIN}/backup-stub" \
        ICESLAB_MIGRATE_IMAGE="${IMAGE:-iceslab-backend:test}" \
        FAKE_REPORT="${REPORT:-{\}}" FAKE_EXIT_CHECK="${EXIT_CHECK:-0}" FAKE_EXIT_MIGRATE="${EXIT_MIGRATE:-0}" FAKE_HOPS="${HOPS:-1}" \
        bash "${SCRIPT_DIR}/migrate-from-fork.sh" --panel-dir "$PANEL" --repo "$ORIGIN" --ref main "$@" \
        <<<"${STDIN_TEXT:-}" >"${LOG}.out" 2>&1
    )
    echo $?
}
idx() { # first call matching a glob, or ""
    local i=1 line
    while IFS= read -r line; do
        # shellcheck disable=SC2254
        case "$line" in $1) echo "$i"; return 0 ;; esac
        i=$((i + 1))
    done < "$LOG"
    echo ""
}
reset_panel() {
    rm -f "$PANEL"/.migrate-from-fork.state*
    (cd "$PANEL" && git_quiet remote set-url origin "$OLD_ORIGIN" && git_quiet fetch --force origin '+refs/heads/*:refs/remotes/origin/*' && git_quiet checkout --force main && git_quiet reset --hard origin/main)
    EXTRA_ENV="" write_env
}
expect() { # expect "name" cond-result
    if [[ "$2" == yes ]]; then ok "$1"; else bad "$1"$'\n'"$(sed 's/^/      /' "${LOG}.out"; echo ---; sed 's/^/      /' "$LOG")"; fi
}
yn() { if eval "$1"; then echo yes; else echo no; fi; }

note "arguments and places"
rc="$(run_script)"; expect "no mode is refused (exit 2)" "$(yn '[[ $rc == 2 ]]')"
rc="$(run_script --frobnicate)"; expect "an unknown flag is refused (exit 2)" "$(yn '[[ $rc == 2 ]]')"
rc="$(run_script -h)"; expect "-h prints the help and exits 0" "$(yn '[[ $rc == 0 ]] && grep -q "ONE-OFF" "${LOG}.out"')"
( cd "$WORK"; PATH="${BIN}:${PATH}" FAKE_DOCKER_LOG="$LOG" bash "${SCRIPT_DIR}/migrate-from-fork.sh" --check --panel-dir "${WORK}/nowhere" >"${LOG}.out" 2>&1 ); rc=$?
expect "a directory with no installation is refused in words" "$(yn '[[ $rc == 1 ]] && grep -q "no installation at" "${LOG}.out"')"

note "--check changes nothing"
rc="$(run_script --check)"
expect "--check exits 0" "$(yn '[[ $rc == 0 ]]')"
expect "--check runs the pre-check of the compiled script, on the compose network, with the old JWT_SECRET" "$(yn 'grep -q "^run .*--network fake_default .*JWT_SECRET=a-very-long-secret-of-the-old-panel.* check --out /out/pre-check-" "$LOG"')"
expect "--check does not stop, back up, flush or swap" "$(yn '[[ -z "$(idx "compose*stop*")" && -z "$(idx "BACKUP*")" && -z "$(idx "exec*FLUSHALL*")" && -z "$(idx "run*swap*")" && -z "$(idx "run*migrate*")" ]]')"
EXIT_CHECK=3; rc="$(run_script --check)"; EXIT_CHECK=0
expect "--check on a blocking finding exits 1 and says nothing was changed" "$(yn '[[ $rc == 1 ]] && grep -q "nothing was changed" "${LOG}.out"')"

note "--run: order"
reset_panel
rc="$(run_script --run --yes)"
expect "--run --yes goes through (exit 0)" "$(yn '[[ $rc == 0 ]]')"
a="$(idx "run*check --out*")"; b="$(idx "BACKUP*before*")"; c="$(idx "compose*stop backend frontend*")"; d="$(idx "run*migrate --out*")"
e="$(idx "BACKUP*migrated*")"; f="$(idx "exec*redis-cli FLUSHALL*")"; g="$(idx "run*swap*")"; h="$(idx "compose*build backend frontend*")"; i="$(idx "compose*up -d")"
expect "the order is pre-check, backup, stop, migrate, backup of the copy, flush, swap, build, up" \
    "$(yn '[[ -n "$a" && -n "$b" && -n "$c" && -n "$d" && -n "$e" && -n "$f" && -n "$g" && -n "$h" && -n "$i" && $a -lt $b && $b -lt $c && $c -lt $d && $d -lt $e && $e -lt $f && $f -lt $g && $g -lt $h && $h -lt $i ]]')"
expect "the old images are tagged before the stack is touched" "$(yn '[[ -n "$(idx "tag sha256:oldimage iceslab-backend:pre-fork")" ]]')"
expect "the checkout is switched to the new fork" "$(yn '[[ "$(git -C "$PANEL" remote get-url origin)" == "$ORIGIN" && "$(cat "$PANEL/file.txt")" == new ]]')"
expect "the old state is kept for the way back" "$(yn 'grep -q "^OLD_ORIGIN=${OLD_ORIGIN}\$" "$PANEL/.migrate-from-fork.state" && grep -q "^OLD_SHA=" "$PANEL/.migrate-from-fork.state"')"
expect "TRUST_PROXY_HOPS is written out explicitly with the old value" "$(yn 'grep -qx "TRUST_PROXY_HOPS=1" "$PANEL/.env.production"')"
rc="$(run_script --run --yes)"
expect "a second --run on the moved installation is refused" "$(yn '[[ $rc == 1 ]] && grep -q "was moved already" "${LOG}.out"')"

note "--run: what stops it"
reset_panel
EXIT_CHECK=3; rc="$(run_script --run --yes)"; EXIT_CHECK=0
expect "a blocking finding stops --run (exit 1)" "$(yn '[[ $rc == 1 ]]')"
expect "... before the panel is stopped, backed up, flushed or swapped" "$(yn '[[ -z "$(idx "compose*stop*")" && -z "$(idx "BACKUP*")" && -z "$(idx "exec*FLUSHALL*")" && -z "$(idx "run*swap*")" && -z "$(idx "run*migrate*")" ]]')"
reset_panel
EXIT_MIGRATE=1; rc="$(run_script --run --yes)"; EXIT_MIGRATE=0
expect "a failed migration exits 1" "$(yn '[[ $rc == 1 ]]')"
expect "... brings the old backend and frontend back up, flushes nothing, swaps nothing, leaves no state" \
    "$(yn '[[ -n "$(idx "compose*up -d backend frontend")" && -z "$(idx "exec*FLUSHALL*")" && -z "$(idx "run*swap*")" && ! -e "$PANEL/.migrate-from-fork.state" ]]')"
reset_panel
EXTRA_ENV="TRUST_PROXY_HOPS=3"; write_env
rc="$(run_script --run --yes)"
EXTRA_ENV=""
expect "a TRUST_PROXY_HOPS the env file has is left alone" "$(yn '[[ "$(grep -c "^TRUST_PROXY_HOPS=" "$PANEL/.env.production")" == 1 ]] && grep -qx "TRUST_PROXY_HOPS=3" "$PANEL/.env.production"')"

note "--accept-loss"
reset_panel
REPORT='{"warnings":[{"code":"lossy-profiles-accepted"}]}'; STDIN_TEXT=""
rc="$(run_script --run --yes --accept-loss)"
expect "--yes does not stand in for the typed sentence: nothing is done without it" "$(yn '[[ $rc == 1 && -z "$(idx "compose*stop*")" ]]')"
STDIN_TEXT="I accept the loss"; rc="$(run_script --run --yes --accept-loss)"; STDIN_TEXT=""; REPORT='{}'
expect "with the sentence typed the move goes on, and the CLI got --accept-loss" "$(yn '[[ $rc == 0 && -n "$(idx "run*migrate --out*--accept-loss")" ]]')"

note "--rollback"
reset_panel
rc="$(run_script --rollback --yes)"
expect "--rollback without the state file of a move is refused" "$(yn '[[ $rc == 1 && -n "$(grep "was not moved by this script" "${LOG}.out")" ]]')"
reset_panel
rc="$(run_script --run --yes)"
rc="$(run_script --rollback --yes)"
expect "--rollback puts the database, the code and the images back" "$(yn '[[ $rc == 0 && -n "$(idx "run*unswap*")" && -n "$(idx "tag iceslab-backend:pre-fork iceslab-backend:latest")" && -n "$(idx "compose*up -d --no-build")" && "$(git -C "$PANEL" remote get-url origin)" == "$OLD_ORIGIN" && "$(cat "$PANEL/file.txt")" == old ]]')"
expect "... and the state is put aside, so the move can be run again" "$(yn '[[ ! -e "$PANEL/.migrate-from-fork.state" ]] && ls "$PANEL"/.migrate-from-fork.state.rolled-back-* >/dev/null 2>&1')"

note "a host that names things otherwise (the stand): names, project, hooks"
reset_panel
HOOK_OUT="${WORK}/hook.out"; rm -f "$HOOK_OUT"
cp "$PANEL/.env.production" "${WORK}/stand.env"; printf 'services: {}\n' > "${WORK}/override.yml"
export ICESLAB_PG_CONTAINER=omega-stand-postgres ICESLAB_REDIS_CONTAINER=omega-stand-redis ICESLAB_BACKEND_CONTAINER=omega-stand-backend ICESLAB_FRONTEND_CONTAINER=omega-stand-frontend
export ICESLAB_COMPOSE_PROJECT=omega-stand ICESLAB_COMPOSE_OVERRIDE="${WORK}/override.yml" ICESLAB_AFTER_SWAP="echo swapped > '$HOOK_OUT'"
rc="$(run_script --run --yes --env-file "${WORK}/stand.env")"
unset ICESLAB_PG_CONTAINER ICESLAB_REDIS_CONTAINER ICESLAB_BACKEND_CONTAINER ICESLAB_FRONTEND_CONTAINER ICESLAB_COMPOSE_PROJECT ICESLAB_COMPOSE_OVERRIDE ICESLAB_AFTER_SWAP
expect "--run works under other container names, another env file and a compose project with an override" "$(yn '[[ $rc == 0 ]] && grep -q "^compose -p omega-stand -f .*docker-compose.prod.yml -f ${WORK}/override.yml --env-file ${WORK}/stand.env stop backend frontend" "$LOG"')"
expect "ICESLAB_AFTER_SWAP replaces the switch of the checkout, the build and the start" "$(yn '[[ -f "$HOOK_OUT" && -z "$(idx "compose*build*")" && "$(cat "$PANEL/file.txt")" == old ]]')"
rm -f "$PANEL"/.migrate-from-fork.state

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
