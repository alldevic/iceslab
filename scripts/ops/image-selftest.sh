#!/usr/bin/env bash
# image-selftest.sh
#
# Steps 6-9 of install-iceslab.sh — pre-pull, build, migrate, launch — were, on
# the day this was written, verified by exactly one thing: they returned zero.
# The whole VM run (§46.16) proved the stack comes up; it proved nothing about
# what is IN the images that came up, or about what `migrate` did on its way
# there. "It exited 0" is also true of a build that shipped the operator's
# secrets, of a `migrate deploy` that applied nothing because the schema was
# already there, and of a health loop that probes with a binary the image does
# not have and warns for sixty seconds while the panel is fine.
#
# So this asks the artefacts, not the source:
#
#   * the images, for what they contain and who they run as. An image is a
#     filesystem; the way to find out what is in it is to look, and the answer
#     changes with base-image bumps and .dockerignore edits that no one links
#     to this question.
#   * `prisma migrate deploy`, against an EMPTY database, for whether it
#     applied every migration in the tree — and then a second time, for whether
#     it says so when there is nothing left to do. Both directions matter: a
#     first run that silently applies nothing and a second run that re-applies
#     are different failures with the same exit code.
#   * the panel installer's own health probe, run inside a real backend
#     container against a real Postgres and Redis. The probe names a binary and
#     a URL and greps for a string, and all three live in the other artefact.
#   * the frontend container, RUNNING, for which public paths it forwards to the
#     backend and which its SPA fallback swallows. nginx routes by prefix,
#     regex and modifier, and the fallback answers every unmatched path with
#     index.html and HTTP 200 — so a missing route is invisible in the config
#     and invisible in the status code, and only a request finds it.
#   * docker-compose.prod.yml, for who publishes a port. A published port is
#     DNAT'd in nat/PREROUTING before ufw's filter chains run, so `ufw deny` on
#     it does nothing — measured on a VM in §46.16. Postgres and Redis publish
#     nothing today and that is load-bearing, not incidental.
#
# Needs: docker. ~2 minutes when the build cache is warm, 5-10 on the first run
# (it builds the same two images the installer builds, from the same
# Dockerfiles, with the repo root as context).
#
# Usage:
#   ./scripts/ops/image-selftest.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PANEL_INSTALLER="${REPO_ROOT}/scripts/install-iceslab.sh"
COMPOSE="${REPO_ROOT}/docker-compose.prod.yml"

BACKEND_IMG=iceslab-image-selftest-backend:latest
FRONTEND_IMG=iceslab-image-selftest-frontend:latest
NET="iceslab-imgtest-$$"
PG="iceslab-imgtest-pg-$$"
RD="iceslab-imgtest-redis-$$"
BE="iceslab-imgtest-backend-$$"
FE="iceslab-imgtest-frontend-$$"
MB="iceslab-imgtest-marker-$$"
FE_PORT=18099
PGPASS=imgtest
DBURL="postgres://iceslab:${PGPASS}@${PG}:5432/iceslab"

PASS=0
FAIL=0
ok()   { printf '  \033[1;32mok\033[0m    %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[1;31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL + 1)); }
note() { printf '\033[1;36m[image-selftest]\033[0m %s\n' "$1"; }

for f in "$PANEL_INSTALLER" "$COMPOSE"; do
    [[ -r "$f" ]] || { printf 'not readable: %s\n' "$f" >&2; exit 2; }
done
if ! command -v docker >/dev/null || ! docker info >/dev/null 2>&1; then
    printf 'docker is required and not usable by this user; NOT skipping silently\n' >&2
    exit 2
fi

cleanup() {
    docker rm -f "$BE" "$PG" "$RD" "$FE" "$MB" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ═════════════════════════════════════════════════════════════════════════════
#  The images, built the way the installer builds them
# ═════════════════════════════════════════════════════════════════════════════
note "building (cached after the first run)"
for spec in "apps/panel-backend/Dockerfile ${BACKEND_IMG}" "apps/panel-frontend/Dockerfile ${FRONTEND_IMG}"; do
    set -- $spec
    if ! (cd "$REPO_ROOT" && docker build -q -f "$1" -t "$2" . >/dev/null 2>&1); then
        printf 'could not build %s from %s. The `# syntax=` line is fetched from\n' "$2" "$1" >&2
        printf 'Docker Hub, so a failure here can be the network; NOT skipping silently\n' >&2
        exit 2
    fi
done
ok "both panel images build from the Dockerfiles compose names"

# The harness's own control: every case below reads a container's filesystem,
# and "the file is not there" is also what an image that failed to build, or a
# `docker run` that never started, would say.
if [[ "$(docker run --rm --entrypoint sh "$BACKEND_IMG" -c 'echo alive')" == "alive" ]]; then
    ok "a shell runs in the backend image, so 'not found' below means not found"
else
    bad "could not run a shell in ${BACKEND_IMG}; every case below would pass for the wrong reason"
fi

beq() { docker run --rm --entrypoint sh "$BACKEND_IMG" -c "$1" 2>/dev/null; }

# ───── What must not be in there ─────
#
# .env.production is written by the installer INTO the directory it then builds
# from, at step 5, and the build context is that same directory. Nothing but
# .dockerignore stands between the operator's JWT_SECRET and a layer that keeps
# it forever — including in any image ever pushed anywhere.
note "what the backend image contains"
ENVFILES="$(beq 'find /app -name ".env*" -not -path "*/node_modules/*" 2>/dev/null')"
if [[ -z "$ENVFILES" ]]; then
    ok "no .env file of ours is in the image (the build context holds .env.production at install time)"
else
    bad "the image carries env files:
$(sed 's/^/      /' <<<"$ENVFILES")"
fi
if [[ -z "$(beq 'find /app -maxdepth 4 -name ".git" 2>/dev/null')" ]]; then
    ok "and no .git, so the fork's history is not shipped to every node operator"
else
    bad "a .git directory is in the image"
fi

# The sources. Not a secret and not a size problem (6.5 MB against 474 MB of
# node_modules) - the point is that `node dist/index.js` cannot reach a line of
# it, so every one of those files is something an operator can host, patch and
# be confused by without any of it changing what runs. Asked of the image
# rather than of the Dockerfile: a COPY that takes a whole directory grows what
# it ships every time the directory grows, and nothing links that to this
# question.
BE_SRC="$(beq 'find /app/apps/panel-backend/src -type f 2>/dev/null | wc -l')"
if [[ "${BE_SRC:-0}" == "0" ]]; then
    ok "the backend's own src/ is not in the image (dist/ is what CMD runs)"
else
    bad "apps/panel-backend/src is in the image: ${BE_SRC} files"
fi
TESTFILES="$(beq 'find /app/apps /app/packages -name "*.test.ts" -o -name "vitest.config.ts" 2>/dev/null' | head -20)"
if [[ -z "$TESTFILES" ]]; then
    ok "and neither is the test suite, nor the vitest config that names it"
else
    bad "the image carries test files:
$(sed 's/^/      /' <<<"$TESTFILES")"
fi

# The control on both cases above, and the reason the prune is a list and not
# `rm -rf */src`: @iceslab/shared's package entry IS its TypeScript source, so
# its src/ has to survive with the .js siblings the builder emits beside it.
# Without this, an over-eager prune passes the two cases above by deleting the
# program, and the failure only shows up when a container is started.
SHARED_TS="$(beq 'test -f /app/packages/shared/src/index.ts && echo yes')"
SHARED_JS="$(beq 'test -f /app/packages/shared/src/index.js && echo yes')"
if [[ "$SHARED_TS" == "yes" && "$SHARED_JS" == "yes" ]]; then
    ok "packages/shared/src still holds index.ts and the emitted index.js beside it"
else
    bad "packages/shared/src is missing index.ts (${SHARED_TS:-no}) or index.js (${SHARED_JS:-no}); the backend cannot import @iceslab/shared"
fi

# ───── The cores the panel carries for its fleet ─────
#
# Nodes used to fetch their proxy core straight from GitHub — "latest" resolved
# through api.github.com and installed unverified. Now the panel carries them,
# pinned by version and sha256 in packages/shared/src/core-binaries.ts, and the
# build fails rather than shipping an unexpected binary.
#
# Asked of the IMAGE, and asked by recomputing: the build already verified what
# it downloaded, so re-reading the build log would only prove the log. What is
# unknown here is whether what the image CARRIES is still those bytes — a
# later COPY, a prune, a cache mount reused across a bumped pin.
note "the proxy cores the image carries"
CORES_EXPECTED="$(docker run --rm --entrypoint node "$BACKEND_IMG" --input-type=module -e '
  const { CORE_BINARIES } = await import("/app/packages/shared/src/core-binaries.js");
  for (const [name, core] of Object.entries(CORE_BINARIES))
    for (const [arch, a] of Object.entries(core.assets))
      console.log(`${name}-${arch} ${a.sha256}`);
' 2>/dev/null)"
if [[ "$(wc -l <<<"$CORES_EXPECTED")" -gt 5 ]]; then
    ok "the image can read its own pinned manifest ($(wc -l <<<"$CORES_EXPECTED") artefacts declared)"
else
    bad "could not read the core manifest out of the image; every case below would be empty:
$(sed 's/^/      /' <<<"$CORES_EXPECTED")"
fi

CORES_ACTUAL="$(beq 'cd /app/cores 2>/dev/null && sha256sum * 2>/dev/null | while read -r sha f; do echo "$f $sha"; done')"
CARRIED="$(wc -l <<<"$CORES_ACTUAL")"
if [[ -n "$CORES_ACTUAL" && "$CARRIED" -gt 5 ]]; then
    ok "and it carries ${CARRIED} of them under /app/cores"
else
    bad "/app/cores holds nothing the fleet could install from"
fi

# Every file carried has to be one the manifest declares, with the sha the
# manifest declares. The other direction is deliberately NOT asserted: the
# build takes CORE_ARCHES, so an image may legitimately carry fewer
# architectures than the manifest knows about.
MISMATCH=""
while read -r f sha; do
    [[ -n "$f" ]] || continue
    want="$(grep -m1 "^${f} " <<<"$CORES_EXPECTED" | awk '{print $2}')"
    if [[ -z "$want" ]]; then
        MISMATCH="${MISMATCH}
      ${f}: carried but not declared in the manifest"
    elif [[ "$want" != "$sha" ]]; then
        MISMATCH="${MISMATCH}
      ${f}: carries ${sha}, manifest pins ${want}"
    fi
done <<<"$CORES_ACTUAL"
if [[ -z "$MISMATCH" ]]; then
    ok "and every one of them hashes to the sha256 the manifest pins"
else
    bad "the image carries bytes the manifest does not describe:${MISMATCH}"
fi

# The panel's own sing-box comes out of that same set now. It used to be a
# second download pinned to a different version, which is one artefact and two
# numbers to bump; and it has to RUN here, on alpine, which is why the manifest
# pins the statically linked musl build rather than the plain one.
SB_VER="$(beq '/usr/local/bin/sing-box version 2>/dev/null | head -1')"
if grep -q 'sing-box version' <<<"$SB_VER"; then
    ok "the geo builder's sing-box runs in this image (${SB_VER})"
else
    bad "sing-box does not run in the image: ${SB_VER:-no output}. The plain linux-amd64 build is glibc-linked and exits 127 on alpine; the manifest must pin the -musl artefact"
fi

# ───── Who it runs as ─────
#
# The long-lived backend runs unprivileged; the migrate one-shot overrides back
# to root in compose because it shells out to corepack. The image's own default
# is the one that matters, because that is what `docker run` and every compose
# service that does NOT override gets.
UID_IN="$(beq 'id -u')"
if [[ "$UID_IN" != "0" && -n "$UID_IN" ]]; then
    ok "the image's default user is unprivileged (uid ${UID_IN})"
else
    bad "the backend image defaults to uid '${UID_IN:-unknown}'"
fi

# ───── The entrypoint names a file that is there ─────
CMD_JSON="$(docker image inspect "$BACKEND_IMG" --format '{{json .Config.Cmd}}')"
CMD_FILE="$(grep -oE '[A-Za-z0-9_/.-]+\.js' <<<"$CMD_JSON" | head -1)"
if [[ -n "$CMD_FILE" ]]; then
    ok "the image's CMD names an entry file (${CMD_FILE})"
else
    bad "no .js entry parsed out of CMD ${CMD_JSON}; the case below would be empty"
fi
WD="$(docker image inspect "$BACKEND_IMG" --format '{{.Config.WorkingDir}}')"
if [[ -n "$CMD_FILE" ]] && beq "test -f '${WD}/${CMD_FILE}'"; then
    ok "and that file exists at the image's WorkingDir (${WD})"
else
    bad "${WD}/${CMD_FILE} is not in the image: the container's only command cannot run"
fi

# ═════════════════════════════════════════════════════════════════════════════
#  Step 8: what `migrate deploy` did
# ═════════════════════════════════════════════════════════════════════════════
#
# The installer runs it as one line and reads its exit code. Exit 0 covers both
# "applied 56 migrations" and "there was nothing to apply", and those are the
# same outcome only when the database was already migrated — which on a fresh
# install it is not. So: an EMPTY database, then count.
note "prisma migrate deploy, against an empty database"

TREE_COUNT="$(find "${REPO_ROOT}/apps/panel-backend/prisma/migrations" -mindepth 1 -maxdepth 1 -type d | wc -l)"
if [[ "$TREE_COUNT" -gt 10 ]]; then
    ok "the migration tree holds ${TREE_COUNT} migrations"
else
    bad "only ${TREE_COUNT} migration directories were found; the count below would prove nothing"
fi

docker network create "$NET" >/dev/null 2>&1
docker run -d --name "$PG" --network "$NET" \
    -e POSTGRES_USER=iceslab -e POSTGRES_PASSWORD="$PGPASS" -e POSTGRES_DB=iceslab \
    postgres:16-alpine >/dev/null 2>&1
psql_q() { docker exec "$PG" psql -U iceslab -d iceslab -tAc "$1" 2>/dev/null | tr -d '\r'; }

# Waited on with a QUERY, not with pg_isready. The official image starts a
# temporary server to run its init scripts and then restarts it, so pg_isready
# answers yes to a socket that is about to go away — and the case below then
# reads an empty string where it wanted a row count and says the fresh database
# "already has  tables". That was this harness's own control catching this
# harness, on the first run after the wait was written.
pg_ready=""
for _ in $(seq 1 60); do
    [[ "$(psql_q 'select 1')" == "1" ]] && { pg_ready=1; break; }
    sleep 1
done

if [[ -n "$pg_ready" ]]; then
    ok "a throwaway postgres:16-alpine answers a query"
else
    bad "the throwaway postgres never answered a query; the migration cases cannot run"
fi

BEFORE="$(psql_q "select count(*) from information_schema.tables where table_schema='public'")"
if [[ "$BEFORE" == "0" ]]; then
    ok "and its public schema is empty, so anything found after is something migrate made"
else
    bad "the fresh database already has ${BEFORE} tables; 'migrate applied them' would be unprovable"
fi

MIG_OUT="$(docker run --rm --network "$NET" --user root -e DATABASE_URL="$DBURL" \
    "$BACKEND_IMG" pnpm exec prisma migrate deploy 2>&1)"
MIG_RC=$?
APPLIED="$(psql_q "select count(*) from _prisma_migrations where finished_at is not null")"
if [[ "$MIG_RC" == "0" ]]; then
    ok "migrate deploy exited 0 (which is all step 8 has ever checked)"
else
    bad "migrate deploy exited ${MIG_RC}:
$(sed 's/^/      /' <<<"$MIG_OUT" | tail -20)"
fi
if [[ "$APPLIED" == "$TREE_COUNT" ]]; then
    ok "and every one of the ${TREE_COUNT} migrations is recorded applied, not just the exit code"
else
    bad "the tree has ${TREE_COUNT} migrations and the database records ${APPLIED:-none} applied:
$(sed 's/^/      /' <<<"$MIG_OUT" | tail -20)"
fi
# The schema itself, not only the bookkeeping table: a _prisma_migrations row
# is written by the same command that would have written it after doing nothing.
TABLES="$(psql_q "select count(*) from information_schema.tables where table_schema='public'")"
if [[ "${TABLES:-0}" -gt 10 ]]; then
    ok "and the public schema now holds ${TABLES} tables"
else
    bad "after migrating, the public schema holds ${TABLES:-0} tables"
fi

# The second run. `deploy` is what every re-install and every deploy script
# calls, and it has to be a no-op that says it is one.
MIG_OUT2="$(docker run --rm --network "$NET" --user root -e DATABASE_URL="$DBURL" \
    "$BACKEND_IMG" pnpm exec prisma migrate deploy 2>&1)"
MIG_RC2=$?
APPLIED2="$(psql_q "select count(*) from _prisma_migrations where finished_at is not null")"
if [[ "$MIG_RC2" == "0" ]] && grep -qi 'no pending migrations' <<<"$MIG_OUT2"; then
    ok "a second run says there is nothing pending rather than exiting 0 in silence"
else
    bad "the second migrate deploy exited ${MIG_RC2} and said:
$(sed 's/^/      /' <<<"$MIG_OUT2" | tail -20)"
fi
if [[ "$APPLIED2" == "$APPLIED" ]]; then
    ok "and applied nothing a second time"
else
    bad "the applied count moved from ${APPLIED} to ${APPLIED2} on a re-run"
fi

# ═════════════════════════════════════════════════════════════════════════════
#  Step 9: the health probe the installer actually runs
# ═════════════════════════════════════════════════════════════════════════════
#
# Three things live in the other artefact — the binary, the URL, and the string
# grepped out of the reply — and the failure mode of any of them is the same
# sixty-second warn branch on an install that is otherwise fine. They are read
# out of the installer here rather than copied, so a change on that side is
# what this runs.
note "the installer's own health probe, inside a real backend container"

# The whole command, not its first word: `wget -qO- URL` and `wget URL` are two
# different programs, and the second one writes a file and prints nothing. The
# first version of this harness took $1 and spent ten minutes proving it.
PROBE_CMD="$(grep -A1 'exec -T backend' "$PANEL_INSTALLER" | tail -1 | sed 's/^ *//; s/ 2>\/dev\/null.*//')"
PROBE_BIN="$(awk '{print $1}' <<<"$PROBE_CMD")"
PROBE_URL="$(grep -oE 'https?://[^ ]+' <<<"$PROBE_CMD")"
PROBE_GREP="$(grep -A1 'exec -T backend' "$PANEL_INSTALLER" | tail -1 | grep -oE "grep -q '[^']+'" | sed "s/grep -q '//; s/'$//")"
if [[ -n "$PROBE_BIN" && -n "$PROBE_URL" && -n "$PROBE_GREP" ]]; then
    ok "read the probe out of the installer: ${PROBE_CMD} | grep ${PROBE_GREP}"
else
    bad "could not read the probe out of ${PANEL_INSTALLER} (cmd='${PROBE_CMD}' url='${PROBE_URL}' grep='${PROBE_GREP}')"
fi
if [[ -n "$PROBE_BIN" ]] && beq "command -v ${PROBE_BIN} >/dev/null"; then
    ok "and ${PROBE_BIN} exists in the image the probe is exec'd into"
else
    bad "${PROBE_BIN} is not in the backend image: the health loop warns for 60s on every install"
fi

# Redis first and waited for, because compose does the same: the backend's
# `depends_on` gates on `redis: service_healthy`. Starting them together makes
# the harness measure a race rather than the panel.
docker run -d --name "$RD" --network "$NET" redis:7-alpine >/dev/null 2>&1
rd_ready=""
for _ in $(seq 1 30); do
    [[ "$(docker exec "$RD" redis-cli ping 2>/dev/null | tr -d '\r')" == "PONG" ]] && { rd_ready=1; break; }
    sleep 1
done
if [[ -n "$rd_ready" ]]; then
    ok "a throwaway redis:7-alpine answers PING"
else
    bad "the throwaway redis never came up; the health cases below cannot mean anything"
fi
docker run -d --name "$BE" --network "$NET" \
    -e DATABASE_URL="$DBURL" -e REDIS_URL="redis://${RD}:6379" \
    -e JWT_SECRET="image-selftest-secret-that-is-long-enough" \
    -e PUBLIC_URL="http://127.0.0.1:8080" \
    -e APP_HOST=0.0.0.0 -e APP_PORT=3000 \
    "$BACKEND_IMG" >/dev/null 2>&1

# Wait on the image's OWN healthcheck, which is the thing compose's
# `condition: service_healthy` waits on for the frontend. That makes this both
# the wait and a case.
health=""
for _ in $(seq 1 90); do
    state="$(docker inspect --format '{{.State.Health.Status}}' "$BE" 2>/dev/null)"
    [[ "$state" == "healthy" ]] && { health=1; break; }
    [[ "$state" == "unhealthy" ]] && break
    sleep 1
done
if [[ -n "$health" ]]; then
    ok "the image's own HEALTHCHECK reaches healthy, which is what compose gates the frontend on"
else
    bad "the backend container never became healthy (state='${state:-none}'):
$(docker logs "$BE" 2>&1 | tail -20 | sed 's/^/      /')"
fi

# `timeout` wraps every probe from here on, and the reason is the finding this
# section exists for: /health used to answer nothing at all when Redis was gone,
# so a probe with no clock does not fail, it stops.
probe() { timeout 20 docker exec "$BE" $PROBE_CMD 2>/dev/null; }

if [[ -n "$PROBE_CMD" ]]; then
    REPLY_BODY="$(probe)"
    if grep -qF "$PROBE_GREP" <<<"$REPLY_BODY"; then
        ok "and the installer's exact probe gets a reply containing ${PROBE_GREP}"
    else
        bad "the probe's reply does not contain ${PROBE_GREP}; the install would warn for 60s on a healthy panel:
      [${REPLY_BODY}]"
    fi
fi

# ═════════════════════════════════════════════════════════════════════════════
#  Six routes, with Redis and without it
# ═════════════════════════════════════════════════════════════════════════════
#
# /health was the one that got measured on 2026-08-27, and the fix was made for
# the whole application: the client no longer queues commands that can never
# fail. But "the panel answers" was checked on one route, and the routes reach
# Redis in different places — the rate limiter's Lua eval and the security
# gate's blacklist read run ahead of everything, the login lockout counters run
# inside the handler, /sub has its own per-IP counter, and the honeypot writes.
#
# So the same question is asked of each, twice: with Redis up, because "it
# answered 500" means nothing unless the route answers something else when the
# dependency is there; and with Redis down, where the property that matters is
# not the status but that there IS one. A request that hangs is the defect this
# section exists for, and it is invisible to any check that only reads a status.
#
# The probe runs `node` inside the backend image — it is the same runtime the
# server is, it reports the status rather than a wget exit code, and it is
# bounded from outside as well.
note "the routes, with Redis up"

# probe_route <method> <path> [json-body] -> "<status>" | "ERR ..." | "TIMEOUT"
probe_route() {
    local method="$1" path="$2" body="${3:-}"
    local js="const o={method:'${method}'};"
    if [[ -n "$body" ]]; then
        js+="o.headers={'content-type':'application/json'};o.body=${body};"
    fi
    js+="fetch('http://127.0.0.1:3000${path}',o).then(r=>console.log(r.status)).catch(e=>console.log('ERR '+e.message));"
    timeout 25 docker exec "$BE" node -e "$js" 2>/dev/null || echo TIMEOUT
}

BAD_LOGIN="JSON.stringify({username:'no-such-admin',password:'no-such-password'})"

# path | method | body | status with Redis | status without | what it touches
ROUTES=(
    "/health|GET||200|503|pingRedis, after both onRequest hooks"
    "/api/auth/status|GET||200|200|nothing of its own: the two hooks and no more"
    "/api/auth/login|POST|${BAD_LOGIN}|401|500|the login lockout counters"
    "/api/users|GET||401|401|the hooks, ahead of the auth check"
    "/sub/no-such-token|GET||404|404|its own per-IP counter (SET NX + INCR)"
    "/wp-admin/|GET||404|404|the honeypot blacklist WRITE"
)

up_fail=""
for row in "${ROUTES[@]}"; do
    IFS='|' read -r rpath rmethod rbody rup _rdown _why <<<"$row"
    got="$(probe_route "$rmethod" "$rpath" "$rbody")"
    [[ "$got" == "$rup" ]] || up_fail="${up_fail}
        ${rmethod} ${rpath}: got ${got}, want ${rup}"
done
if [[ -z "$up_fail" ]]; then
    ok "all ${#ROUTES[@]} routes answer what they should while Redis is up"
else
    bad "with Redis UP these already disagree, so the down cases below mean nothing:${up_fail}"
fi

note "the same six with Redis stopped"
docker stop "$RD" >/dev/null 2>&1
sleep 2

hung=""
wrong=""
slowest=0
slowest_route=""
timings=""
for row in "${ROUTES[@]}"; do
    IFS='|' read -r rpath rmethod rbody _rup rdown why <<<"$row"
    t0="$(date +%s%N)"
    got="$(probe_route "$rmethod" "$rpath" "$rbody")"
    took_ms="$(( ($(date +%s%N) - t0) / 1000000 ))"
    took="$(( took_ms / 1000 ))"
    timings="${timings}
        ${rmethod} ${rpath} -> ${got} in ${took_ms}ms"
    if [[ "$took_ms" -gt "$slowest" ]]; then slowest="$took_ms"; slowest_route="${rmethod} ${rpath}"; fi
    case "$got" in
        TIMEOUT|ERR*) hung="${hung}
        ${rmethod} ${rpath} (${why}): ${got} after ${took}s" ;;
        "$rdown") ;;
        *) wrong="${wrong}
        ${rmethod} ${rpath} (${why}): ${got} in ${took}s, want ${rdown}" ;;
    esac
done
# The property this whole section is for. A hang is not a slow answer: before
# the fix these requests never returned at all, and nothing was logged.
if [[ -z "$hung" ]]; then
    ok "every one of them still ANSWERS with Redis gone (slowest ${slowest_route}, ${slowest}ms):${timings}"
else
    bad "these did not answer at all — the request is waiting on a Redis command that cannot fail:${hung}"
fi
if [[ -z "$wrong" ]]; then
    ok "and each answers what a panel with no Redis should answer"
else
    bad "the status with Redis down is not the intended one:${wrong}"
fi
# And answers PROMPTLY. `commandTimeout` bounds each command independently, so
# a route that touches Redis N times used to pay N timeouts in a row: with a 2s
# timeout, /sub answered in 13.5 seconds — correct, and long after any client
# had given up. The offline queue is turned off once the client has been ready
# (lib/redis.ts), which makes "not writable" an immediate answer; this is the
# number that says so. The bound is loose on purpose: it is here to catch
# timeouts stacking again, not to measure a container's mood.
if [[ "$slowest" -lt 3000 ]]; then
    ok "and answers promptly rather than paying one timeout per Redis call"
else
    bad "the slowest was ${slowest_route} at ${slowest}ms: this is what N sequential command timeouts looks like"
fi

# ───── The /health probe the installer runs, with Redis gone ─────
#
# The route matrix above says every route answers. This says what the
# installer's own probe makes of it, because that is the reply step 9 reads.
DOWN_START="$(date +%s)"
REPLY_DOWN="$(probe)"
DOWN_TOOK="$(( $(date +%s) - DOWN_START ))"
if [[ "$DOWN_TOOK" -lt 15 ]]; then
    ok "with Redis stopped the panel still answers, in ${DOWN_TOOK}s"
else
    bad "with Redis stopped the panel took ${DOWN_TOOK}s to answer, or did not: every request is waiting on a command that cannot fail"
fi
if ! grep -qF "$PROBE_GREP" <<<"$REPLY_DOWN"; then
    ok "and does not report ${PROBE_GREP} while a dependency is down"
else
    bad "the probe still reported ${PROBE_GREP} with Redis stopped: it is not asking about anything"
fi

# And comes back on its own, without anyone restarting the panel.
docker start "$RD" >/dev/null 2>&1
recovered=""
for _ in $(seq 1 20); do
    sleep 2
    grep -qF "$PROBE_GREP" <<<"$(probe)" && { recovered=1; break; }
done
if [[ -n "$recovered" ]]; then
    ok "and returns to ${PROBE_GREP} when Redis comes back, with no restart"
else
    bad "the panel never recovered after Redis returned; a Redis blip needs a human"
fi

# ═════════════════════════════════════════════════════════════════════════════
#  Who publishes a port
# ═════════════════════════════════════════════════════════════════════════════
#
# A docker-published port is DNAT'd in nat/PREROUTING, before ufw's filter
# chains ever run: `ufw deny 8080/tcp` on a published port does nothing, and
# that was measured on a VM rather than argued. So the set of services that
# publish anything is a security decision, and today it has exactly one member.
note "published ports in docker-compose.prod.yml"
# Only the `services:` block. A top-level `volumes:` key has children at the
# same indent, and counting those as services would have made the control below
# pass on a file where the service list had been parsed away entirely.
COMPOSE_SERVICES="$(awk '
    /^services:/ { in_svc=1; next }
    /^[a-z]/     { in_svc=0 }
    in_svc && /^  [a-z][a-z0-9_-]*:$/ { svc=$1; sub(":","",svc); print svc }
' "$COMPOSE")"
PUBLISHERS="$(awk '
    /^services:/ { in_svc=1 }
    /^[a-z]/ && !/^services:/ { in_svc=0 }
    in_svc && /^  [a-z][a-z0-9_-]*:$/ { svc=$1; sub(":","",svc) }
    in_svc && /^    ports:/           { inports=1; next }
    in_svc && /^    [a-z]/            { inports=0 }
    inports && /^      *- / { print svc }
' "$COMPOSE" | sort -u)"
SERVICES="$(printf '%s\n' "$COMPOSE_SERVICES" | grep -c .)"
if [[ "$SERVICES" -ge 4 ]] && grep -qx 'postgres' <<<"$COMPOSE_SERVICES" \
   && grep -qx 'redis' <<<"$COMPOSE_SERVICES"; then
    ok "read ${SERVICES} services out of the prod compose ($(printf '%s ' $COMPOSE_SERVICES))"
else
    bad "the services parsed out of ${COMPOSE} are not a set this can judge: $(printf '%s ' $COMPOSE_SERVICES)"
fi
if [[ "$PUBLISHERS" == "frontend" ]]; then
    ok "and only the frontend publishes a port to the host"
else
    bad "these services publish ports to the host: ${PUBLISHERS:-none}. Postgres and Redis reachable from outside is not something ufw can undo"
fi
# And the one that does publish must bind loopback unless told otherwise.
if grep -qE '^\s+- "\$\{FRONTEND_BIND:-127\.0\.0\.1\}:' "$COMPOSE"; then
    ok "and it binds 127.0.0.1 unless FRONTEND_BIND says otherwise"
else
    bad "the frontend's port mapping does not default to loopback:
$(grep -A1 '^    ports:' "$COMPOSE" | sed 's/^/      /')"
fi

# ═════════════════════════════════════════════════════════════════════════════
#  The frontend image
# ═════════════════════════════════════════════════════════════════════════════
note "the frontend image"
feq() { docker run --rm --entrypoint sh "$FRONTEND_IMG" -c "$1" 2>/dev/null; }
if [[ -n "$(feq 'ls /usr/share/nginx/html/index.html 2>/dev/null')" ]]; then
    ok "the built SPA is at the root nginx serves"
else
    bad "no index.html under /usr/share/nginx/html; nginx would serve its own welcome page"
fi
if [[ -z "$(feq 'find / -name ".env*" -not -path "/proc/*" -not -path "*/node_modules/*" 2>/dev/null')" ]]; then
    ok "and no env file rode along into it"
else
    bad "the frontend image carries env files:
$(feq 'find / -name ".env*" -not -path "/proc/*" -not -path "*/node_modules/*" 2>/dev/null' | sed 's/^/      /')"
fi
# ───── Which public paths actually reach the backend ─────
#
# This used to grep the config file for `location /api`, and that check could
# not have failed on any of the three paths it turned out to be missing. A
# `location` is not routing: nginx picks by prefix, by regex, and by modifier,
# and the SPA fallback at the bottom answers EVERY unmatched path with
# index.html and HTTP 200. So a public backend path nobody wrote a location for
# does not 404 — it hands a subscriber's client, a node, or the storefront a
# page of HTML while saying OK.
#
# So the container is started and asked. The upstream is a marker that echoes
# the path it was given, because the question is "did this request leave the
# frontend", and a real backend's 401 is a worse answer to it than a string
# that says BACKEND.
note "the frontend image's routing, asked of a running container"
MARKER_CONF="$(mktemp)"
cat > "$MARKER_CONF" <<'MARKEREOF'
server {
    listen 3000 default_server;
    location / { default_type text/plain; return 200 "IMGTEST-BACKEND $request_uri\n"; }
}
MARKEREOF
docker run -d --name "$MB" --network "$NET" --network-alias backend \
    -v "$MARKER_CONF":/etc/nginx/conf.d/default.conf:ro nginx:1.27-alpine >/dev/null 2>&1
# Non-default prefixes on purpose. The defaults would pass on a config that
# hardcodes `/sub` and `rw`, which is the config this replaced: an operator who
# sets SUBSCRIPTION_PATH_PREFIX to mask the panel's signature, or moves the
# facade off `rw`, gets the SPA on every subscription and every storefront call.
docker run -d --name "$FE" --network "$NET" -p "127.0.0.1:${FE_PORT}:80" \
    -e ICESLAB_SUB_PREFIX=/v -e ICESLAB_COMPAT_PREFIX=shop \
    "$FRONTEND_IMG" >/dev/null 2>&1
fe_up=""
for _ in $(seq 1 40); do
    curl -sf -o /dev/null "http://127.0.0.1:${FE_PORT}/" && { fe_up=1; break; }
    sleep 0.5
done
if [[ -n "$fe_up" ]]; then
    ok "the frontend container starts and serves the SPA on :80"
else
    bad "the frontend container never answered on 127.0.0.1:${FE_PORT}; the routing cases below cannot mean anything"
fi

fetch() { curl -s --max-time 10 "http://127.0.0.1:${FE_PORT}$1"; }
# The control for every case in this block: an unrouted path must reach the SPA,
# not the marker. Without it a frontend that forwarded EVERYTHING would pass the
# whole list below while breaking client-side routing.
if [[ "$(fetch /users)" == *"IMGTEST-BACKEND"* ]]; then
    bad "an SPA route (/users) is being proxied to the backend; the fallback is what makes client-side routing work"
else
    ok "and an SPA route still falls back to index.html, so 'reaches the backend' below means something"
fi

proxied=""
unproxied=""
# Every path the backend answers on that a browser, a subscriber's client, a
# node or the storefront asks for through this origin. `/v` and `/shop` are the
# non-default prefixes this container was started with.
for path in /api/auth/status /health /admin/queues /v/sometoken \
            /geo/sometoken/geosite.dat /shop/api/sub/sometoken /shop/api/users; do
    if [[ "$(fetch "$path")" == *"IMGTEST-BACKEND"* ]]; then
        proxied="${proxied} ${path}"
    else
        unproxied="${unproxied} ${path}"
    fi
done
if [[ -z "$unproxied" ]]; then
    ok "every public backend path reaches the backend:${proxied}"
else
    bad "these public backend paths are answered by the SPA fallback (HTTP 200, HTML) instead of the backend:${unproxied}"
fi

# ───── The response headers, on the document they are for ─────
#
# nginx does not merge `add_header`: a location that declares one of its own
# drops every header inherited from the server block. Three locations here
# declare their own, so the set is included from one snippet — and this asks
# the running container whether that worked, on the paths that matter. The
# report-only CSP was, before this, sent on the API's JSON and on no HTML at
# all, which is a policy that can only ever report that everything is fine.
hdr_missing=""
for path in / /index.html /users; do
    h="$(curl -s --max-time 10 -D - -o /dev/null "http://127.0.0.1:${FE_PORT}${path}")"
    for header in Content-Security-Policy-Report-Only X-Frame-Options X-Content-Type-Options Referrer-Policy; do
        grep -qi "^${header}:" <<<"$h" || hdr_missing="${hdr_missing} ${path}:${header}"
    done
done
if [[ -z "$hdr_missing" ]]; then
    ok "and every security header, CSP included, ships on / and on the SPA routes that rewrite to index.html"
else
    bad "headers missing from the document they apply to:${hdr_missing}"
fi
rm -f "$MARKER_CONF"

printf '\n'
if [[ "$FAIL" -eq 0 ]]; then
    printf '\033[1;32m%d/%d ok\033[0m\n' "$PASS" "$((PASS + FAIL))"
    exit 0
fi
printf '\033[1;31m%d failed\033[0m of %d\n' "$FAIL" "$((PASS + FAIL))"
exit 1
