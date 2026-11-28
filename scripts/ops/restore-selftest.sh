#!/usr/bin/env bash
# restore-selftest.sh
#
# m20.4: the promises of iceslab-backup.sh / iceslab-restore.sh that need no
# real stack, checked against a stub `docker` (the real round trip is
# backup-restore-selftest.sh):
#
#   * restore brings postgres and redis up before it drops the database (after
#     a full `compose down` there are no containers to restore into);
#   * restore step 5 calls `compose up -d backend frontend`, never `start` of
#     them (a left-over container of a newer build must not come back over an
#     older database, and with no containers `start` fails on `migrate`);
#   * the manifest of a backup has `gitSha` (only in a git checkout) and
#     `migrations` (count + last name; none without the table);
#   * restore prints them, WARNS and goes on when the archive's database has
#     migrations the code does not, says nothing of the kind for a matching
#     one, and takes an old archive without the fields as before.
#
# Needs: bash, git, tar. No docker, no network. Takes a few seconds.
#   ./scripts/ops/restore-selftest.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0
ok()   { printf '  \033[1;32mok\033[0m    %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[1;31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL + 1)); }
note() { printf '\033[1;36m[restore-selftest]\033[0m %s\n' "$1"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BIN="${WORK}/bin"
LOG="${WORK}/docker.log"
mkdir -p "$BIN"

cat > "${BIN}/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
    ps) printf 'iceslab-prod-postgres\niceslab-prod-redis\n' ;;
    inspect)
        case "$*" in *Config.Image*) echo redis:7-alpine ;; *) exit 1 ;; esac ;;
    compose)
        case "$*" in
            *' config --services'*) printf 'postgres\nredis\nbackend\nfrontend\nmigrate\n' ;;
            *' ps --status running'*) : ;;
        esac ;;
    exec)
        case "$*" in
            *pg_dump*) echo 'SELECT 1;' ;;
            *_prisma_migrations*) [[ -n "${FAKE_MIG:-}" ]] && echo "$FAKE_MIG" ;;
            *LASTSAVE*) c=$(cat "$FAKE_STATE/ls" 2>/dev/null || echo 100); echo "$c"; echo $((c + 1)) > "$FAKE_STATE/ls" ;;
            *TIME*) echo "9999999999 0" ;;
            *"redis-cli ping"*) echo PONG ;;
            *"INFO persistence"*) printf 'aof_enabled:1\naof_rewrite_in_progress:0\naof_rewrite_scheduled:0\n' ;;
            *) cat >/dev/null 2>&1 < /dev/null ;;
        esac ;;
    cp) case "$2" in *dump.rdb) printf 'RDB' > "$3" ;; esac ;;
esac
exit 0
STUB
chmod +x "${BIN}/docker"
printf '#!/usr/bin/env bash\nexit 0\n' > "${BIN}/sleep"; chmod +x "${BIN}/sleep"

mkpanel() { # mkpanel DIR  (compose + env; migrations a, b)
    mkdir -p "$1/apps/panel-backend/prisma/migrations/20260101000000_a" "$1/apps/panel-backend/prisma/migrations/20260102000000_b"
    : > "$1/docker-compose.prod.yml"
    printf 'POSTGRES_USER=u\nPOSTGRES_DB=d\nJWT_SECRET=x\n' > "$1/.env.production"
}
run() { # run DIR script args... ; output in $WORK/out, status returned
    local dir="$1"; shift
    : > "$LOG"
    ( cd "$dir" && PATH="${BIN}:${PATH}" FAKE_DOCKER_LOG="$LOG" FAKE_STATE="$WORK" \
        ICESLAB_RESTORE_ENV_DIR="${WORK}/renv" "$@" ) > "${WORK}/out" 2>&1
}
mkarchive() { # mkarchive NAME MANIFEST-JSON
    local d="${WORK}/ar-$1"
    mkdir -p "$d"
    printf 'SELECT 1;\n' > "$d/postgres.sql"; printf 'RDB' > "$d/redis.rdb"; printf 'JWT_SECRET=x\n' > "$d/env"
    printf '%s\n' "$2" > "$d/manifest.json"
    tar -C "$d" -czf "${WORK}/$1.tar.gz" postgres.sql redis.rdb env manifest.json
}

# ───── backup: the manifest ─────
note "backup manifest"
GITPANEL="${WORK}/gitpanel"; PLAIN="${WORK}/plainpanel"
mkpanel "$GITPANEL"; mkpanel "$PLAIN"
( cd "$GITPANEL" && git init -q . && git add -A && git -c user.email=a@b -c user.name=t commit -qm init )
SHA="$(git -C "$GITPANEL" rev-parse HEAD)"

FAKE_MIG='2|20260102000000_b' run "$GITPANEL" "${SCRIPT_DIR}/iceslab-backup.sh" --out "${WORK}/b1"
M1="$(tar -xzOf "${WORK}"/b1/iceslab-backup-*.tar.gz manifest.json 2>/dev/null)"
if grep -q "\"gitSha\": \"${SHA}\"" <<<"$M1"; then ok "the manifest carries gitSha in a git checkout"; else bad "no gitSha: $M1"; fi
if grep -q '"migrations": {"count": 2, "last": "20260102000000_b"}' <<<"$M1"; then ok "the manifest carries the migration count and the last name"; else bad "no migrations: $M1"; fi
if tar -xzOf "${WORK}"/b1/iceslab-backup-*.tar.gz manifest.json | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then ok "the manifest is valid JSON"; else bad "the manifest is not valid JSON: $M1"; fi

run "$PLAIN" "${SCRIPT_DIR}/iceslab-backup.sh" --out "${WORK}/b2"
M2="$(tar -xzOf "${WORK}"/b2/iceslab-backup-*.tar.gz manifest.json 2>/dev/null)"
if [[ -n "$M2" ]] && ! grep -q 'gitSha\|migrations' <<<"$M2"; then ok "no git checkout and no migrations table: neither field, the backup still works"; else bad "unexpected manifest: $M2"; fi
if tar -xzOf "${WORK}"/b2/iceslab-backup-*.tar.gz manifest.json | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then ok "and it is valid JSON"; else bad "plain manifest is not valid JSON"; fi

# ───── restore: step 5 ─────
note "restore"
OLD='{"createdAt":"20260101T000000Z","compose":"docker-compose.prod.yml","envFile":".env.production","postgresUser":"u","postgresDb":"d","components":["postgres.sql","redis.rdb","env"]}'
mkarchive old "$OLD"
mkarchive same '{"createdAt":"x","gitSha":"abc123","migrations": {"count": 2, "last": "20260102000000_b"}, "components":[]}'
mkarchive newer '{"createdAt":"x","gitSha":"abc123","migrations": {"count": 3, "last": "20260103000000_c"}, "components":[]}'

if run "$PLAIN" "${SCRIPT_DIR}/iceslab-restore.sh" "${WORK}/old.tar.gz" --yes; then ok "restore of an old archive without the fields succeeds"; else bad "old archive: $(tail -5 "${WORK}/out")"; fi
if grep -q 'compose .*up -d backend frontend' "$LOG"; then ok "step 5 runs 'up -d backend frontend'"; else bad "no 'up -d backend frontend' in: $(grep compose "$LOG" | tr '\n' ';')"; fi
if grep -qE 'compose .* start .*(backend|frontend)' "$LOG"; then bad "step 5 still calls 'start' for the panel services"; else ok "and never 'start' for them"; fi
if grep -q 'NEWER' "${WORK}/out"; then bad "an old archive got the newer-than-code warning"; else ok "an old archive gets no warning"; fi
# After a full `compose down` there is no postgres or redis container to restore
# into: they are brought up (and waited for) before the database is dropped.
up_at="$(grep -n 'compose .*up -d --wait postgres redis' "$LOG" | head -1 | cut -d: -f1)"
drop_at="$(grep -n 'DROP SCHEMA' "$LOG" | head -1 | cut -d: -f1)"
if [[ -n "$up_at" && -n "$drop_at" ]] && (( up_at < drop_at )); then ok "postgres and redis are brought up before the database is dropped"; else bad "no 'up -d --wait postgres redis' before DROP (up at ${up_at:-none}, drop at ${drop_at:-none})"; fi

if run "$PLAIN" "${SCRIPT_DIR}/iceslab-restore.sh" "${WORK}/same.tar.gz" --yes; then ok "restore of a matching archive succeeds"; else bad "matching archive: $(tail -5 "${WORK}/out")"; fi
if grep -q 'archive database: 2 migrations, the last is 20260102000000_b' "${WORK}/out"; then ok "restore prints the archive's migrations"; else bad "not printed: $(cat "${WORK}/out")"; fi
if grep -q 'NEWER' "${WORK}/out"; then bad "a matching archive got the warning"; else ok "a matching archive gets no warning"; fi

if run "$PLAIN" "${SCRIPT_DIR}/iceslab-restore.sh" "${WORK}/newer.tar.gz" --yes; then ok "restore of a newer archive still goes on (a warning, not a refusal)"; else bad "newer archive refused: $(tail -5 "${WORK}/out")"; fi
if grep -q 'NEWER than this code' "${WORK}/out" && grep -q 'ICESLAB_REF' "${WORK}/out" && grep -q 'git checkout abc123' "${WORK}/out"; then ok "it warns and names the rollback order and the archive's commit"; else bad "no warning: $(cat "${WORK}/out")"; fi
if grep -q 'compose .*up -d backend frontend' "$LOG"; then ok "and brings the panel up"; else bad "newer archive: panel not brought up"; fi

echo
if [[ $FAIL -eq 0 ]]; then
    printf '\033[1;32m%d/%d check(s) passed\033[0m\n' "$PASS" "$((PASS + FAIL))"
    exit 0
fi
printf '\033[1;31m%d/%d check(s) passed, %d failed\033[0m\n' "$PASS" "$((PASS + FAIL))" "$FAIL"
exit 1
