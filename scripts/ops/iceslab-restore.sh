#!/usr/bin/env bash
# iceslab-restore.sh
#
# Restore a tarball produced by iceslab-backup.sh:
#   1. Decrypt (if `--password` given) and unpack the archive.
#   2. Read manifest.json, print a summary, ask the user to confirm.
#   3. Stop the panel services so nothing writes during restore.
#   4. Drop + recreate the postgres database, then `psql` the dump.
#   5. Stop redis, replace dump.rdb on its volume, restart redis.
#   6. Replace the host .env.production (only if the archive's was preserved).
#   7. Start the panel back up.
#
# DESTRUCTIVE: overwrites the database and redis state. Take a fresh
# `iceslab-backup.sh` of the current host first.
#
# Usage:
#   ./scripts/iceslab-restore.sh ./backups/iceslab-backup-...tar.gz \
#       [--password <pw>] [--yes]

set -euo pipefail

LIB_PREFIX="restore"
# shellcheck source=_lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
trap 'on_err $LINENO' ERR

# ───── Defaults ─────
COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env.production"
PASSWORD=""
ASSUME_YES=0
ARCHIVE=""

POSTGRES_CONTAINER="iceslab-prod-postgres"
REDIS_CONTAINER="iceslab-prod-redis"

# ───── Args ─────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --password)
            PASSWORD="$2"
            shift 2
            ;;
        --compose-file)
            COMPOSE_FILE="$2"
            shift 2
            ;;
        --env-file)
            ENV_FILE="$2"
            shift 2
            ;;
        --yes|-y)
            ASSUME_YES=1
            shift
            ;;
        -h|--help)
            sed -n '2,18p' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *)
            if [[ -z "$ARCHIVE" ]]; then
                ARCHIVE="$1"
                shift
            else
                log_err "unknown arg: $1"
                exit 2
            fi
            ;;
    esac
done

if [[ -z "$ARCHIVE" || ! -f "$ARCHIVE" ]]; then
    log_err "usage: $0 <archive.tar.gz[.enc]> [--password <pw>] [--yes]"
    exit 1
fi
require_compose_root

DC=(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")

# ───── Stage ─────
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
# Re-install ERR trap: the EXIT trap above replaced the one set by _lib.
trap 'on_err $LINENO' ERR

STEP_TOTAL=5

# ───── Step 1: unpack ─────
step 1 "unpack archive"
if [[ "$ARCHIVE" == *.enc ]]; then
    if [[ -z "$PASSWORD" ]]; then
        log_err "archive is encrypted but --password was not given"
        exit 1
    fi
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
                 -pass "pass:${PASSWORD}" \
                 -in "$ARCHIVE" \
        | tar -C "$STAGE" -xzf -
else
    tar -C "$STAGE" -xzf "$ARCHIVE"
fi

if [[ ! -f "${STAGE}/manifest.json" ]]; then
    log_err "archive missing manifest.json, not produced by iceslab-backup.sh?"
    exit 1
fi
step_done

log_info "manifest:"
cat "${STAGE}/manifest.json"
echo

if [[ $ASSUME_YES -ne 1 ]]; then
    printf '%b[%s]%b %bthis WILL drop and recreate the live database.%b continue? (yes/no) ' \
        "$C_INFO" "$LIB_PREFIX" "$C_RST" "$C_WARN" "$C_RST"
    read -r ans
    if [[ "$ans" != "yes" ]]; then
        log_warn "aborted by operator"
        exit 1
    fi
fi

# Pull POSTGRES_USER / POSTGRES_DB from the host env file (the live target,
# not the archive's copy, see the `env` step below).
# shellcheck disable=SC1090
source <(grep -E '^(POSTGRES_USER|POSTGRES_DB)=' "$ENV_FILE")
: "${POSTGRES_USER:?missing POSTGRES_USER in $ENV_FILE}"
: "${POSTGRES_DB:?missing POSTGRES_DB in $ENV_FILE}"

# ───── Step 2: stop panel services ─────
# Service names are `backend` and `frontend`, not the container_names
# iceslab-prod-backend / iceslab-prod-frontend. We once stopped the wrong
# names, it failed silently via `|| true`, and the DB restore ran while the
# backend kept writing. Use the real compose service names.
step 2 "stop panel services (backend, frontend)"
"${DC[@]}" stop backend frontend 2>/dev/null || true
step_done

# ───── Step 3: postgres restore ─────
step 3 "restore postgres dump"
# DROP SCHEMA + CREATE before loading. pg_dump --clean --if-exists already
# drops each table, but a full schema reset also clears orphan objects left
# from a previous database.
docker exec -i "$POSTGRES_CONTAINER" \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
    -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null

docker exec -i "$POSTGRES_CONTAINER" \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
    < "${STAGE}/postgres.sql" >/dev/null
step_done

# ───── Step 4: redis restore ─────
step 4 "restore redis snapshot"
"${DC[@]}" stop redis
# Copy into the stopped container. `docker cp` to a running redis with AOF
# active produces a corrupt rdb on next start.
docker cp "${STAGE}/redis.rdb" "${REDIS_CONTAINER}:/data/dump.rdb"
# Loading a copied dump.rdb into an AOF-enabled Redis takes three things, and
# the previous version of this step did none of them. Found 2026-08-26 by
# backup-restore-selftest.sh, which restored a known dataset and read the
# result back out of Redis.
#
#  1. `docker exec` cannot be used here at all: redis was stopped one line
#     above, and exec against a stopped container fails with "container is not
#     running". The old `docker exec ... 2>/dev/null || true` therefore never
#     ran. A throwaway container on the same volume works with the service down.
#
#  2. The WHOLE appendonlydir has to go, not just its *.aof files. Redis 7 keeps
#     a base snapshot (appendonly.aof.N.base.rdb) and a manifest in there, and
#     while the manifest is present Redis loads from it and never reads
#     /data/dump.rdb - it came back with the PRE-restore dataset and said so:
#     "DB loaded from base file appendonly.aof.1.base.rdb".
#
#  3. Even with the AOF gone, a Redis started with `--appendonly yes` does NOT
#     fall back to the rdb: it starts EMPTY and writes a fresh AOF over it. The
#     documented conversion is to load the rdb with appendonly OFF and then turn
#     it on, which rewrites the AOF from the loaded dataset. That is what the
#     throwaway instance below does; the real service then starts against an AOF
#     that already holds the restored data.
#
# `docker cp` also lands the file as the HOST uid with mode 600, and the
# throwaway container would otherwise leave an AOF directory owned by root that
# the redis user cannot write to - hence the `chown -R` at the end. (A chown of
# the copied rdb BEFORE the conversion is not needed and was removed after
# measuring: the throwaway instance runs as root and reads it regardless.)
#
# Not silenced: a failure here would leave the restore looking successful and
# the dataset empty, which is exactly how this went unnoticed.
"${DC[@]}" run --rm --no-deps --entrypoint sh redis -c '
    set -e
    rm -rf /data/appendonlydir
    redis-server --appendonly no --daemonize yes --dir /data --dbfilename dump.rdb
    for _ in $(seq 1 30); do redis-cli PING 2>/dev/null | grep -q PONG && break; sleep 1; done
    redis-cli PING | grep -q PONG
    redis-cli CONFIG SET appendonly yes >/dev/null
    for _ in $(seq 1 60); do
        redis-cli INFO persistence | grep -q "aof_rewrite_in_progress:0" && break
        sleep 1
    done
    redis-cli SHUTDOWN NOSAVE 2>/dev/null || true
    sleep 1
    chown -R redis:redis /data
' >/dev/null
"${DC[@]}" start redis
step_done

# ───── Step 5: bring panel back up ─────
step 5 "start panel services (backend, frontend)"
"${DC[@]}" start backend frontend
step_done

echo
log_ok "restore complete in $(elapsed_total)"
log_warn ".env.production was NOT overwritten, review ${STAGE}/env"
log_warn "  and merge any drifted values manually"
