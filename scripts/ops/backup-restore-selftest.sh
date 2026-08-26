#!/usr/bin/env bash
# backup-restore-selftest.sh
#
# Proves that iceslab-backup.sh produces an archive iceslab-restore.sh can put
# back. Nothing else in the repository did: both scripts were written, reviewed
# and never round-tripped, and a backup nobody has restored is a belief, not a
# backup. `iceslab-restore.sh` opens with `DROP SCHEMA public CASCADE`, so the
# first time it is exercised must not be the day it is needed.
#
# How it works: a throwaway compose stack with the SAME images, the same redis
# flags and the same container names the production stack uses, because the
# scripts address those containers by name. Known rows go into Postgres and
# known keys into Redis, a backup is taken, the data is destroyed the way a
# disaster would destroy it, and the restore has to bring it all back.
#
# Both archive shapes are covered (plain and AES-256), plus the refusals: a
# wrong password, and a tarball that is not one of ours.
#
# Usage:
#   ./scripts/ops/backup-restore-selftest.sh [--keep]
#
#     --keep   leave the stack and the work directory standing for inspection
#
# Requires docker. Runs nothing against a live deployment - it refuses to start
# if containers with the production names already exist, and docker itself would
# refuse to create duplicates even if this check were removed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

PASS=0
FAIL=0
ok()   { printf '  \033[1;32mok\033[0m    %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[1;31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL + 1)); }
note() { printf '\033[1;36m[selftest]\033[0m %s\n' "$1"; }

# ───── Refuse to run anywhere near a real deployment ─────
if docker ps -a --format '{{.Names}}' | grep -qE '^iceslab-prod-(postgres|redis|backend|frontend)$'; then
    printf '\033[1;31m[selftest]\033[0m containers with production names already exist on this host.\n'
    printf '           This test drives iceslab-restore.sh, which DROPs the schema of\n'
    printf '           whatever answers to iceslab-prod-postgres. Refusing to run.\n'
    exit 1
fi

WORK="$(mktemp -d)"
cleanup() {
    if [[ $KEEP -eq 1 ]]; then
        note "left standing: $WORK"
        return
    fi
    ( cd "$WORK" 2>/dev/null && docker compose -f compose.yml --env-file env down -v >/dev/null 2>&1 ) || true
    rm -rf "$WORK"
}
trap cleanup EXIT

# ───── The throwaway stack ─────
# Same images and the same redis flags as docker-compose.prod.yml: the restore
# path removes AOF files so a copied rdb is the one that loads, and that only
# means anything with appendonly on.
cat > "${WORK}/compose.yml" <<'YAML'
services:
  postgres:
    image: postgres:16-alpine
    container_name: iceslab-prod-postgres
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - pg:/var/lib/postgresql/data
  redis:
    image: redis:7-alpine
    container_name: iceslab-prod-redis
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - rd:/data
  # The scripts stop and start these by SERVICE name. They stand in for the
  # panel: what matters is that the names exist and that the restore can bring
  # them back up.
  backend:
    image: alpine:3
    container_name: iceslab-prod-backend
    command: ["sleep", "infinity"]
  frontend:
    image: alpine:3
    container_name: iceslab-prod-frontend
    command: ["sleep", "infinity"]
volumes:
  pg:
  rd:
YAML

cat > "${WORK}/env" <<'ENVFILE'
POSTGRES_USER=iceslab
POSTGRES_PASSWORD=selftest-password
POSTGRES_DB=iceslab
JWT_SECRET=selftest-jwt-secret-not-a-real-one
ENVFILE

cd "$WORK"
DC=(docker compose -f compose.yml --env-file env)

note "bringing up a throwaway stack"
"${DC[@]}" up -d >/dev/null 2>&1

for _ in $(seq 1 60); do
    if docker exec iceslab-prod-postgres pg_isready -U iceslab -d iceslab >/dev/null 2>&1; then break; fi
    sleep 1
done
docker exec iceslab-prod-postgres pg_isready -U iceslab -d iceslab >/dev/null
for _ in $(seq 1 30); do
    if [[ "$(docker exec iceslab-prod-redis redis-cli PING 2>/dev/null)" == "PONG" ]]; then break; fi
    sleep 1
done

psql() { docker exec -i iceslab-prod-postgres psql -U iceslab -d iceslab -v ON_ERROR_STOP=1 "$@"; }
redis() { docker exec iceslab-prod-redis redis-cli "$@"; }

# ───── Seed something recognisable ─────
# A table, a sequence and a row whose value would be wrong if the dump were
# taken before the write or loaded partially.
note "seeding known data"
psql -q -c "CREATE TABLE subscribers (id serial PRIMARY KEY, name text NOT NULL, bytes bigint NOT NULL);" >/dev/null
psql -q -c "INSERT INTO subscribers (name, bytes) SELECT 'user-' || g, g * 1000000 FROM generate_series(1, 250) g;" >/dev/null
SEEDED_SUM="$(psql -tAc "SELECT sum(bytes) FROM subscribers;")"
SEEDED_COUNT="$(psql -tAc "SELECT count(*) FROM subscribers;")"
redis SET selftest:key "a-value-that-must-survive" >/dev/null
redis SET selftest:counter 42 >/dev/null
redis RPUSH selftest:list one two three >/dev/null

# ───── 1. Plain archive ─────
note "backup (plain)"
"${SCRIPT_DIR}/iceslab-backup.sh" --compose-file compose.yml --env-file env --out "${WORK}/backups" >/dev/null
ARCHIVE="$(ls -1 "${WORK}/backups"/iceslab-backup-*.tar.gz 2>/dev/null | head -1)"
if [[ -n "$ARCHIVE" ]]; then ok "an archive was produced"; else bad "no archive produced"; fi

# The archive is the whole control plane: dump, redis snapshot, env, manifest.
CONTENTS="$(tar -tzf "$ARCHIVE" | sort | tr '\n' ' ')"
if [[ "$CONTENTS" == "env manifest.json postgres.sql redis.rdb "* ]]; then
    ok "archive carries dump, rdb, env and manifest"
else
    bad "archive contents are [$CONTENTS]"
fi

# It holds the JWT secret and the database password, so it must not be readable
# by anyone else on the host.
PERMS="$(stat -c '%a' "$ARCHIVE")"
if [[ "$PERMS" == "600" ]]; then ok "archive is 0600"; else bad "archive is $PERMS, expected 600"; fi

# ───── 2. Destroy the way a disaster would ─────
note "destroying the data"
psql -q -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null
redis FLUSHALL >/dev/null
if [[ "$(psql -tAc "SELECT to_regclass('public.subscribers') IS NULL;")" == "t" ]]; then
    ok "the table is gone before the restore"
else
    bad "the table survived the drop, so the restore proves nothing"
fi
if [[ "$(redis GET selftest:key)" == "" ]]; then
    ok "redis is empty before the restore"
else
    bad "redis still holds data, so the restore proves nothing"
fi

# ───── 3. Restore ─────
note "restore"
"${SCRIPT_DIR}/iceslab-restore.sh" "$ARCHIVE" --compose-file compose.yml --env-file env --yes >/dev/null

RESTORED_COUNT="$(psql -tAc "SELECT count(*) FROM subscribers;" 2>/dev/null || echo "MISSING")"
RESTORED_SUM="$(psql -tAc "SELECT sum(bytes) FROM subscribers;" 2>/dev/null || echo "MISSING")"
if [[ "$RESTORED_COUNT" == "$SEEDED_COUNT" ]]; then
    ok "every row is back ($RESTORED_COUNT)"
else
    bad "row count is $RESTORED_COUNT, seeded $SEEDED_COUNT"
fi
if [[ "$RESTORED_SUM" == "$SEEDED_SUM" ]]; then
    ok "the rows carry their values, not just their count"
else
    bad "checksum is $RESTORED_SUM, seeded $SEEDED_SUM"
fi

# A restored sequence has to keep going from where it was; a reset one makes the
# next insert collide with an existing id.
# -q as well as -tA: without it psql prints the "INSERT 0 1" command tag on the
# same stream as the returned id, and the numeric compare below gets two lines.
NEXT_ID="$(psql -tAqc "INSERT INTO subscribers (name, bytes) VALUES ('after-restore', 1) RETURNING id;" 2>/dev/null | head -1)"
[[ -n "${NEXT_ID//[0-9]/}" || -z "$NEXT_ID" ]] && NEXT_ID=0
if [[ "$NEXT_ID" -gt "$SEEDED_COUNT" ]]; then
    ok "the sequence resumed past the restored rows (next id $NEXT_ID)"
else
    bad "next id is $NEXT_ID, which collides with the restored rows"
fi
psql -q -c "DELETE FROM subscribers WHERE name = 'after-restore';" >/dev/null

for _ in $(seq 1 30); do
    [[ "$(docker exec iceslab-prod-redis redis-cli PING 2>/dev/null)" == "PONG" ]] && break
    sleep 1
done
if [[ "$(redis GET selftest:key)" == "a-value-that-must-survive" ]]; then
    ok "redis strings are back"
else
    bad "redis key did not survive: got [$(redis GET selftest:key)]"
fi
if [[ "$(redis LRANGE selftest:list 0 -1 | tr '\n' ',')" == "one,two,three," ]]; then
    ok "redis lists are back in order"
else
    bad "redis list did not survive: got [$(redis LRANGE selftest:list 0 -1 | tr '\n' ',')]"
fi

# The panel has to be running again when the restore says it is done.
for svc in backend frontend; do
    state="$(docker inspect -f '{{.State.Running}}' "iceslab-prod-${svc}" 2>/dev/null || echo false)"
    if [[ "$state" == "true" ]]; then
        ok "$svc is running after the restore"
    else
        bad "$svc was left stopped"
    fi
done

# The restore says it does NOT overwrite the live env file. An operator who has
# rotated a secret since the backup would otherwise be rolled back to the old one.
if grep -q '^POSTGRES_PASSWORD=selftest-password$' env; then
    ok "the live env file was left alone"
else
    bad "the env file was overwritten by the archive's copy"
fi

# ───── 4. Encrypted archive ─────
note "backup + restore (AES-256)"
psql -q -c "INSERT INTO subscribers (name, bytes) VALUES ('encrypted-round-trip', 777);" >/dev/null
redis SET selftest:enc "encrypted-value" >/dev/null
"${SCRIPT_DIR}/iceslab-backup.sh" --compose-file compose.yml --env-file env \
    --out "${WORK}/backups" --password "correct horse" >/dev/null
ENC="$(ls -1 "${WORK}/backups"/iceslab-backup-*.tar.gz.enc 2>/dev/null | head -1)"
if [[ -n "$ENC" ]]; then ok "an encrypted archive was produced"; else bad "no encrypted archive"; fi

# Encrypted at rest means encrypted: the secrets it carries must not be greppable.
if grep -qa "selftest-jwt-secret-not-a-real-one" "$ENC"; then
    bad "the JWT secret is readable inside the encrypted archive"
else
    ok "secrets are not readable in the encrypted archive"
fi

psql -q -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null
redis FLUSHALL >/dev/null

if "${SCRIPT_DIR}/iceslab-restore.sh" "$ENC" --compose-file compose.yml --env-file env --yes >/dev/null 2>&1; then
    bad "an encrypted archive was accepted with no password"
else
    ok "an encrypted archive is refused without a password"
fi

if "${SCRIPT_DIR}/iceslab-restore.sh" "$ENC" --compose-file compose.yml --env-file env \
        --password "wrong horse" --yes >/dev/null 2>&1; then
    bad "the wrong password was accepted"
else
    ok "the wrong password is refused"
fi

"${SCRIPT_DIR}/iceslab-restore.sh" "$ENC" --compose-file compose.yml --env-file env \
    --password "correct horse" --yes >/dev/null
for _ in $(seq 1 30); do
    [[ "$(docker exec iceslab-prod-redis redis-cli PING 2>/dev/null)" == "PONG" ]] && break
    sleep 1
done
if [[ "$(psql -tAc "SELECT bytes FROM subscribers WHERE name = 'encrypted-round-trip';" 2>/dev/null)" == "777" ]]; then
    ok "the encrypted round trip brings postgres back"
else
    bad "the encrypted round trip lost the row"
fi
if [[ "$(redis GET selftest:enc)" == "encrypted-value" ]]; then
    ok "the encrypted round trip brings redis back"
else
    bad "the encrypted round trip lost the redis key"
fi

# ───── 5. A tarball that is not ours ─────
# Restoring one would DROP the schema and then load nothing.
note "refusals"
FOREIGN="${WORK}/backups/not-ours.tar.gz"
mkdir -p "${WORK}/foreign" && echo hi > "${WORK}/foreign/hello.txt"
tar -C "${WORK}/foreign" -czf "$FOREIGN" hello.txt
if "${SCRIPT_DIR}/iceslab-restore.sh" "$FOREIGN" --compose-file compose.yml --env-file env --yes >/dev/null 2>&1; then
    bad "a tarball with no manifest was accepted"
else
    ok "a tarball with no manifest is refused"
fi
if [[ "$(psql -tAc "SELECT count(*) FROM subscribers;" 2>/dev/null)" -gt 0 ]]; then
    ok "the refused restore left the database alone"
else
    bad "the refused restore dropped the schema anyway"
fi

if "${SCRIPT_DIR}/iceslab-restore.sh" "${WORK}/no-such-file.tar.gz" \
        --compose-file compose.yml --env-file env --yes >/dev/null 2>&1; then
    bad "a missing archive was accepted"
else
    ok "a missing archive is refused"
fi

echo
if [[ $FAIL -eq 0 ]]; then
    printf '\033[1;32m%d/%d check(s) passed\033[0m\n' "$PASS" "$((PASS + FAIL))"
    exit 0
fi
printf '\033[1;31m%d/%d check(s) passed, %d failed\033[0m\n' "$PASS" "$((PASS + FAIL))" "$FAIL"
exit 1
