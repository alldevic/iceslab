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
    docker rm -f "$BE" "$PG" "$RD" >/dev/null 2>&1 || true
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
pg_ready=""
for _ in $(seq 1 60); do
    docker exec "$PG" pg_isready -U iceslab -d iceslab >/dev/null 2>&1 && { pg_ready=1; break; }
    sleep 1
done
psql_q() { docker exec "$PG" psql -U iceslab -d iceslab -tAc "$1" 2>/dev/null | tr -d '\r'; }

if [[ -n "$pg_ready" ]]; then
    ok "a throwaway postgres:16-alpine is accepting connections"
else
    bad "the throwaway postgres never came up; the migration cases cannot run"
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

# ───── The panel with its Redis taken away ─────
#
# Two things at once, and the second is why this is here at all.
#
# The probe must stop saying ok — without that, "it said ok" is also true of a
# probe that says ok to anything. And it must get an ANSWER: on 2026-08-27 it
# did not. The one Redis client was built with the options BullMQ requires
# (`maxRetriesPerRequest: null`), which queue a command issued on a down
# connection instead of rejecting it, so the awaits in the rate limiter and the
# security gate — both onRequest hooks, both ahead of every route — never
# settled. Postgres stopped gave a 503 in three seconds; Redis stopped gave no
# reply in sixty, with nothing logged. The installer's launch loop has no clock
# of its own, so the install stopped there rather than warning.
docker stop "$RD" >/dev/null 2>&1
sleep 2
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
# The nginx layer proxies /api, /sub and /health to the backend; a bundle that
# shipped without that config is a panel whose UI loads and whose every request
# 404s.
NGINX_CONF="$(feq 'cat /etc/nginx/conf.d/default.conf 2>/dev/null')"
missing_loc=""
for loc in /api /sub /health; do
    grep -qE "location [^{]*${loc}" <<<"$NGINX_CONF" || missing_loc="${missing_loc} ${loc}"
done
if [[ -n "$NGINX_CONF" && -z "$missing_loc" ]]; then
    ok "and its nginx config proxies /api, /sub and /health to the backend"
else
    bad "the frontend's nginx config is missing location(s):${missing_loc:- (config not readable)}"
fi

printf '\n'
if [[ "$FAIL" -eq 0 ]]; then
    printf '\033[1;32m%d/%d ok\033[0m\n' "$PASS" "$((PASS + FAIL))"
    exit 0
fi
printf '\033[1;31m%d failed\033[0m of %d\n' "$FAIL" "$((PASS + FAIL))"
exit 1
