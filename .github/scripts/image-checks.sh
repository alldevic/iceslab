#!/usr/bin/env bash
# Checks on the BUILT backend image (what ships), not on the source tree.
#
#   image-checks.sh content|cores|singbox|meta|migrate|boot|wait|health|no-redis|all
#   image-checks.sh local        # throwaway Postgres + Redis, then `all`
#
# CI (the `smoke` job) calls the subcommands one step each; the same script runs
# on a developer machine (`local`), because the checks must not exist only in a
# workflow that may not be running. No `| head` / `| grep -q` anywhere: the
# answer goes into a variable first (E33, TestNoWorkflowPipesIntoAnEarlyReader).
#
# Environment (defaults are the CI values):
#   IMAGE            image under test                    iceslab-backend:smoke
#   CORE_ARCHES      arches the image was built to carry     amd64 arm64
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
CORE_ARCHES="${CORE_ARCHES:-amd64 arm64}"
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
             /app/package.json /app/pnpm-workspace.yaml /app/cores; do
      [ -e "$p" ] || echo "missing, must be there: $p"
    done
  ')
  if [[ -n "$report" ]]; then
    echo "$report" >&2
    fail "image content is wrong (see the list above)"
  fi
  ok "image content: no sources, tests, scripts, .env*, .git; runtime files present"
}

# ── cores: the artifacts the panel hands to nodes are all there, and are what the manifest says
check_cores() {
  local report
  # Runs the image's own node on its own compiled manifest (the same function
  # the build and the routes use), as the image's default user: the files have
  # to be readable by it. One line per violation.
  report=$(docker run --rm --entrypoint node -e CORE_ARCHES="$CORE_ARCHES" "$IMAGE" --input-type=module -e '
    import { createHash } from "node:crypto";
    import { readFileSync, readdirSync } from "node:fs";
    const m = await import("/app/packages/shared/src/core-versions.js");
    const dir = process.env.CORES_DIR ?? "/app/cores";
    const arches = process.env.CORE_ARCHES.split(/\s+/).filter(Boolean);
    const want = [
      ...m.coreArtifacts(arches).map((a) => [a.stored, a.sha256]),
      ...m.CORE_SCRIPT_NAMES.map((n) => [m.coreScriptName(n, m.CORE_SCRIPTS[n]), m.CORE_SCRIPTS[n].sha256]),
    ];
    if (want.length < 5) console.log("manifest lists suspiciously few artifacts: " + want.length);
    for (const [name, sha] of want) {
      let got;
      try { got = createHash("sha256").update(readFileSync(`${dir}/${name}`)).digest("hex"); }
      catch (e) { console.log(`missing or unreadable: ${name} (${e.code})`); continue; }
      if (got !== sha) console.log(`sha256 differs: ${name}: ${got} != ${sha}`);
    }
    const known = new Set(want.map(([n]) => n));
    for (const f of readdirSync(dir)) if (!known.has(f)) console.log(`not in the manifest for these arches: ${f}`);
  ')
  if [[ -n "$report" ]]; then
    echo "$report" >&2
    fail "image cores are wrong (see the list above)"
  fi
  ok "image cores: every artifact of CORE_ARCHES ($CORE_ARCHES) is in /app/cores with the manifest's sha256, nothing else"
}

# ── cores, second half: each artifact is the architecture its name says ──────
# The sha256 above proves a file is the one the manifest names; it cannot prove
# the manifest filed it under the right architecture, and an arm64 binary under
# an amd64 name sits there until a node runs it. So the binary is taken out of
# its archive (.zip, .tar.gz, .deb; hysteria's is bare) and its ELF header read:
# e_machine (2 bytes at offset 18) is 62 for x86-64, 183 for aarch64, 40 for
# ARM. Done on the runner, with the files copied out of the image: the alpine
# image has no dpkg-deb. sing-box of the IMAGE's own architecture is also run
# (when this machine can), because the manifest's sing-box is our build and
# `version` must list with_v2ray_api, the tag the per-user counters need.
check_core_arches() {
  local work ctr list image_arch host_arch report="" stored component arch file want got bin x ex
  for ex in tar dpkg-deb od; do command -v "$ex" >/dev/null || fail "cores arch check: $ex is not on this machine"; done
  command -v unzip >/dev/null || command -v python3 >/dev/null || fail "cores arch check: neither unzip nor python3 is on this machine"
  work=$(mktemp -d)
  ctr=$(docker create "$IMAGE")
  # shellcheck disable=SC2064
  trap "docker rm -f '$ctr' >/dev/null 2>&1 || true; rm -rf '$work'; trap - RETURN" RETURN
  docker cp "$ctr:/app/cores" "$work/cores" >/dev/null
  # One line per artifact the image should carry: stored name, component, arch, upstream file.
  list=$(docker run --rm --entrypoint node -e CORE_ARCHES="$CORE_ARCHES" "$IMAGE" --input-type=module -e '
    const m = await import("/app/packages/shared/src/core-versions.js");
    for (const a of m.coreArtifacts(process.env.CORE_ARCHES.split(/\s+/).filter(Boolean)))
      console.log([a.stored, a.component, a.arch, a.file].join("\t"));
  ')
  image_arch=$(docker image inspect --format '{{.Architecture}}' "$IMAGE")
  case "$(uname -m)" in x86_64) host_arch=amd64 ;; aarch64) host_arch=arm64 ;; *) host_arch="" ;; esac
  local n=0 mpp_sha="" list_in
  while IFS=$'\t' read -r stored component arch file; do
    [[ -n "$stored" ]] || continue
    case "$component" in
      xray) bin=xray ;; singbox) bin=sing-box ;; mtg) bin=mtg ;; mita) bin=mita ;; hysteria) bin="" ;;
      mtprotoproxy)
        # Python source, one archive for every arch: no ELF inside, and no
        # arch to check. What is checked instead is the thing the arch check
        # cannot say: it is a tarball with the script the agent runs, and it
        # is the same file under every arch (the manifest says so with
        # `sourceArchive`; a different one under one arch is a wrong entry).
        list_in=$(tar -tzf "$work/cores/$stored" 2>&1) || { report+="$stored: not a readable tar.gz"$'\n'; continue; }
        case $'\n'"$list_in"$'\n' in
          *"/mtprotoproxy.py"$'\n'*) ;;
          *) report+="$stored: no mtprotoproxy.py inside"$'\n' ;;
        esac
        got=$(sha256sum "$work/cores/$stored"); got="${got%% *}"
        if [[ -z "$mpp_sha" ]]; then mpp_sha="$got"; else
          [[ "$got" == "$mpp_sha" ]] || report+="$stored: not the same archive as the other arches of mtprotoproxy"$'\n'
        fi
        continue ;;
      *) continue ;;   # not an executable the node runs from an archive
    esac
    case "$arch" in amd64) want=3e00 ;; arm64) want=b700 ;; armv7) want=2800 ;; *) report+="$stored: no ELF machine known for arch $arch"$'\n'; continue ;; esac
    x="$work/x/$stored"; mkdir -p "$x"
    case "$file" in
      *.zip) if command -v unzip >/dev/null; then unzip -q -o "$work/cores/$stored" -d "$x"; else python3 -I -m zipfile -e "$work/cores/$stored" "$x"; fi ;;
      *.tar.gz|*.tgz) tar -xzf "$work/cores/$stored" -C "$x" ;;
      *.deb) dpkg-deb -x "$work/cores/$stored" "$x" ;;
      *) cp "$work/cores/$stored" "$x/$file"; bin="$file" ;;
    esac || { report+="$stored: cannot be unpacked"$'\n'; continue; }
    bin=$(find "$x" -type f -name "${bin:-$file}" | sed -n 1p)
    if [[ -z "$bin" ]]; then report+="$stored: no ${component} binary inside"$'\n'; continue; fi
    got=$(od -An -tx1 -j18 -N2 "$bin" | tr -d ' \n')
    if [[ "$(od -An -tx1 -N4 "$bin" | tr -d ' \n')" != 7f454c46 ]]; then report+="$stored: the binary is not an ELF file"$'\n'; continue; fi
    [[ "$got" == "$want" ]] || report+="$stored: filed under $arch, but its e_machine is 0x${got:2:2}${got:0:2} (want 0x${want:2:2}${want:0:2})"$'\n'
    n=$((n + 1))
    if [[ "$component" == singbox && "$arch" == "$image_arch" && "$arch" == "$host_arch" ]]; then
      chmod +x "$bin"
      # Into a variable, not `| grep -q`: grep leaving early SIGPIPEs the writer under pipefail.
      ex=$("$bin" version 2>&1 || true)
      [[ "$ex" == *with_v2ray_api* ]] || report+="$stored: sing-box version does not list with_v2ray_api"$'\n'
    fi
  done <<<"$list"
  [[ "$n" -ge 5 ]] || report+="only $n executables were checked, the manifest should give more"$'\n'
  if [[ -n "$report" ]]; then
    printf '%s' "$report" >&2
    fail "image cores have the wrong architecture inside (see the list above)"
  fi
  ok "image cores: $n executables, each the ELF machine its architecture says; sing-box has with_v2ray_api (run only when the image's arch is this machine's: image $image_arch, here ${host_arch:-?})"
}

# ── the panel's own sing-box (milestone 10.5) ───────────────────────────────
# SINGBOX_BIN is set, names an executable the default user may run, `version`
# answers (alpine's musl: the Go build must not need a libc it lacks), and it
# compiles a rule-set source into a non-empty `.srs`, which is what the panel
# serves sing-box clients from /geo/.
check_singbox() {
  local out
  out=$(docker run --rm --entrypoint sh "$IMAGE" -c '
    set -e
    [ -n "${SINGBOX_BIN:-}" ] || { echo "SINGBOX_BIN is not set in the image"; exit 1; }
    [ -x "$SINGBOX_BIN" ] || { echo "SINGBOX_BIN=$SINGBOX_BIN is not an executable file"; exit 1; }
    "$SINGBOX_BIN" version | head -n 1
    d=$(mktemp -d)
    printf "%s" "{\"version\":2,\"rules\":[{\"domain_suffix\":[\".example.com\"]}]}" > "$d/r.json"
    "$SINGBOX_BIN" rule-set compile -o "$d/r.srs" "$d/r.json"
    [ -s "$d/r.srs" ] || { echo "rule-set compile wrote no file"; exit 1; }
    echo compiled
  ' 2>&1) || fail "the image's sing-box does not work: $out"
  [[ "$out" == sing-box\ version\ * && "$out" == *compiled ]] || fail "the image's sing-box answered oddly: $out"
  ok "image sing-box: SINGBOX_BIN is executable, answers \`version\` and compiles a rule-set (${out%%$'\n'*})"
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
  check_cores
  check_core_arches
  check_singbox
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
  cores) check_cores; check_core_arches ;;
  singbox) check_singbox ;;
  meta) check_meta ;;
  migrate) check_migrate ;;
  boot) do_boot ;;
  wait) wait_health ;;
  health) check_health ;;
  no-redis) check_no_redis ;;
  all) all ;;
  local) run_local ;;
  *) echo "usage: $0 content|cores|singbox|meta|migrate|boot|wait|health|no-redis|all|local" >&2; exit 2 ;;
esac
