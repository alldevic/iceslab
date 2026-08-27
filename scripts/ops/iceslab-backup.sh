#!/usr/bin/env bash
# iceslab-backup.sh
#
# Single-file backup of the Iceslab control plane:
#   - Postgres dump  (pg_dump inside iceslab-prod-postgres, SQL)
#   - Redis dump     (BGSAVE then copy dump.rdb out of iceslab-prod-redis)
#   - .env.production (host-side, contains JWT_SECRET, POSTGRES_PASSWORD, etc)
#
# All three go into one timestamped tar.gz under the chosen path (default
# `./backups/`). With `--password <pw>` the tarball is AES-256 encrypted via
# `openssl enc`. The CA private key, JWT secret, user creds and node mTLS
# material all sit inside, so encrypt at rest for off-host storage.
#
# Usage:
#   ./scripts/iceslab-backup.sh [--out /path/to/dir] [--password <pw>]
#
# Restore with the matching iceslab-restore.sh script.

set -euo pipefail

LIB_PREFIX="backup"
# shellcheck source=_lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
trap 'on_err $LINENO' ERR

# ───── Defaults ─────
COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env.production"
OUT_DIR="./backups"
PASSWORD=""

POSTGRES_CONTAINER="iceslab-prod-postgres"
REDIS_CONTAINER="iceslab-prod-redis"

# ───── Args ─────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --out)
            OUT_DIR="$2"
            shift 2
            ;;
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
        -h|--help)
            sed -n '2,18p' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *)
            log_err "unknown arg: $1"
            exit 2
            ;;
    esac
done

# ───── Pre-flight ─────
require_compose_root

mkdir -p "$OUT_DIR"

# Pull POSTGRES_USER / POSTGRES_DB from the env file instead of hard-coding.
# shellcheck disable=SC1090
source <(grep -E '^(POSTGRES_USER|POSTGRES_DB)=' "$ENV_FILE")
: "${POSTGRES_USER:?missing POSTGRES_USER in $ENV_FILE}"
: "${POSTGRES_DB:?missing POSTGRES_DB in $ENV_FILE}"

# Both containers must be up. pg_dump against a stopped DB is the usual
# failure when this runs from cron the night after a deploy that stalled.
if ! docker ps --format '{{.Names}}' | grep -q "^${POSTGRES_CONTAINER}$"; then
    log_err "container ${POSTGRES_CONTAINER} is not running"
    exit 1
fi
if ! docker ps --format '{{.Names}}' | grep -q "^${REDIS_CONTAINER}$"; then
    log_err "container ${REDIS_CONTAINER} is not running"
    exit 1
fi

# ───── Stage everything in a temp dir ─────
TS="$(date -u +%Y%m%dT%H%M%SZ)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
# Re-install the ERR trap: the EXIT trap above replaced the one from _lib.
trap 'on_err $LINENO' ERR

STEP_TOTAL=4

# ───── Step 1: postgres dump ─────
step 1 "postgres pg_dump → ${STAGE}/postgres.sql"
docker exec -e PGPASSWORD -i "$POSTGRES_CONTAINER" \
    pg_dump --clean --if-exists --no-owner --no-privileges \
            -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    > "${STAGE}/postgres.sql"
log_info "  $(du -h "${STAGE}/postgres.sql" | cut -f1)"
step_done

# ───── Step 2: redis BGSAVE + copy ─────
step 2 "redis BGSAVE → ${STAGE}/redis.rdb"
# BGSAVE is async; wait for LASTSAVE to advance. This loop used to give up after
# 30s and copy whatever rdb was on disk, shipping a stale snapshot. Now it fails
# loudly instead.
#
# The baseline has to be read BEFORE the save is asked for. Reading it after
# meant that on a small dataset - where BGSAVE finishes between the two
# commands - the "previous" value already included the save, nothing could ever
# advance, and the backup aborted with "backup would be stale" every time. A
# guard against a stale snapshot that instead prevents any snapshot at all.
# Found 2026-08-26 by backup-restore-selftest.sh.
prev_lastsave="$(docker exec "$REDIS_CONTAINER" redis-cli LASTSAVE)"
docker exec "$REDIS_CONTAINER" redis-cli BGSAVE >/dev/null
bgsave_ok=0
for _ in $(seq 1 30); do
    sleep 1
    cur="$(docker exec "$REDIS_CONTAINER" redis-cli LASTSAVE)"
    if [[ "$cur" != "$prev_lastsave" ]]; then
        bgsave_ok=1
        break
    fi
done
if [[ $bgsave_ok -ne 1 ]]; then
    log_err "BGSAVE did not advance LASTSAVE within 30s, backup would be stale"
    log_err "  check redis health: docker logs ${REDIS_CONTAINER} --tail=50"
    exit 1
fi
docker cp "${REDIS_CONTAINER}:/data/dump.rdb" "${STAGE}/redis.rdb"
log_info "  $(du -h "${STAGE}/redis.rdb" | cut -f1)"
step_done

# ───── Step 3: env + manifest ─────
step 3 "env file + manifest"
cp "$ENV_FILE" "${STAGE}/env"

# Manifest lets restore sanity-check what it's about to overwrite.
cat > "${STAGE}/manifest.json" <<EOF
{
  "createdAt": "${TS}",
  "compose": "${COMPOSE_FILE}",
  "envFile": "${ENV_FILE}",
  "postgresUser": "${POSTGRES_USER}",
  "postgresDb": "${POSTGRES_DB}",
  "components": ["postgres.sql", "redis.rdb", "env"]
}
EOF
step_done

# ───── Step 4: tar + optional encryption ─────
ARCHIVE="${OUT_DIR}/iceslab-backup-${TS}.tar.gz"

# The archive is written under a `.part` name and renamed only after the last
# byte is in. A backup that failed halfway — the disk filled, the pipe broke,
# the operator hit ^C — otherwise leaves a truncated file under the FINAL name,
# and there is nothing about that name to say it is not a backup. `set -e` and
# the ERR trap end the run loudly, but the file outlives the message; the next
# person to look in this directory sees a plausible archive with a plausible
# timestamp. Same shape as a fetch that fails and leaves the download.
#
# The property is about the FINAL name only: `iceslab-backup-<ts>.tar.gz` and
# its `.enc` never exist incomplete. The `.part` beside them does, for as long
# as the run takes, and it is removed on exit — so a rotation glob wants
# `iceslab-backup-*.tar.gz` and `*.tar.gz.enc`, not `*.tar.gz*`, which would
# match the part file of a backup still being written.
#
# The trap has to carry the staging cleanup with it. `trap ... EXIT` REPLACES
# the handler installed above, and that one is what removes $STAGE — the
# directory holding postgres.sql, redis.rdb and a copy of .env.production in the
# clear. Installing a second EXIT trap for the part file alone would have left
# all three on disk after every backup.
BACKUP_PART=""
trap 'rm -f "${BACKUP_PART:-}"; rm -rf "$STAGE"' EXIT

if [[ -n "$PASSWORD" ]]; then
    step 4 "tar + AES-256-CBC encrypt → ${ARCHIVE}.enc"
    ENCRYPTED="${ARCHIVE}.enc"
    BACKUP_PART="${ENCRYPTED}.part"
    # 0600 before openssl writes a byte, not after it wrote them all: the file
    # is the whole database. `-out` opens O_CREAT|O_TRUNC and keeps the mode of
    # a file already there, and `mv` carries the mode to the final name.
    install -m 0600 /dev/null "$BACKUP_PART"
    tar -C "$STAGE" -czf - postgres.sql redis.rdb env manifest.json \
        | openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 \
                       -pass "pass:${PASSWORD}" \
                       -out "$BACKUP_PART"
    chmod 600 "$BACKUP_PART"
    mv "$BACKUP_PART" "$ENCRYPTED"
    BACKUP_PART=""
    SIZE="$(du -h "$ENCRYPTED" | cut -f1)"
    step_done
    echo
    log_ok "backup complete in $(elapsed_total): ${ENCRYPTED} (${SIZE}, AES-256-CBC)"
else
    step 4 "tar → ${ARCHIVE}"
    # Same, and it matters more here: unencrypted, this archive holds
    # .env.production and every subscription token in the database.
    BACKUP_PART="${ARCHIVE}.part"
    install -m 0600 /dev/null "$BACKUP_PART"
    tar -C "$STAGE" -czf "$BACKUP_PART" postgres.sql redis.rdb env manifest.json
    chmod 600 "$BACKUP_PART"
    mv "$BACKUP_PART" "$ARCHIVE"
    BACKUP_PART=""
    SIZE="$(du -h "$ARCHIVE" | cut -f1)"
    step_done
    echo
    log_ok "backup complete in $(elapsed_total): ${ARCHIVE} (${SIZE}, unencrypted)"
    log_warn "archive contains JWT_SECRET + DB password + CA private key"
    log_warn "encrypt with --password before storing off-host"
fi
