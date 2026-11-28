#!/usr/bin/env bash
# migrate-from-fork.sh: move an installation of the OLD fork (040410ac) onto this
# fork, keeping its data. ONE-OFF: kept in the repository for as long as such
# installations exist, then deleted (milestone 20.3; docs/migrate-from-fork.md).
#
# Run it from a checkout of THIS fork, not from the installation:
#
#   git clone --branch omega https://github.com/alldevic/iceslab.git /opt/iceslab-new
#   cd /opt/iceslab-new
#   scripts/ops/migrate-from-fork.sh --check                   # reads, writes a report, changes nothing
#   scripts/ops/migrate-from-fork.sh --run                     # the move (stops the panel for its length)
#   scripts/ops/migrate-from-fork.sh --run --accept-loss       # ... also with profiles that use post-quantum fields
#   scripts/ops/migrate-from-fork.sh --rollback                # the old database, the old code, the old images
#
# Flags:
#   --panel-dir DIR   the old installation (default /opt/iceslab; env ICESLAB_PANEL_DIR)
#   --repo URL        what the installation's origin becomes (default https://github.com/alldevic/iceslab.git)
#   --ref REF         branch or tag of this fork to deploy (default omega; env ICESLAB_REF)
#   --accept-loss     carry on although profiles use post-quantum REALITY / VLESS Encryption fields or
#                     abusePolicy: the fields are dropped and clients that hold links built on them stop
#                     connecting. Asks you to type a sentence; --yes does not skip that
#   --yes             do not ask before the move
#   --out DIR         where the reports go (default <panel-dir>/backups/fork-migration)
#   --env-file F, --compose-file F   when they are not <panel-dir>/.env.production and docker-compose.prod.yml
#
# For a host that names things differently (the local stand): ICESLAB_PG_CONTAINER, ICESLAB_REDIS_CONTAINER,
# ICESLAB_BACKEND_CONTAINER, ICESLAB_FRONTEND_CONTAINER, ICESLAB_COMPOSE_PROJECT (compose -p),
# ICESLAB_COMPOSE_OVERRIDE (a second -f), and the hooks ICESLAB_AFTER_SWAP / ICESLAB_AFTER_UNSWAP, a command
# that REPLACES the switch of the checkout, the build and the start (step 9) / the return of the old code and
# images and the start (--rollback).
#
# What --run does, in order (all but 9 on a COPY of the database; the old one is kept as <db>_pre_fork):
#   1 checks   2 image of this fork   3 pre-check (stops here on a blocking finding, nothing changed)
#   4 backup   5 stop backend+frontend   6 copy, journal, prisma migrate deploy, transforms, verification
#   7 TRUST_PROXY_HOPS written out, a backup of the copy   8 Redis flushed
#   9 swap of the databases, origin and ref switched, images built, stack up, /health waited for
#   10 report and the rollback command
# Needs: docker with compose, git, the old installation's compose file and .env.production.
set -euo pipefail

LIB_PREFIX="migrate-from-fork"
# shellcheck source=_lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
trap 'on_err $LINENO' ERR

NEW_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OPS_DIR="$NEW_ROOT/scripts/ops"
BACKUP_SCRIPT="${ICESLAB_BACKUP_SCRIPT:-$OPS_DIR/iceslab-backup.sh}"   # the selftest puts a stub here

# The commit the script takes: the old fork's, by the customer's decision. The
# pre-check refuses anything else by what the DATABASE says (journal and schema).
OLD_COMMIT="040410ac"
CLI_JS="dist-fork-migration/scripts/fork-migration/cli.js"
LOSS_SENTENCE="I accept the loss"

MODE=""
PANEL_DIR="${ICESLAB_PANEL_DIR:-/opt/iceslab}"
NEW_REPO="${ICESLAB_NEW_REPO:-https://github.com/alldevic/iceslab.git}"
NEW_REF="${ICESLAB_REF:-omega}"
ACCEPT_LOSS=0
ASSUME_YES=0
OUT_DIR=""
ENV_FILE_ARG=""
COMPOSE_FILE_ARG=""
MIGRATE_IMAGE="${ICESLAB_MIGRATE_IMAGE:-}"   # a ready image of this fork (the stand, the selftest); built otherwise

while [[ $# -gt 0 ]]; do
    case "$1" in
        --check)       MODE=check; shift ;;
        --run)         MODE=run; shift ;;
        --rollback)    MODE=rollback; shift ;;
        --panel-dir)   PANEL_DIR="${2:?--panel-dir needs a value}"; shift 2 ;;
        --repo)        NEW_REPO="${2:?--repo needs a value}"; shift 2 ;;
        --ref)         NEW_REF="${2:?--ref needs a value}"; shift 2 ;;
        --out)         OUT_DIR="${2:?--out needs a value}"; shift 2 ;;
        --env-file)    ENV_FILE_ARG="${2:?--env-file needs a value}"; shift 2 ;;
        --compose-file) COMPOSE_FILE_ARG="${2:?--compose-file needs a value}"; shift 2 ;;
        --accept-loss) ACCEPT_LOSS=1; shift ;;
        --yes|-y)      ASSUME_YES=1; shift ;;
        -h|--help)     sed -n '2,40p' "$0" | sed 's/^# \?//'; exit 0 ;;
        *)             log_err "unknown arg: $1"; exit 2 ;;
    esac
done
if [[ -z "$MODE" ]]; then
    log_err "say what to do: --check, --run or --rollback (-h for the help)"
    exit 2
fi

COMPOSE_FILE="${COMPOSE_FILE_ARG:-$PANEL_DIR/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE_ARG:-$PANEL_DIR/.env.production}"
PG_CONTAINER="${ICESLAB_PG_CONTAINER:-iceslab-prod-postgres}"
REDIS_CONTAINER="${ICESLAB_REDIS_CONTAINER:-iceslab-prod-redis}"
BACKEND_CONTAINER="${ICESLAB_BACKEND_CONTAINER:-iceslab-prod-backend}"
FRONTEND_CONTAINER="${ICESLAB_FRONTEND_CONTAINER:-iceslab-prod-frontend}"
export ICESLAB_POSTGRES_CONTAINER="$PG_CONTAINER" ICESLAB_REDIS_CONTAINER="$REDIS_CONTAINER"   # what iceslab-backup.sh reads
STATE_FILE="$PANEL_DIR/.migrate-from-fork.state"
[[ -n "$OUT_DIR" ]] || OUT_DIR="$PANEL_DIR/backups/fork-migration"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

# ───── helpers ─────
env_value() { # env_value KEY: the value in .env.production, empty if absent
    local line
    line="$(grep -E "^$1=" "$ENV_FILE" | tail -n 1 || true)"
    line="${line#*=}"
    line="${line%\"}"; line="${line#\"}"
    printf '%s' "$line"
}

DC() {
    local extra=()
    [[ -n "${ICESLAB_COMPOSE_PROJECT:-}" ]] && extra+=(-p "$ICESLAB_COMPOSE_PROJECT")
    extra+=(-f "$COMPOSE_FILE")
    [[ -n "${ICESLAB_COMPOSE_OVERRIDE:-}" ]] && extra+=(-f "$ICESLAB_COMPOSE_OVERRIDE")
    docker compose "${extra[@]}" --env-file "$ENV_FILE" "$@"
}

confirm() { # confirm "question": yes by --yes or by typing y
    [[ $ASSUME_YES -eq 1 ]] && return 0
    local a
    read -rp "$(printf '%b[%s]%b %s [y/N] ' "$C_WARN" "$LIB_PREFIX" "$C_RST" "$1")" a || return 1
    [[ "$a" == y || "$a" == Y || "$a" == yes ]]
}

preflight() {
    command -v docker >/dev/null || { log_err "docker is not installed"; exit 1; }
    command -v git >/dev/null || { log_err "git is not installed"; exit 1; }
    if [[ ! -f "$COMPOSE_FILE" || ! -f "$ENV_FILE" ]]; then
        log_err "no installation at $PANEL_DIR ($COMPOSE_FILE and $ENV_FILE are needed); use --panel-dir"
        exit 1
    fi
    if [[ "$(cd "$PANEL_DIR" && pwd)" == "$NEW_ROOT" ]]; then
        log_err "run this from a checkout of the NEW fork, apart from the installation ($PANEL_DIR is the installation itself)"
        exit 1
    fi
    local running
    running="$(docker ps --format '{{.Names}}')" || { log_err "docker ps failed"; exit 1; }
    for c in "$PG_CONTAINER" "$REDIS_CONTAINER"; do
        grep -q "^${c}$" <<<"$running" || { log_err "container $c is not running: start the old installation first (cd $PANEL_DIR && docker compose -f docker-compose.prod.yml up -d)"; exit 1; }
    done
    NET="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$PG_CONTAINER" | awk '{print $1}')"
    [[ -n "$NET" ]] || { log_err "cannot tell the network of $PG_CONTAINER"; exit 1; }
    DATABASE_URL="$(env_value DATABASE_URL)"
    JWT_SECRET_VALUE="$(env_value JWT_SECRET)"
    REDIS_URL_VALUE="$(env_value REDIS_URL)"
    [[ -n "$DATABASE_URL" ]] || { log_err "DATABASE_URL is not in $ENV_FILE"; exit 1; }
    [[ -n "$JWT_SECRET_VALUE" ]] || { log_err "JWT_SECRET is not in $ENV_FILE (it must be: subscriptions depend on it)"; exit 1; }
    # The proxy-hop count the old panel runs with: the container's own value, or the old default (1).
    HOPS="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$BACKEND_CONTAINER" 2>/dev/null | sed -n 's/^TRUST_PROXY_HOPS=//p' | head -n 1 || true)"
    [[ -n "$HOPS" ]] || HOPS="$(env_value TRUST_PROXY_HOPS)"
    [[ -n "$HOPS" ]] || HOPS=1
    PATH_PREFIX="$(env_value SUBSCRIPTION_PATH_PREFIX)"
    mkdir -p "$OUT_DIR"
}

# The pre-check/migrate/swap commands of the compiled script, in the image of this fork, on the old compose network.
cli() {
    docker run --rm --network "$NET" --user root --entrypoint node \
        -e DATABASE_URL="$DATABASE_URL" -e JWT_SECRET="$JWT_SECRET_VALUE" -e TRUST_PROXY_HOPS="$HOPS" \
        -e SUBSCRIPTION_PATH_PREFIX="$PATH_PREFIX" -e REDIS_URL="$REDIS_URL_VALUE" \
        -v "$OUT_DIR:/out" "$MIGRATE_IMAGE" --enable-experimental-regexp-engine "$CLI_JS" "$@"
}

build_image() {
    if [[ -n "$MIGRATE_IMAGE" ]]; then
        log_info "using the image $MIGRATE_IMAGE"
        return 0
    fi
    MIGRATE_IMAGE="iceslab-backend:fork-migration"
    retry 3 docker build -f "$NEW_ROOT/apps/panel-backend/Dockerfile" -t "$MIGRATE_IMAGE" "$NEW_ROOT"
}

wait_backend() {
    wait_container_healthy "$(DC ps -q backend 2>/dev/null || true)"
}

# ───── --check ─────
do_check() {
    STEP_TOTAL=3
    step 1 "the installation at $PANEL_DIR"
    preflight
    local sha
    sha="$(git -C "$PANEL_DIR" rev-parse --short=8 HEAD 2>/dev/null || echo unknown)"
    log_info "  old panel checkout: ${sha}; effective TRUST_PROXY_HOPS=${HOPS}"
    if [[ "$sha" != "$OLD_COMMIT"* ]]; then
        log_warn "  the checkout is at ${sha}, not ${OLD_COMMIT}: the pre-check below decides by what the database holds"
    fi
    step_done

    step 2 "image of this fork ($(git -C "$NEW_ROOT" rev-parse --short HEAD 2>/dev/null || echo no-git))"
    build_image
    step_done

    step 3 "pre-check (reads only)"
    local rc=0 loss_flag=()
    [[ $ACCEPT_LOSS -eq 1 ]] && loss_flag=(--accept-loss)
    cli check --out "/out/pre-check-${TS}.json" ${loss_flag[@]+"${loss_flag[@]}"} || rc=$?
    log_info "report: $OUT_DIR/pre-check-${TS}.json"
    if [[ $rc -eq 3 ]]; then
        log_err "the pre-check found something that stops the move (BLOCKING above); nothing was changed"
        exit 1
    elif [[ $rc -ne 0 ]]; then
        log_err "the pre-check failed (exit $rc)"
        exit 1
    fi
    step_done
    log_ok "nothing blocks the move. Next: $0 --run"
}

# ───── --run ─────
disk_check() {
    local size free
    size="$(docker exec "$PG_CONTAINER" psql -U "$(env_value POSTGRES_USER)" -d "$(env_value POSTGRES_DB)" -Atc 'select pg_database_size(current_database())')"
    free="$(docker exec "$PG_CONTAINER" df -Pk /var/lib/postgresql/data | awk 'NR==2 {print $4 * 1024}')"
    log_info "  database ${size} bytes, free on its volume ${free} bytes"
    if (( free < 2 * size )); then
        log_err "the copy needs about twice the database size free on the Postgres volume (and the backup room beside it)"
        exit 1
    fi
}

backup_with_db() { # backup_with_db DB LABEL: iceslab-backup.sh against another database name
    local db="$1" env_tmp
    env_tmp="$(mktemp)"
    sed "s/^POSTGRES_DB=.*/POSTGRES_DB=${db}/" "$ENV_FILE" >"$env_tmp"
    (cd "$PANEL_DIR" && bash "$BACKUP_SCRIPT" --compose-file "$COMPOSE_FILE" --env-file "$env_tmp" --out "$OUT_DIR/backup-$2")
    rm -f "$env_tmp"
}

do_run() {
    STEP_TOTAL=10
    if [[ -f "$STATE_FILE" ]]; then
        log_err "$STATE_FILE exists: this installation was moved already (use --rollback to undo it)"
        exit 1
    fi
    local loss_flag=()
    [[ $ACCEPT_LOSS -eq 1 ]] && loss_flag=(--accept-loss)

    step 1 "checks"
    preflight
    disk_check
    OLD_SHA="$(git -C "$PANEL_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
    OLD_BRANCH="$(git -C "$PANEL_DIR" symbolic-ref --short -q HEAD || true)"
    OLD_ORIGIN="$(git -C "$PANEL_DIR" remote get-url origin 2>/dev/null || echo unknown)"
    log_info "  old checkout ${OLD_SHA:0:8} (${OLD_BRANCH:-detached}), origin ${OLD_ORIGIN}; effective TRUST_PROXY_HOPS=${HOPS}"
    step_done

    step 2 "image of this fork"
    build_image
    step_done

    step 3 "pre-check"
    local rc=0
    cli check --out "/out/pre-check-${TS}.json" ${loss_flag[@]+"${loss_flag[@]}"} || rc=$?
    if [[ $rc -ne 0 ]]; then
        log_err "the pre-check stops the move (exit $rc, report $OUT_DIR/pre-check-${TS}.json); nothing was changed"
        exit 1
    fi
    if grep -q '"lossy-profiles-accepted"' "$OUT_DIR/pre-check-${TS}.json"; then
        log_warn "profiles use post-quantum REALITY / VLESS Encryption fields or abusePolicy. Going on drops them, and every client holding a link built on them stops connecting until you re-issue it."
        local typed=""
        read -rp "Type exactly \"${LOSS_SENTENCE}\" to go on: " typed || true
        [[ "$typed" == "$LOSS_SENTENCE" ]] || { log_err "not confirmed; nothing was changed"; exit 1; }
    fi
    step_done
    confirm "The panel will be stopped for the length of the move (copy, ~54 migrations, transforms). Go on?" || { log_err "stopped; nothing was changed"; exit 1; }

    step 4 "backup of the old database"
    backup_with_db "$(env_value POSTGRES_DB)" "before"
    step_done

    step 5 "stop backend and frontend"
    OLD_BACKEND_IMAGE="$(docker inspect -f '{{.Image}}' "$BACKEND_CONTAINER" 2>/dev/null || true)"
    OLD_FRONTEND_IMAGE="$(docker inspect -f '{{.Image}}' "$FRONTEND_CONTAINER" 2>/dev/null || true)"
    [[ -n "$OLD_BACKEND_IMAGE" ]] && docker tag "$OLD_BACKEND_IMAGE" iceslab-backend:pre-fork
    [[ -n "$OLD_FRONTEND_IMAGE" ]] && docker tag "$OLD_FRONTEND_IMAGE" iceslab-frontend:pre-fork
    DC stop backend frontend
    step_done

    step 6 "copy, journal, migrate deploy, transforms, verification"
    rc=0
    cli migrate --out "/out/migrate-from-fork-${TS}.json" ${loss_flag[@]+"${loss_flag[@]}"} || rc=$?
    if [[ $rc -ne 0 ]]; then
        log_err "the move failed on the copy (exit $rc, report $OUT_DIR/migrate-from-fork-${TS}.json). The old database is untouched; bringing the old panel back up."
        DC up -d backend frontend || true
        exit 1
    fi
    step_done

    step 7 "environment and backup of the migrated copy"
    if ! grep -qE '^TRUST_PROXY_HOPS=' "$ENV_FILE"; then
        cp -p "$ENV_FILE" "${ENV_FILE}.bak.${TS}"
        printf '\n# written by migrate-from-fork.sh: the value the old panel ran with (the new default is 2)\nTRUST_PROXY_HOPS=%s\n' "$HOPS" >>"$ENV_FILE"
        log_info "  TRUST_PROXY_HOPS=${HOPS} written to $(basename "$ENV_FILE")"
    fi
    backup_with_db "$(env_value POSTGRES_DB)_migrating" "migrated"
    step_done

    step 8 "flush Redis"
    docker exec "$REDIS_CONTAINER" redis-cli FLUSHALL >/dev/null
    step_done

    step 9 "swap, switch the checkout to this fork, build, start"
    cli swap
    {
        printf 'OLD_SHA=%s\nOLD_BRANCH=%s\nOLD_ORIGIN=%s\nOLD_BACKEND_IMAGE=%s\nOLD_FRONTEND_IMAGE=%s\nMOVED_AT=%s\nREPORT=%s\n' \
            "$OLD_SHA" "$OLD_BRANCH" "$OLD_ORIGIN" "$OLD_BACKEND_IMAGE" "$OLD_FRONTEND_IMAGE" "$TS" "$OUT_DIR/migrate-from-fork-${TS}.json"
    } >"$STATE_FILE"
    if [[ -n "${ICESLAB_AFTER_SWAP:-}" ]]; then
        log_info "  ICESLAB_AFTER_SWAP: $ICESLAB_AFTER_SWAP"
        bash -c "$ICESLAB_AFTER_SWAP"
    else
        (
            cd "$PANEL_DIR"
            git remote set-url origin "$NEW_REPO"
            ICESLAB_REF="$NEW_REF" FORCE_RESET=1 git_sync_to_ref
            log_info "  checkout now ${SYNC_TARGET} ${SHA_AFTER}"
            retry 3 docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build backend frontend
            docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d
        )
    fi
    if ! wait_backend; then
        log_err "the backend did not come up on the migrated database."
        log_err "  the way back: $0 --rollback --panel-dir $PANEL_DIR"
        exit 1
    fi
    step_done

    step 10 "done"
    log_ok "moved in $(elapsed_total). Report: $OUT_DIR/migrate-from-fork-${TS}.json"
    log_info "  not converted egress policies (if any): $OUT_DIR/egress-policies-not-converted.json"
    log_info "  the old database is kept as <db>_pre_fork; images iceslab-backend:pre-fork and iceslab-frontend:pre-fork too"
    log_info "  next: reinstall the agent of every node with the command from the panel (Refresh bootstrap), see docs/migrate-from-fork.md"
    log_info "  undo: $0 --rollback --panel-dir $PANEL_DIR"
}

# ───── --rollback ─────
do_rollback() {
    STEP_TOTAL=4
    step 1 "checks"
    preflight
    [[ -f "$STATE_FILE" ]] || { log_err "$STATE_FILE does not exist: this installation was not moved by this script"; exit 1; }
    # shellcheck disable=SC1090
    source "$STATE_FILE"
    log_info "  moved at ${MOVED_AT}; back to ${OLD_SHA:0:8} (${OLD_BRANCH:-detached}) of ${OLD_ORIGIN}"
    confirm "Roll back: the database goes back to the one before the move (changes made since are lost). Go on?" || { log_err "stopped"; exit 1; }
    step_done

    step 2 "stop the panel, put the old database back"
    DC stop backend frontend || true
    MIGRATE_IMAGE="${MIGRATE_IMAGE:-$(docker image ls -q iceslab-backend:fork-migration | head -n 1)}"
    [[ -n "$MIGRATE_IMAGE" ]] || build_image
    cli unswap
    step_done

    step 3 "old code and old images, start the old panel"
    if [[ -n "${ICESLAB_AFTER_UNSWAP:-}" ]]; then
        log_info "  ICESLAB_AFTER_UNSWAP: $ICESLAB_AFTER_UNSWAP"
        bash -c "$ICESLAB_AFTER_UNSWAP"
    else
        (
            cd "$PANEL_DIR"
            [[ "$OLD_ORIGIN" == unknown ]] || git remote set-url origin "$OLD_ORIGIN"
            git checkout --force "${OLD_BRANCH:-$OLD_SHA}" 2>&1 | tail -n 2
            if [[ -n "$OLD_BRANCH" ]]; then git reset --hard "$OLD_SHA" >/dev/null; fi
        )
        docker image inspect iceslab-backend:pre-fork >/dev/null && docker tag iceslab-backend:pre-fork iceslab-backend:latest
        docker image inspect iceslab-frontend:pre-fork >/dev/null && docker tag iceslab-frontend:pre-fork iceslab-frontend:latest
        DC up -d --no-build
    fi
    step_done

    step 4 "wait for the old panel"
    wait_backend || { log_err "the old backend did not come up"; exit 1; }
    mv "$STATE_FILE" "${STATE_FILE}.rolled-back-${TS}"
    step_done
    log_ok "rolled back. The migrated database is kept under <db>_migrated_<time>; the move can be run again."
}

case "$MODE" in
    check)    do_check ;;
    run)      do_run ;;
    rollback) do_rollback ;;
esac
