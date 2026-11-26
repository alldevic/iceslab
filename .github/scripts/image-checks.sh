#!/usr/bin/env bash
# Checks on the BUILT backend image (what ships), not on the source tree.
#
#   image-checks.sh content|meta|migrate|boot|wait|health|no-redis|all
#   image-checks.sh local        # throwaway Postgres + Redis, then `all`
#
# CI (the `smoke` job) calls the subcommands one step each; the same script runs
# on a developer machine (`local`), because the checks must not exist only in a
# workflow that may not be running. No `| head` / `| grep -q` anywhere: the
# answer goes into a variable first (E33, TestNoWorkflowPipesIntoAnEarlyReader).
#
# Environment (defaults are the CI values):
#   IMAGE            image under test                    iceslab-backend:smoke
#   DATABASE_URL     Postgres the image migrates/boots on
#   REDIS_URL        Redis the image boots on
#   DOCKER_NETWORK   --network of the containers started here        host
#   PUBLISH          -p mapping for the booted container (not host network)
#   HEALTH_URL       where the host reaches /health      http://127.0.0.1:3000/health
#   SMOKE_NAME       name of the booted container                    smoke
#   REDIS_CONTAINER  container to stop/start for `no-redis` (CI: found by image)
set -euo pipefail

IMAGE="${IMAGE:-iceslab-backend:smoke}"
DATABASE_URL="${DATABASE_URL:-postgres://ice:ice@172.17.0.1:5432/iceslab_smoke}"
REDIS_URL="${REDIS_URL:-redis://172.17.0.1:6379/0}"
DOCKER_NETWORK="${DOCKER_NETWORK:-host}"
PUBLISH="${PUBLISH:-}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/health}"
SMOKE_NAME="${SMOKE_NAME:-smoke}"
REDIS_CONTAINER="${REDIS_CONTAINER:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP=/app/apps/panel-backend

STOPPED_REDIS=""
trap '[[ -z "$STOPPED_REDIS" ]] || docker start "$STOPPED_REDIS" >/dev/null 2>&1 || true' EXIT

fail() { echo "::error::$*" >&2; exit 1; }
ok() { echo "ok: $*"; }

# ── content: the image carries the program and nothing else ─────────────────
check_content() {
  local report
  # Runs inside the image. One `fail` line per violation, so a red run names
  # every offender at once instead of the first.
  report=$(docker run --rm --entrypoint sh "$IMAGE" -c '
    app=/app/apps/panel-backend
    shared=/app/packages/shared
    for p in "$app/src" "$app/tests" "$app/scripts" "$app/Dockerfile" \
             "$app/vitest.config.ts" "$app/tsconfig.json" "$app/tsconfig.scripts.json" \
             "$app/eslint.config.js" /app/.git "$shared/testdata"; do
      [ ! -e "$p" ] || echo "present, must not be: $p"
    done
    found=$(find /app -name node_modules -prune -o \( -name "*.test.ts" -o -name "*.test.js" \
      -o -name "vitest.config.*" -o -name ".env*" -o -name ".git" \) -print)
    for p in $found; do echo "present, must not be: $p"; done
    for p in "$shared/src/index.ts" "$shared/src/index.js" "$shared/src/recipes.snapshot.json" \
             "$shared/recipe.schema.json" "$shared/package.json" \
             "$app/prisma" "$app/prisma.config.ts" "$app/package.json" "$app/dist/index.js" \
             /app/package.json /app/pnpm-workspace.yaml; do
      [ -e "$p" ] || echo "missing, must be there: $p"
    done
  ')
  if [[ -n "$report" ]]; then
    echo "$report" >&2
    fail "image content is wrong (see the list above)"
  fi
  ok "image content: no sources, tests, scripts, .env*, .git; runtime files present"
}

# ── meta: user and start command ────────────────────────────────────────────
check_meta() {
  local user uid cmd last
  user=$(docker inspect --format '{{.Config.User}}' "$IMAGE")
  [[ -n "$user" && "$user" != "root" && "$user" != "0" ]] || fail "image runs as '${user:-root}' by default"
  uid=$(docker run --rm --entrypoint id "$IMAGE" -u)
  [[ "$uid" != "0" ]] || fail "default user '$user' resolves to uid 0"
  # The last word of CMD is the entry file (`node --flags dist/index.js`).
  last=""
  while IFS= read -r cmd; do [[ -z "$cmd" ]] || last="$cmd"; done < <(docker inspect --format '{{range .Config.Cmd}}{{println .}}{{end}}' "$IMAGE")
  [[ -n "$last" ]] || fail "image has no CMD"
  docker run --rm --entrypoint sh "$IMAGE" -c 'test -f "$1"' _ "$last" \
    || fail "CMD names '$last', which does not exist relative to the image workdir"
  ok "default user $user (uid $uid); CMD file '$last' exists"
}

# ── migrate: from the image, on an empty DB, then again ─────────────────────
migrate() {
  docker run --rm --network "$DOCKER_NETWORK" -e DATABASE_URL="$DATABASE_URL" \
    --entrypoint sh "$IMAGE" -c "cd $APP && pnpm exec prisma migrate deploy" 2>&1
}
check_migrate() {
  local first second
  # Migrations run from the image too: a migration that only applies from a
  # developer checkout is not a migration that ships.
  first=$(migrate) || { echo "$first" >&2; fail "first migrate deploy failed"; }
  echo "$first"
  second=$(migrate) || { echo "$second" >&2; fail "second migrate deploy failed"; }
  echo "$second"
  [[ "$second" == *"No pending migrations to apply"* ]] \
    || fail "second migrate deploy did not report 'No pending migrations to apply'"
  ok "migrate deploy applied, and a second run had nothing to apply"
}

# ── boot ────────────────────────────────────────────────────────────────────
do_boot() {
  local args=(-d --name "$SMOKE_NAME" --network "$DOCKER_NETWORK")
  if [[ "$DOCKER_NETWORK" != "host" && -n "$PUBLISH" ]]; then args+=(-p "$PUBLISH"); fi
  docker run "${args[@]}" \
    -e DATABASE_URL="$DATABASE_URL" -e REDIS_URL="$REDIS_URL" \
    -e JWT_SECRET='ci-smoke-secret-must-be-at-least-32-chars' \
    -e PUBLIC_URL='https://panel.smoke.test' -e NODE_ENV=production \
    "$IMAGE" >/dev/null
}

wait_health() {
  local i
  for i in $(seq 1 30); do
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
      echo "panel answered after ${i}s"
      [[ -z "${GITHUB_OUTPUT:-}" ]] || echo "seconds=${i}" >> "$GITHUB_OUTPUT"
      return 0
    fi
    sleep 1
  done
  docker logs "$SMOKE_NAME" || true
  fail "panel never answered on /health"
}

# ── health: the installer's probe tool exists, HEALTHCHECK reaches healthy ──
check_health() {
  local tool="" line prev="" out status budget hc i
  # The installer probes with `docker compose exec -T backend <tool> ...`; the
  # tool is the first word of the line after `exec -T backend \`.
  while IFS= read -r line; do
    if [[ "$prev" == *"exec -T backend"* ]]; then
      line="${line#"${line%%[![:space:]]*}"}"
      tool="${line%% *}"
      break
    fi
    prev="$line"
  done < "$ROOT/scripts/install-iceslab.sh"
  [[ -n "$tool" ]] || fail "could not read the health probe tool from scripts/install-iceslab.sh"
  docker run --rm --entrypoint sh "$IMAGE" -c 'command -v "$1" >/dev/null' _ "$tool" \
    || fail "the installer probes health with '$tool', which the image does not have"

  # The wait is derived from HEALTHCHECK itself: the first probe fires one
  # interval after start, the longest a probe may take is the timeout, plus a
  # start-period of grace, plus slack.
  hc=$(docker inspect --format '{{json .Config.Healthcheck}}' "$IMAGE")
  budget=$(jq -r '((.StartPeriod + .Interval + .Timeout) / 1000000000 | ceil) + 15' <<<"$hc")
  [[ "$budget" =~ ^[0-9]+$ ]] || fail "image has no HEALTHCHECK ($hc)"
  status=""
  for i in $(seq 1 "$budget"); do
    status=$(docker inspect --format '{{.State.Health.Status}}' "$SMOKE_NAME")
    [[ "$status" != "healthy" ]] || break
    sleep 1
  done
  [[ "$status" == "healthy" ]] || { docker logs "$SMOKE_NAME" || true; fail "container is '$status' after ${budget}s, not healthy"; }
  out=$(docker exec "$SMOKE_NAME" "$tool" -T 5 -qO- http://127.0.0.1:3000/health) \
    || fail "the installer's probe ($tool) failed inside the container"
  [[ "$out" == *'"status":"ok"'* ]] || fail "probe answered: $out"
  ok "'$tool' is in the image and answers; container healthy after ~${i}s (budget ${budget}s)"
}

# ── no-redis: degraded, alive, and back ─────────────────────────────────────
check_no_redis() {
  local rc="$REDIS_CONTAINER" code body i running
  if [[ -z "$rc" ]]; then rc=$(docker ps -q --filter ancestor=redis:7-alpine); fi
  [[ -n "$rc" && "$rc" != *$'\n'* ]] || fail "need exactly one Redis container to stop (set REDIS_CONTAINER)"
  STOPPED_REDIS="$rc" # restarted by the EXIT trap if a check below fails
  body=$(mktemp)
  docker stop "$rc" >/dev/null
  code=""
  for i in $(seq 1 40); do
    code=$(curl -s -o "$body" -w '%{http_code}' "$HEALTH_URL" || true)
    [[ "$code" != "503" ]] || break
    sleep 1
  done
  [[ "$code" == "503" ]] || { docker logs "$SMOKE_NAME" || true; fail "/health answered '$code' with Redis stopped, expected 503"; }
  [[ "$(cat "$body")" == *'"redis":"down"'* ]] || fail "503 body does not name Redis: $(cat "$body")"
  running=$(docker inspect --format '{{.State.Running}} {{.RestartCount}}' "$SMOKE_NAME")
  [[ "$running" == "true 0" ]] || fail "process did not survive Redis going away (running/restarts: $running)"

  docker start "$rc" >/dev/null
  STOPPED_REDIS=""
  code=""
  for i in $(seq 1 60); do
    code=$(curl -s -o "$body" -w '%{http_code}' "$HEALTH_URL" || true)
    [[ "$code" != "200" ]] || break
    sleep 1
  done
  [[ "$code" == "200" ]] || { docker logs "$SMOKE_NAME" || true; fail "/health did not return to 200 after Redis came back (last: '$code')"; }
  rm -f "$body"
  ok "Redis stopped: 503, redis down, process alive; Redis back: 200"
}

# ── local: throwaway Postgres and Redis, everything above ───────────────────
run_local() {
  local i
  p="${LOCAL_PREFIX:-iceslab-imgcheck-}" port="${LOCAL_PORT:-33000}"
  cleanup() { docker rm -f "${p}pg" "${p}redis" "$SMOKE_NAME" >/dev/null 2>&1 || true; docker network rm "${p}net" >/dev/null 2>&1 || true; }
  trap 'cleanup; [[ -z "$STOPPED_REDIS" ]] || docker start "$STOPPED_REDIS" >/dev/null 2>&1 || true' EXIT
  cleanup
  docker network create "${p}net" >/dev/null
  docker run -d --name "${p}pg" --network "${p}net" -e POSTGRES_USER=ice -e POSTGRES_PASSWORD=ice \
    -e POSTGRES_DB=iceslab_smoke postgres:16-alpine >/dev/null
  docker run -d --name "${p}redis" --network "${p}net" redis:7-alpine >/dev/null
  for i in $(seq 1 60); do
    docker exec "${p}pg" pg_isready -U ice -d iceslab_smoke >/dev/null 2>&1 && break
    sleep 1
  done
  export DOCKER_NETWORK="${p}net" SMOKE_NAME="${p}backend" REDIS_CONTAINER="${p}redis" \
    DATABASE_URL="postgres://ice:ice@${p}pg:5432/iceslab_smoke" REDIS_URL="redis://${p}redis:6379/0" \
    PUBLISH="127.0.0.1:${port}:3000" HEALTH_URL="http://127.0.0.1:${port}/health"
  all
}

all() {
  check_content
  check_meta
  check_migrate
  do_boot
  wait_health
  check_health
  check_no_redis
  echo "all image checks passed"
}

case "${1:-all}" in
  content) check_content ;;
  meta) check_meta ;;
  migrate) check_migrate ;;
  boot) do_boot ;;
  wait) wait_health ;;
  health) check_health ;;
  no-redis) check_no_redis ;;
  all) all ;;
  local) run_local ;;
  *) echo "usage: $0 content|meta|migrate|boot|wait|health|no-redis|all|local" >&2; exit 2 ;;
esac
