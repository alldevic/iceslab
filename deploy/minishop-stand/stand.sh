#!/usr/bin/env bash
# Drive the Mini Shop (remnawave-minishop v3.8.6, unmodified) against either this
# panel's Remnawave-compat facade or a real Remnawave, for the differential test
# described in README.md next to this file.
#
# Everything lives here, nothing is written into the shop's checkout: the shop
# stays unmodified by design, so its compose files are referenced by absolute
# path and every override and env file is ours. Not run by CI.
#
# NEVER point this at a panel with real data: the stand creates users and writes
# to the panel's database (see README.md).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The shop version this stand is written for, and the Remnawave it certifies
# against (deploy/dev/remnawave-versions.lock.json of that tag).
SHOP_TAG="v3.8.6"
# The shop's checkout. No default: the stand is only meaningful against a known
# shop version, and guessing a path would run it against whatever is there.
SHOP="${MINISHOP_DIR:-}"
# The panel API token the shop uses (an icp_ token). Kept out of the tree.
TOKEN_FILE="${PANEL_TOKEN_FILE:-$HERE/.runtime/panel-token}"
PANEL_URL="${PANEL_URL:-http://127.0.0.1:3000}"
# Where the shop's backend is published on the host. Its container port stays
# 8080; this only moves the host side when 8080 is taken.
SHOP_PORT="${SHOP_PORT:-8080}"
SHOP_URL="${SHOP_URL:-http://127.0.0.1:8082}"
PREFIX="${REMNAWAVE_COMPAT_PREFIX:-rw}"
RUNTIME_ENV="$HERE/.runtime/iceslab.env"
RUNTIME_REF_ENV="$HERE/.runtime/remnawave-ref.env"
# The shop's compose is read with --project-directory pointed at ITS checkout,
# so every relative path in our override would resolve there. Absolute, via the
# environment, is the only way our files stay ours.
export STAND_DIR="$HERE"
# The panel repo, for building the panel's own frontend image, and the address
# that image must proxy to. `host.docker.internal` cannot be used: nginx's
# variable `proxy_pass` resolves through docker's embedded DNS and never reads
# /etc/hosts, so the alias would not resolve. The gateway's IP does not need
# resolving at all.
export PANEL_REPO="${PANEL_REPO:-$(cd "$HERE/../.." && pwd)}"
bridge_gateway_ip() {
  docker network inspect bridge \
    --format '{{ (index .IPAM.Config 0).Gateway }}' 2>/dev/null || echo 172.17.0.1
}

die() { echo "stand: $*" >&2; exit 1; }
# A run that never reached the code under test. Distinct from die() on purpose:
# "we did not wait long enough" must not read like "the shop did not call it".
refuse() { echo "stand: $*" >&2; exit 2; }

# The commands that need no shop checkout (and, but for mint-token, no panel).
offline() {
  case "${1:-}" in
    compare|mark|mint-token|'') return 0 ;;
    *) return 1 ;;
  esac
}

if ! offline "${1:-}"; then
  [[ -n "$SHOP" ]] || die "MINISHOP_DIR is not set: point it at a remnawave-minishop checkout
(git clone https://gitlab.com/3252a8/remnawave-minishop.git && git -C remnawave-minishop checkout $SHOP_TAG)"
  [[ -d "$SHOP" ]] || die "MINISHOP_DIR=$SHOP does not exist"
  [[ -f "$SHOP/docker-compose-dev.yml" ]] || die "$SHOP is not a minishop checkout (no docker-compose-dev.yml)"
  # The stand's files are written against one shop version. A checkout at
  # another one still starts, and then reports differences that belong to the
  # version gap.
  if [[ -z "${STAND_ANY_SHOP_VERSION:-}" ]]; then
    have_tag="$(git -C "$SHOP" describe --tags --exact-match 2>/dev/null || true)"
    [[ "$have_tag" == "$SHOP_TAG" ]] || die "$SHOP is at '${have_tag:-no tag}', the stand is written for $SHOP_TAG
(STAND_ANY_SHOP_VERSION=1 to run anyway)"
  fi
  # ...and the Remnawave the reference half runs has to be the one that tag
  # certifies, or the differential compares the facade to a version the shop
  # does not stand behind.
  lock_ver="$(sed -n 's/.*"remnawave_panel": *"\([^"]*\)".*/\1/p' "$SHOP/deploy/dev/remnawave-versions.lock.json" 2>/dev/null | head -1)"
  env_ver="$(sed -n 's/^REMNAWAVE_DEV_VERSION=//p' "$HERE/remnawave-ref.env" | tail -1)"
  [[ -n "$lock_ver" && "$lock_ver" == "$env_ver" ]] \
    || die "remnawave-ref.env pins Remnawave '$env_ver', the shop's lock file says '${lock_ver:-nothing}'"
  # The Dockerfile's version stamp comes in as build args; see stand.override.yml.
  MINISHOP_BUILD_COMMIT="$(git -C "$SHOP" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  export MINISHOP_BUILD_COMMIT
  export WEB_SERVER_PORT="$SHOP_PORT"
  export PANEL_BACKEND_ADDR="${PANEL_BACKEND_ADDR:-$(bridge_gateway_ip):3000}"
fi

# The two halves share container names, so they cannot run at the same time.
# Their shop DATABASES are different volumes (the reference half's names come
# from remnawave-ref.env, the iceslab half's are the base compose's own), which
# is what makes the two runs comparable instead of cumulative: but only one can
# be up.
# The project name is PINNED. Compose derives it from the project directory, so
# pointing MINISHOP_DIR at a different checkout would silently make a second
# project: `reset` would tear down an empty one while the running stand kept its
# containers, and the next `up` would collide on their names.
STAND_PROJECT="${STAND_PROJECT:-minishop-stand}"

compose_iceslab=(docker compose
  -p "$STAND_PROJECT"
  --project-directory "$SHOP"
  -f "$SHOP/docker-compose-dev.yml"
  -f "$HERE/stand.override.yml"
  -f "$HERE/data-volume.override.yml"
  --env-file "$RUNTIME_ENV")
compose_ref=(docker compose
  -p "$STAND_PROJECT"
  --project-directory "$SHOP"
  -f "$SHOP/docker-compose-dev.yml"
  -f "$SHOP/docker-compose.remnawave-dev.yml"
  -f "$HERE/data-volume.override.yml"
  --env-file "$RUNTIME_REF_ENV")

# newt is a tunnel client the stand has no use for; the env files carry
# placeholder credentials only so `docker compose config` can interpolate. Name
# the services explicitly rather than relying on that. plugin-store-init is not
# named: migrate depends on it and compose starts it with its dependents.
SHOP_SERVICES=(postgres redis migrate backend worker frontend)
# The panel's own frontend image, brought up alongside the shop so the shop
# reaches the facade the way a real deploy does: through nginx.
STAND_SERVICES=(panel-front)
# Every optional profile, for teardown: `down` has to cover what any `up` may
# have started, not what this particular invocation started.
STAND_PROFILES=(--profile seed)

# A stand's env, from the committed template: the .runtime copy is what compose
# reads. The template is committed and a credential must not be, and an env file
# rewritten in place shows up as a dirty tree after every run.
write_runtime_env() {
  local template="$1" target="$2" key="$3" apiurl="${4:-}"
  mkdir -p "$HERE/.runtime"
  sed -e "s|^PANEL_API_KEY=.*|PANEL_API_KEY=$key|" \
      -e "s|^APP_ENV_FILE=.*|APP_ENV_FILE=$target|" \
      -e "s|^WEB_SERVER_PORT=.*|WEB_SERVER_PORT=$SHOP_PORT|" \
      -e "s|^WEBHOOK_BASE_URL=.*|WEBHOOK_BASE_URL=http://127.0.0.1:$SHOP_PORT|" \
      ${apiurl:+-e "s|^PANEL_API_URL=.*|PANEL_API_URL=$apiurl|"} \
      "$template" > "$target"
  chmod 600 "$target"
}

# The iceslab half's env. With $1 = require the token must exist (`up-iceslab`);
# without it `down`/`reset` still need a file for `--env-file` and get an empty key.
fill_token() {
  local tok=""
  if [[ -f "$TOKEN_FILE" ]]; then
    tok="$(tr -d '[:space:]' < "$TOKEN_FILE")"
    [[ "$tok" == icp_* ]] || die "$TOKEN_FILE does not hold an icp_ token"
  elif [[ "${1:-}" == require ]]; then
    die "no panel API token at $TOKEN_FILE
Mint one (stand.sh mint-token, or by hand through POST $PANEL_URL/api/api-tokens with an admin JWT)."
  fi
  write_runtime_env "$HERE/iceslab.env" "$RUNTIME_ENV" "$tok" "http://panel-front/${PREFIX}/api"
}

# The reference half's env, with the panel token the shop's own dev fixture
# seeds, because the shop's reference override sets PANEL_API_KEY on the BACKEND
# ONLY: the worker inherits nothing but `env_file`, so without the key in the
# env file it runs with an empty one and gets 401 on every call it ever makes.
# That is the whole of `panel_sync: failed` on that half, and the differential
# would be comparing our working half against a half answering the shop
# unauthenticated.
#
# Taken from the shop's compose, not pasted here: it is that file's default for
# REMNAWAVE_DEV_API_TOKEN, and a copy would be a second place to be wrong.
fill_ref_token() {
  local compose="$SHOP/docker-compose.remnawave-dev.yml" tok
  [[ -f "$compose" ]] || die "no $compose - cannot learn the reference panel's token"
  tok="$(sed -n 's/.*PANEL_API_KEY: *${REMNAWAVE_DEV_API_TOKEN:-\([^}]*\)}.*/\1/p' "$compose" | head -1)"
  [[ -n "$tok" ]] || die "no REMNAWAVE_DEV_API_TOKEN default in $compose
Without it the shop's worker talks to the reference panel unauthenticated and
every sync on that half fails, which the differential then reports as though it
were something about our facade."
  write_runtime_env "$HERE/remnawave-ref.env" "$RUNTIME_REF_ENV" "$tok"
}

# The shop's demo seed can exit non-zero (it did on older tags), so its exit code
# says nothing about whether the admin user landed. Check the row, not the
# code: a silently unseeded admin makes every admin route answer 403, which
# reads like an auth defect in the facade and is not one.
assert_admin_seeded() {
  local which="$1" env_file admin_id out
  case "$which" in
    iceslab) env_file="$RUNTIME_ENV"; set -- "${compose_iceslab[@]}" ;;
    ref)     env_file="$RUNTIME_REF_ENV"; set -- "${compose_ref[@]}" ;;
    *) die "assert_admin_seeded: unknown half $which" ;;
  esac
  admin_id="$(sed -n 's/^ADMIN_IDS=//p' "$env_file" | tail -1 | cut -d, -f1 | tr -d '[:space:]')"
  [[ -n "$admin_id" ]] || die "no ADMIN_IDS in $env_file"
  out="$("$@" exec -T postgres sh -ec \
    "psql -qtAX -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -c \
     \"select user_id, email from users where telegram_id = $admin_id\"")" \
    || die "could not query the shop database for the admin user"
  [[ -n "${out//[[:space:]]/}" ]] || die "the shop's demo seed left no user with telegram_id=$admin_id
ADMIN_IDS names it, so every /api/admin route will answer 403."
  echo "stand: admin seeded -> $out"
}

# The shop's WORKER, not just its backend, has to be able to talk to the panel.
# It is a separate container with its own environment, and the shop's reference
# override configures only the backend.
assert_worker_authenticated() {
  local which="$1" key
  case "$which" in
    iceslab) set -- "${compose_iceslab[@]}" ;;
    ref)     set -- "${compose_ref[@]}" ;;
    *) die "assert_worker_authenticated: unknown half $which" ;;
  esac
  key="$("$@" exec -T worker python3 -c \
    'import os; print(len(os.environ.get("PANEL_API_KEY","")))')" \
    || die "could not read the worker's environment on the $which half"
  [[ "${key//[[:space:]]/}" =~ ^[0-9]+$ ]] || die "unexpected answer from the $which worker: $key"
  (( ${key//[[:space:]]/} > 0 )) || die "the $which half's worker has no PANEL_API_KEY.
Every call it makes will be 401 and the differential would report that as a
divergence of the panel."
  echo "stand: $which worker authenticated (PANEL_API_KEY ${key//[[:space:]]/} chars)"
}

# Our panel is not part of the stand's volumes, so `reset` does not touch it,
# and the shop finds a panel user by EMAIL. A buyer left over from an earlier run
# turns the purchase into an UPDATE of an existing panel user, while the
# reference panel (whose database IS a stand volume) starts empty and takes a
# CREATE. The two halves then diverge on a trace line, and the finding is the
# stand's, not the facade's.
purge_panel_user() {
  local email="${1:?}" tok ids id code
  tok="$(tr -d '[:space:]' < "$TOKEN_FILE")"
  ids="$(curl -sS -H "authorization: Bearer $tok" \
        "$PANEL_URL/api/users/by-email/$email" \
        | python3 -I -c 'import json,sys
try: d = json.load(sys.stdin)
except Exception: sys.exit(0)
users = d.get("users") if isinstance(d, dict) else None
print("\n".join(u["id"] for u in (users or []) if u.get("id")))')"
  [[ -n "$ids" ]] || { echo "stand: no leftover panel user for $email"; return 0; }
  while read -r id; do
    [[ -n "$id" ]] || continue
    code="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE \
      -H "authorization: Bearer $tok" "$PANEL_URL/api/users/$id")"
    case "$code" in
      2*) echo "stand: removed leftover panel user $id ($email)" ;;
      *)  die "could not remove the leftover panel user $id: HTTP $code
The purchase would update it instead of creating one, and the differential
would report that as a facade divergence." ;;
    esac
  done <<< "$ids"
}

# The buyer, and the users the shop's own demo seed names (the shop's fleet sync
# imports whatever the panel holds under those addresses).
stand_owned_emails() {
  local seed="$SHOP/deploy/dev/seed-minishop.sql" found
  [[ -f "$seed" ]] || die "no $seed - cannot tell which panel users this stand left behind"
  found="$(grep -oE "'[A-Za-z0-9._%+-]+@example\\.com'" "$seed" | tr -d "'" | sort -u || true)"
  printf '%s\n%s\n' "${STAND_BUYER:-stand-buyer@example.com}" "$found"
}
purge_panel_leftovers() {
  local email
  while read -r email; do
    [[ -n "$email" ]] || continue
    purge_panel_user "$email"
  done <<< "$(stand_owned_emails)"
}

# The shop is reachable through its own nginx, and nginx resolves its upstream
# once at startup: restart the backend alone and the frontend keeps proxying to
# an address that no longer exists, answering with an empty body. So the
# frontend is restarted with it, and then this waits for the webapp itself,
# because a healthy container is not yet an answering one.
wait_shop() {
  # Any answer FROM THE APP counts, including 401 and 404: what is being waited
  # on is nginx having an upstream that talks, and pinning the probe to one
  # route's success would make this fail whenever that route moves.
  local url="$SHOP_URL/api/me" i code
  for i in $(seq 1 60); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "$url" || true)"
    case "$code" in
      000|502|503|504) : ;;
      *) echo "stand: shop webapp answering ($code)"; return 0 ;;
    esac
    sleep 1
  done
  die "the shop webapp never answered at $url (last status ${code:-none})"
}

preflight_facade() {
  local code tok body
  code="$(curl -s -o /dev/null -w '%{http_code}' "$PANEL_URL/$PREFIX/api/system/metadata")"
  case "$code" in
    401) : ;;  # mounted and asking for auth, which is what we want
    404) die "the facade is not mounted at $PANEL_URL/$PREFIX/api - set REMNAWAVE_COMPAT_ENABLED=true and restart the panel" ;;
    000) die "no panel answering at $PANEL_URL" ;;
    *)   echo "stand: warning - facade probe answered $code, expected 401" >&2 ;;
  esac
  tok="$(tr -d '[:space:]' < "$TOKEN_FILE")"
  body="$(curl -s -H "authorization: Bearer $tok" "$PANEL_URL/$PREFIX/api/system/metadata")"
  [[ "$body" == *'"version"'* ]] || die "the token does not authenticate against the facade: $body"
  echo "stand: facade says $body"
}

assert_front_proxies_the_facade() {
  # The frontend image is a fixture too, and a wrong one makes every probe after
  # it report something about the shop that is not true. Two directions, because
  # either check alone passes on an nginx broken the other way: one that
  # forwards nothing satisfies the second, and one whose SPA fallback swallows
  # the API satisfies the first: an index.html served with a 200 on the prefix
  # the shop is documented to use.
  local front="http://127.0.0.1:${PANEL_FRONT_PORT:-8087}"
  local code ctype

  # 1. The facade reaches the panel and answers as the panel, not as the SPA.
  #    401 is the right answer to an unauthenticated call; what must NOT come
  #    back is 200 text/html.
  read -r code ctype < <(curl -sS -o /dev/null \
    -w '%{http_code} %{content_type}\n' "$front/$PREFIX/api/users")
  case "$code" in
    401|403) ;;
    *) die "the frontend image answered $code ($ctype) on /$PREFIX/api/users.
A 200 text/html here is the SPA fallback eating the facade; anything else means
nginx is not reaching the panel on $PANEL_BACKEND_ADDR." ;;
  esac
  case "$ctype" in
    *html*) die "the frontend image answered $code but with $ctype on
/$PREFIX/api/users: that is index.html, i.e. the SPA fallback answering the
facade's prefix." ;;
  esac

  # 2. ...and it is still a single-page app for everything else, or the fixture
  #    is an nginx that proxies the whole world and proves nothing about which
  #    prefixes it forwards.
  read -r code ctype < <(curl -sS -o /dev/null \
    -w '%{http_code} %{content_type}\n' "$front/nodes")
  [[ "$code" == 200 && "$ctype" == *html* ]] \
    || die "the frontend image answered $code ($ctype) on /nodes, so it is not
serving the SPA at all and check 1 above proved nothing."
  echo "stand: panel-front forwards /$PREFIX/api to the panel ($PANEL_BACKEND_ADDR) and serves the SPA on /nodes"
}

# For every command that drives the shop: `down` and `reset` reach for both
# halves, and `--env-file` on a file that is not there is a compose error, not a
# fallback.
if ! offline "${1:-}"; then
  fill_ref_token
  fill_token
fi

case "${1:-}" in
  mint-token)
    # An icp_ token for the stand, through the panel's own API: log in as an
    # admin (PANEL_ADMIN_USER / PANEL_ADMIN_PASSWORD), POST /api/api-tokens, keep
    # the plaintext in TOKEN_FILE. API tokens cannot mint tokens, so this has to
    # be a real admin login.
    : "${PANEL_ADMIN_USER:?set PANEL_ADMIN_USER and PANEL_ADMIN_PASSWORD}"
    : "${PANEL_ADMIN_PASSWORD:?set PANEL_ADMIN_USER and PANEL_ADMIN_PASSWORD}"
    jwt="$(curl -sS -X POST "$PANEL_URL/api/auth/login" -H 'content-type: application/json' \
      -d "$(python3 -I -c 'import json,os; print(json.dumps({"username": os.environ["PANEL_ADMIN_USER"], "password": os.environ["PANEL_ADMIN_PASSWORD"]}))')" \
      | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["token"])')" \
      || die "admin login failed at $PANEL_URL"
    name="minishop-stand-$(date +%s)"
    mkdir -p "$(dirname "$TOKEN_FILE")"
    ( umask 077
      curl -sS -X POST "$PANEL_URL/api/api-tokens" -H "authorization: Bearer $jwt" \
        -H 'content-type: application/json' -d "{\"name\":\"$name\"}" \
        | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["token"])' > "$TOKEN_FILE" ) \
      || die "could not mint a token"
    [[ "$(cut -c1-4 "$TOKEN_FILE")" == icp_ ]] || die "the panel did not return an icp_ token"
    echo "stand: token '$name' written to $TOKEN_FILE"
    ;;

  up-iceslab)
    fill_token require
    preflight_facade
    purge_panel_leftovers
    # The shop reaches the facade through the panel's OWN frontend image, because
    # that is what stands in front of it in a real deploy. Pointing the shop
    # straight at the backend would hide an nginx whose SPA fallback answers
    # `/rw/api/*` with index.html and a 200: no request would go through nginx
    # to see it. The URL is already in the .runtime env (fill_token), BEFORE
    # `up`, because `env_file` is read when the container is created.
    "${compose_iceslab[@]}" up -d --build --wait "${STAND_SERVICES[@]}"
    assert_front_proxies_the_facade
    "${compose_iceslab[@]}" --profile seed up -d --build --wait "${SHOP_SERVICES[@]}"
    # The shop's demo fixtures, same as the reference half runs: without them
    # there is no user whose telegram_id is in ADMIN_IDS, and the admin API
    # answers 403 to everything. Seed BEFORE the restart, so both halves reach
    # the purchase with the same cache state.
    "${compose_iceslab[@]}" --profile seed up --no-deps dev-seed \
      || echo "stand: the shop's own demo seed exited non-zero; the admin row decides (below)" >&2
    assert_admin_seeded iceslab
    assert_worker_authenticated iceslab
    # `restart` returns when the container is running, not when the app inside
    # it answers; `up --wait` waits for healthy.
    "${compose_iceslab[@]}" restart backend worker
    "${compose_iceslab[@]}" up -d --wait backend worker
    # The frontend LAST and on its own: a restarted backend comes back on a NEW
    # container IP, which the shop's nginx resolved once at its own start.
    "${compose_iceslab[@]}" restart frontend
    "${compose_iceslab[@]}" up -d --wait frontend
    wait_shop
    echo "stand: shop at $SHOP_URL (webapp), backend http://127.0.0.1:$SHOP_PORT"
    ;;

  up-ref)
    # The seed jobs have to be NAMED, not just enabled by their profile:
    # `--profile seed` with an explicit service list starts only the listed ones,
    # and without the seed the reference panel has no API token and answers 403
    # to everything. The shop then logs "Could not detect Remnawave panel
    # version", refuses to create a user, and the activation fails.
    "${compose_ref[@]}" --profile seed up -d --wait \
      "${SHOP_SERVICES[@]}" remnawave remnawave-db remnawave-redis
    "${compose_ref[@]}" --profile seed up --no-deps remnawave-dev-seed || \
      die "the reference panel's API token was not seeded; it will answer 403 to everything"
    "${compose_ref[@]}" --profile seed up --no-deps dev-seed \
      || echo "stand: the shop's own demo seed exited non-zero; the admin row decides (below)" >&2
    assert_admin_seeded ref
    assert_worker_authenticated ref
    # The shop cached "could not detect version" while the panel was unseeded.
    "${compose_ref[@]}" restart backend worker
    "${compose_ref[@]}" up -d --wait backend worker
    "${compose_ref[@]}" restart frontend
    "${compose_ref[@]}" up -d --wait frontend
    wait_shop
    echo "stand: reference panel published on http://127.0.0.1:${REMNAWAVE_DEV_PANEL_PORT:-3100} (the host's 3000 is our own panel)"
    ;;

  down)
    # Every profile the stand can START has to be named on the way DOWN, or its
    # container is left behind and the next run tries to start a stale one on a
    # network `down -v` has already removed.
    "${compose_iceslab[@]}" "${STAND_PROFILES[@]}" down --remove-orphans || true
    "${compose_ref[@]}" --profile seed down --remove-orphans || true
    ;;
  reset)
    # Volumes too. Between the two halves of a differential run this is not
    # optional: a shop database carried over from the other half makes the
    # comparison meaningless in a way nothing announces. Our own panel is not a
    # stand volume; up-iceslab purges its leftovers.
    "${compose_iceslab[@]}" "${STAND_PROFILES[@]}" down -v --remove-orphans || true
    "${compose_ref[@]}" --profile seed down -v --remove-orphans || true
    ;;

  subpage)
    # The install document the panel emits, through the SHOP'S validator.
    #
    # Belongs here rather than in the backend suite because a check that only
    # consults our own opinion of the contract cannot see the shop deciding our
    # document is unusable: the shop validates it all-or-nothing, and from the
    # panel side a discarded document and an accepted one look identical.
    #
    # Needs the shop CHECKOUT (not the stand's containers) and a live panel.
    shift
    [[ $# -ge 1 ]] || die "usage: stand.sh subpage <subscription-token> [<subscription-token> ...]"
    MINISHOP_DIR="$SHOP" PANEL_TOKEN_FILE="$TOKEN_FILE" REMNAWAVE_COMPAT_PREFIX="$PREFIX" \
      exec python3 -I "$HERE/subpage_validate.py" "$@"
    ;;

  mark)   date -u +%Y-%m-%dT%H:%M:%SZ ;;
  status) docker ps --filter name=remnawave --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' ;;
  logs)   shift; "${compose_iceslab[@]}" logs --tail "${1:-80}" backend worker ;;

  trace)
    # The diffable half of the differential test.
    #
    # The shop logs one line per panel response carrying the OPERATION LABEL
    # from its own contract registry plus the status, and the label is
    # deliberately identifier-free. That makes the sequence of calls comparable
    # between two stands without any normalisation of ids or timestamps.
    #
    # What a diff catches that a green run does not: the shop taking a DIFFERENT
    # PATH against us. If it reads /users instead of /users/stream, it decided
    # our panel is not really 3.x; if a call is missing entirely, it decided a
    # capability is absent. Both look like success from the outside.
    shift
    out="${1:-/dev/stdout}"
    # From this container run only. `docker logs` keeps output across restarts,
    # and a trace that carries a previous run's calls compares two things that
    # never happened together.
    # BOTH containers: the shop is two processes, and the fleet sync and the
    # tariff workers live in the WORKER. A trace that cannot see them reports
    # "the shop never called that" about calls it was not listening for.
    # Compared as multisets, so merging two logs needs no interleaving.
    mark="${2:-}"
    : > "$out"
    for container in remnawave-minishop-backend remnawave-minishop-worker; do
      docker inspect -f '{{.State.StartedAt}}' "$container" >/dev/null 2>&1 \
        || die "$container is not there; a trace missing one of the shop's two
processes silently under-reports what it called."
      # Each container's OWN start when no mark is given: they start at
      # different moments, and the backend's stamp would carry the worker's
      # previous-run lines into this trace.
      since="${mark:-$(docker inspect -f '{{.State.StartedAt}}' "$container")}"
      raw="$(docker logs --since "$since" "$container" 2>&1)" \
        || die "could not read $container's log"
      # `|| true` because grep exits 1 when a container made NO calls in the
      # window, which is a fact about the run and not a failure to read it.
      printf '%s\n' "$raw" \
        | grep -oE 'method=[A-Z]+ endpoint=[^ ]+ status=[0-9]+' \
        | sed -E 's/method=([A-Z]+) endpoint=([^ ]+) status=([0-9]+)/\1 \2 \3/' \
        >> "$out" || true
    done
    [[ "$out" == /dev/stdout ]] || echo "stand: wrote $(wc -l < "$out") call(s) to $out"
    ;;

  compare)
    shift
    [[ $# -eq 2 ]] || die "usage: stand.sh compare <reference-trace> <candidate-trace>"
    # Delegated to compare_traces.py: the comparison has to tell a capability
    # divergence apart from a status the shop's own registry declares
    # interchangeable, and a shell diff reports both as the same red line.
    exec python3 -I "$HERE/compare_traces.py" "$1" "$2"
    ;;

  *)
    cat <<EOF
usage: $(basename "$0") <command>

  mint-token   admin login (PANEL_ADMIN_USER/PANEL_ADMIN_PASSWORD) -> an icp_ token in .runtime/panel-token
  up-iceslab   shop -> this panel's facade, through the panel's own frontend image
               (needs the panel running with the facade on)
  up-ref       shop -> a real Remnawave 3.4.10 in docker (the reference half)
  down         stop both halves, keep their volumes
  reset        stop both halves AND drop their volumes
  status       what is running
  logs [n]     tail the shop's backend and worker
  mark         print a timestamp to hand to 'trace' later
  trace [file] [since]
               dump the shop's panel-API call trace (operation labels + status);
               the optional RFC3339 stamp (e.g. from 'mark') scopes it to one step
  compare a b  diff two traces as multisets, by the shop's contract registry
  subpage <subscription-token>...
               the panel's install document through the shop's own validator
               (needs the shop checkout and the panel; no docker)

Environment: MINISHOP_DIR (required; checkout of remnawave-minishop at $SHOP_TAG),
PANEL_URL (http://127.0.0.1:3000), PANEL_TOKEN_FILE (.runtime/panel-token),
REMNAWAVE_COMPAT_PREFIX (rw), SHOP_PORT (8080), PANEL_BACKEND_ADDR (docker bridge
gateway:3000), PANEL_FRONT_PORT (8087), STAND_BUYER.

One at a time: the two halves share container names.
EOF
    exit 2 ;;
esac
