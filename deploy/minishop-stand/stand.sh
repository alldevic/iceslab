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
# Where the lab panel's database runs: the probes that write to it (premium
# usage) go through `docker exec` into this container. The defaults are the dev
# database of this repo's docker-compose.yml, the same variables
# seed_node_traffic.py reads.
PANEL_DB_CONTAINER="${PANEL_DB_CONTAINER:-iceslab-postgres}"
PANEL_DB_USER="${PANEL_DB_USER:-iceslab}"
PANEL_DB_NAME="${PANEL_DB_NAME:-iceslab}"
# What `up-iceslab` was asked to do to the shop's env (HIDE_NODES_USAGE,
# CHURN_PAGING). Kept in a file because the runtime env is rebuilt from the
# template on every command, and `compose up` recreates a container whose env
# changed: a rebuilt env that forgot the mode would recreate the worker without it.
MODE_FILE="$HERE/.runtime/stand-mode.env"
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
    compare|compare-admin|verdict|selftest|mark|mint-token|'') return 0 ;;
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
# have started, not what this particular invocation started. A left-over shim is
# worse than a left-over seed job: it still answers, so the next run would talk
# to a panel with a route missing.
STAND_PROFILES=(--profile seed --profile tls --profile shim)

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
  apply_stand_mode "$RUNTIME_ENV"
}

# An env switch that is set and not "0".
flag_on() { [[ -n "${1:-}" && "$1" != 0 ]]; }

# The shop's env for the mode `up-iceslab` was started in, written BEFORE the
# env is built. The env file is read when a container is created, so the mode
# has to be in it before `up`.
#
#   HIDE_NODES_USAGE=1  the shop reaches the panel through panel-shim, which
#                       answers POST .../bandwidth-stats/nodes/usage with a router
#                       miss: the shop must fall back to the route no ordinary
#                       run reaches. Only `premium-probe` cares; everything else
#                       would be measuring one more nginx.
#   CHURN_PAGING=1      the shop's fleet sync walks /users/stream in pages of
#                       CHURN_PAGE_SIZE (5) with CHURN_PAGE_DELAY (1.0) seconds
#                       between them, through its own settings
#                       PANEL_ALL_USERS_PAGE_SIZE / PANEL_ALL_USERS_PAGE_DELAY_SECONDS,
#                       so a walk lasts long enough to delete a user inside it.
write_stand_mode() {
  mkdir -p "$HERE/.runtime"
  : > "$MODE_FILE"
  if flag_on "${HIDE_NODES_USAGE:-}"; then
    echo "PANEL_API_URL=http://panel-shim:8080/${PREFIX}/api" >> "$MODE_FILE"
    echo "stand: the shop will reach the panel through panel-shim, which answers"
    echo "stand: POST .../bandwidth-stats/nodes/usage with a router miss"
  fi
  if flag_on "${CHURN_PAGING:-}"; then
    {
      echo "PANEL_ALL_USERS_PAGE_SIZE=${CHURN_PAGE_SIZE:-5}"
      echo "PANEL_ALL_USERS_PAGE_DELAY_SECONDS=${CHURN_PAGE_DELAY:-1.0}"
    } >> "$MODE_FILE"
    echo "stand: sync paging forced to ${CHURN_PAGE_SIZE:-5} users, ${CHURN_PAGE_DELAY:-1.0}s between pages"
  fi
}

# Applies the mode file to an env file: a key already there is replaced, never
# repeated.
apply_stand_mode() {
  local target="$1" line key
  [[ -s "$MODE_FILE" ]] || return 0
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    key="${line%%=*}"
    { grep -v "^$key=" "$target" || true; } > "$target.tmp"
    printf '%s\n' "$line" >> "$target.tmp"
    mv "$target.tmp" "$target"
  done < "$MODE_FILE"
  chmod 600 "$target"
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

# The panel squads the tariff catalogue names, on OUR panel. The reference
# panel arrives with `MiniShop Standard` and `MiniShop Premium` from the shop's
# own seed-remnawave.sql, so only this half needs them made. If a later shop
# release stops seeding them there, seed_tariffs.py refuses by name rather than
# storing a catalogue that points nowhere.
#
# The names come from the template, not from a second list here: a catalogue
# naming a squad this never creates would fail at seed time, and one creating a
# squad no tariff names would be litter on a panel the stand does not own.
ensure_panel_squads() {
  local tok names name code
  tok="$(tr -d '[:space:]' < "$TOKEN_FILE")"
  names="$(python3 -I "$HERE/squad_names.py" "$HERE/tariffs.template.json")" \
    || die "could not read the squad names out of tariffs.template.json"
  [[ -n "$names" ]] || die "tariffs.template.json names no squad, so no tariff can move one"
  while read -r name; do
    [[ -n "$name" ]] || continue
    code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
      -H "authorization: Bearer $tok" -H 'content-type: application/json' \
      -d "$(python3 -I -c 'import json,sys; print(json.dumps({"name": sys.argv[1]}))' "$name")" \
      "$PANEL_URL/api/squads")"
    case "$code" in
      201) echo "stand: created panel squad '$name'" ;;
      409) echo "stand: panel squad '$name' already there" ;;
      *)   die "could not create the panel squad '$name': HTTP $code
The tariff catalogue names it, and without it seed_tariffs.py refuses - which is
correct, but the fix belongs here." ;;
    esac
  done <<< "$names"
  clear_squad_profiles
}

# Put the stand's squads back to granting NOTHING, every time a half comes up.
# Our panel is not a stand volume, so a profile attached to a squad by an earlier
# run (the premium probe does it) outlives that run, and the next differential
# would have our half metering a squad the reference half - whose panel has no
# nodes to grant - skips. Unconditional rather than "only if attached": reading
# first and writing only on a difference would make the common path silent about
# what it did.
clear_squad_profiles() {
  local tok sid code
  tok="$(tr -d '[:space:]' < "$TOKEN_FILE")"
  while read -r sid; do
    [[ -n "$sid" ]] || continue
    code="$(curl -sS -o /dev/null -w '%{http_code}' -X PUT -H "authorization: Bearer $tok" \
      -H 'content-type: application/json' -d '{"profileIds":[]}' \
      "$PANEL_URL/api/squads/$sid")" || die "could not clear profiles on squad $sid"
    [[ "$code" == 2* ]] || die "clearing profiles on squad $sid answered HTTP $code"
  done <<< "$(stand_squad_ids)"
  echo "stand: squad profiles cleared"
}

# The uuids of the squads the tariff template names, on this panel, read through
# the facade. With --premium, only the squads a tariff hands out as its premium
# segment.
stand_squad_ids() {
  local tok names
  tok="$(tr -d '[:space:]' < "$TOKEN_FILE")"
  names="$(python3 -I "$HERE/squad_names.py" "$HERE/tariffs.template.json" "$@" | tr '\n' '|')" \
    || die "could not read the squad names out of the tariff template"
  curl -sS -H "authorization: Bearer $tok" "$PANEL_URL/$PREFIX/api/internal-squads" \
    | python3 -I "$HERE/squad_ids.py" "$names"
}

# The tariff catalogue itself, through the shop's own admin API. Both halves,
# same code, resolved against whichever panel the shop is pointed at. The shop
# caches the squad list for 300 s: callers restart backend and worker (and then
# the frontend) afterwards.
seed_tariffs() {
  python3 -I "$HERE/seed_tariffs.py" --shop "$SHOP_URL" \
    || die "the tariff catalogue was not configured; the two admin actions that
reach the panel through a tariff would answer 400 and 502 on both halves, and
the differential would compare two refusals."
}

# The walk reads the worker's log window, and the worker's own background sync
# calls land in it unless it has gone quiet. Idleness is read as "the worker's
# log tail did not change for N consecutive seconds", not as a particular line:
# a marker would tie this to one release's wording of a dependency we do not
# control. Not fatal on timeout: a worker that never quiets is said out loud
# and the trace carries the noise it always did.
wait_for_worker_idle() {
  local which="$1" quiet="${2:-4}" timeout="${3:-90}"
  local container="remnawave-minishop-worker"
  local waited=0 stable=0 prev="" now
  while (( waited < timeout )); do
    # `|| true`: docker logs exits non-zero for a restarting container, and
    # under `set -e` that would kill the run for a state about to pass.
    now="$(docker logs --tail 5 "$container" 2>&1 | md5sum || true)"
    if [[ "$now" == "$prev" ]]; then
      stable=$(( stable + 1 ))
      if (( stable >= quiet )); then
        echo "stand: $which worker idle after ${waited}s"
        return 0
      fi
    else
      stable=0
    fi
    prev="$now"
    sleep 1
    waited=$(( waited + 1 ))
  done
  echo "stand: WARNING - $which worker still talking after ${timeout}s; the admin" >&2
  echo "       trace may carry background sync calls the walk did not make" >&2
  return 0
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

# ---- the probes' own helpers -------------------------------------------------

# A self-signed certificate for the webhook TLS front. Made when missing and
# never committed (.runtime/ is ignored): it exists so the stand can put a REAL
# proxy in the path, not to be trusted by anything.
ensure_webhook_cert() {
  local dir="$HERE/.runtime/certs"
  [[ -f "$dir/tls.crt" && -f "$dir/tls.key" ]] && return 0
  mkdir -p "$dir"
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
    -subj '/CN=minishop-webhook.stand' \
    -addext 'subjectAltName=DNS:minishop-webhook.stand,DNS:localhost,IP:127.0.0.1' \
    -keyout "$dir/tls.key" -out "$dir/tls.crt" >/dev/null 2>&1 \
    || die "could not generate the webhook TLS certificate"
  chmod 644 "$dir/tls.crt"; chmod 640 "$dir/tls.key"
  echo "stand: generated a self-signed webhook TLS certificate in $dir"
}

# An admin session on the shop, as admin.sh gets one. $1 is the cookie jar; prints
# the CSRF token.
shop_admin_session() {
  local jar="$1" email="${ADMIN_EMAIL:-runes.admin@example.com}" req code ver csrf
  req="$(curl -sS -b "$jar" -c "$jar" -H 'content-type: application/json' \
    -X POST "$SHOP_URL/api/auth/email/request" -d "{\"email\":\"$email\"}")" \
    || die "the shop's auth API did not answer at $SHOP_URL"
  code="$(python3 -I -c 'import json,sys,re
d=json.loads(sys.argv[1])
def f(o):
    if isinstance(o,dict):
        for k,v in o.items():
            if "code" in k.lower() and isinstance(v,str) and re.fullmatch(r"\d{4,8}",v): return v
            r=f(v)
            if r: return r
    elif isinstance(o,list):
        for v in o:
            r=f(v)
            if r: return r
    return None
print(f(d) or "")' "$req")"
  [[ -n "$code" ]] || die "no verification code for the admin session (QA_AUTH_ENABLED off?)"
  ver="$(curl -sS -b "$jar" -c "$jar" -H 'content-type: application/json' \
    -X POST "$SHOP_URL/api/auth/email/verify" -d "{\"email\":\"$email\",\"code\":\"$code\"}")"
  csrf="$(python3 -I -c 'import json,sys; print(json.loads(sys.argv[1]).get("csrf_token",""))' "$ver")"
  [[ -n "$csrf" ]] || die "no csrf token for the admin session"
  printf '%s' "$csrf"
}

# The SHOP's copy of a buyer, through its own admin API.
#
# Purging the panel side is not enough on its own: the shop's fleet sync imports
# panel users it does not know, so a panel user deleted after a demotion comes
# BACK as a shop subscription with no tariff_key, and the next purchase for that
# address answers `tariff_switch_required` instead of creating anything.
purge_shop_user() {
  local email="${1:?}" jar csrf uid
  jar="$(mktemp)"
  csrf="$(shop_admin_session "$jar")" || { rm -f "$jar"; die "no admin session to purge $email"; }
  uid="$(curl -sS -b "$jar" -c "$jar" "$SHOP_URL/api/admin/users?limit=200" \
    | python3 -I -c 'import json,sys
rows = json.load(sys.stdin).get("users") or []
print(next((str(u["user_id"]) for u in rows if str(u.get("email") or "").lower() == sys.argv[1].lower()), ""))' "$email")"
  if [[ -n "$uid" ]]; then
    curl -sS -o /dev/null -b "$jar" -c "$jar" -H "X-CSRF-Token: $csrf" \
      -X DELETE "$SHOP_URL/api/admin/users/$uid" \
      || { rm -f "$jar"; die "could not remove the shop user $uid ($email)"; }
    echo "stand: removed the shop's user $uid ($email)"
  else
    echo "stand: no shop user for $email"
  fi
  rm -f "$jar"
}

# psql inside the panel's database container.
panel_psql() {
  docker exec -i "$PANEL_DB_CONTAINER" psql -U "$PANEL_DB_USER" -d "$PANEL_DB_NAME" -qtAX "$@"
}

# The shop caches the squad list and what a squad grants for 300 s, in its own
# Redis AND in the worker's memory. So after the panel's squads change, drop the
# keys and restart the worker, or the probe waits on a tick that still sees the
# old answer: it then reports "the route was not called" about a shop that never
# looked. The keys alone are not enough (the worker's memory), the restart alone
# is not either (Redis), and neither is checked by the other.
#
# This is the SHOP's Redis (a stand container), never the panel's: the panel and
# its test suite share one Redis, and a prefix-scan delete there reaches into a
# running panel.
drop_shop_squad_cache() {
  local keys
  keys="$(docker exec remnawave-minishop-redis redis-cli --scan --pattern '*cache:panel:squads*' 2>/dev/null || true)"
  if [[ -n "$keys" ]]; then
    xargs -r <<<"$keys" docker exec -i remnawave-minishop-redis redis-cli del >/dev/null \
      || die "could not drop the shop's cached squad answers"
    echo "stand: dropped $(wc -l <<<"$keys") cached squad key(s) from the shop's redis"
  fi
  "${compose_iceslab[@]}" restart worker
  "${compose_iceslab[@]}" up -d --wait worker
}

# A squad with no NODES is a squad the shop quietly refuses to meter.
#
# Called from `premium-probe`, NOT from `up-*`: only our half's squads can be
# given nodes (the reference panel has none to give), so doing it during a
# differential would make our half meter premium while the reference skips it,
# one more divergence line per run that says nothing about the facade.
#
# A bare squad grants no profiles, so the facade's accessible-nodes answers [],
# and the tariff worker logs `Premium squads for tariff <key> have no accessible
# nodes` and skips premium accounting entirely, which is the only thing that
# ever calls POST /bandwidth-stats/nodes/usage. So: give each stand squad the
# panel's profiles, and then CHECK that it grants a node. Which profile carries
# the node binding is lab state (a README precondition: the stand does not
# create it), and the check decides. Node status does not matter: the facade maps
# squad -> profiles -> bindings -> nodes without filtering on it.
grant_squad_nodes() {
  local tok squads profiles sid nodes code
  tok="$(tr -d '[:space:]' < "$TOKEN_FILE")"
  squads="$(stand_squad_ids)" || die "could not list the panel's squads"
  profiles="$(curl -sS -H "authorization: Bearer $tok" "$PANEL_URL/api/profiles" \
    | python3 -I -c 'import json,sys
d = json.load(sys.stdin)
rows = d.get("profiles", d) if isinstance(d, dict) else d
print(" ".join(p["id"] for p in rows if p.get("id")))')" || die "could not list the panel's profiles"
  [[ -n "$profiles" ]] || die "the panel has no profile, so no squad can grant a node and the shop
will skip premium accounting without calling anything. A profile bound to a node
is a precondition of this probe (README); the stand does not create one."
  while read -r sid; do
    [[ -n "$sid" ]] || continue
    code="$(curl -sS -o /dev/null -w '%{http_code}' -X PUT -H "authorization: Bearer $tok" \
      -H 'content-type: application/json' \
      -d "$(python3 -I -c 'import json,sys; print(json.dumps({"profileIds": sys.argv[1].split()}))' "$profiles")" \
      "$PANEL_URL/api/squads/$sid")" || die "could not attach profiles to squad $sid"
    [[ "$code" == 2* ]] || die "attaching profiles to squad $sid answered HTTP $code"
    nodes="$(curl -sS -H "authorization: Bearer $tok" \
      "$PANEL_URL/$PREFIX/api/internal-squads/$sid/nodes" \
      | python3 -I -c 'import json,sys; print(len(json.load(sys.stdin).get("response") or []))')"
    (( nodes > 0 )) || die "squad $sid still grants no node after attaching every profile.
The shop logs 'Premium squads ... have no accessible nodes' and skips premium
accounting, so POST /bandwidth-stats/nodes/usage is never called and the run
proves nothing about it. Bind a profile to a node on the panel first (README)."
    echo "stand: squad $sid grants $nodes node(s)"
  done <<< "$squads"
}

# Panel ids of every churn-probe user.
#
# Through the native list, with the parameter it really has: `limit`, at most
# 500, and `page` to go on. (`size` is not in that schema; asking for 1000 got
# the default 50, sorted by name, so a panel with more users left the probe's
# users behind without a word.) Pages until one comes back short, and `search`
# narrows it to the probe's own names.
#
# Retries past the rate limit rather than returning an empty list: throttled and
# finished look identical from here, and that confusion is what let leftovers
# through. Signals failure by return code - a `die` would be swallowed, because
# this runs inside a command substitution and that is a subshell.
churn_ids() {
  local tok="${1:?}" page=1 body attempt out
  while :; do
    out=""
    for attempt in 1 2 3; do
      body="$(curl -sS -H "authorization: Bearer $tok" \
        "$PANEL_URL/api/users?limit=500&page=$page&search=churn-probe-")" || body=""
      if [[ "$body" == *RATE_LIMITED* ]]; then sleep 20; body=""; continue; fi
      break
    done
    if [[ -z "$body" ]]; then
      echo "stand: the panel kept answering RATE_LIMITED (or nothing) while listing churn-probe users" >&2
      return 1
    fi
    # Prints the matching ids, then "n=<rows on this page>" as the last line.
    out="$(python3 -I -c 'import json,sys
try: d = json.load(sys.stdin)
except Exception: sys.exit(3)
rows = d.get("users")
if not isinstance(rows, list): sys.exit(3)
for u in rows:
    if str(u.get("username") or "").startswith("churn-probe-") and u.get("id"):
        print(u["id"])
print("n=%d" % len(rows))' <<< "$body")" || { echo "stand: the panel's user list was not readable: ${body:0:200}" >&2; return 1; }
    grep -v '^n=' <<<"$out" || true
    local n="${out##*n=}"
    (( n >= 500 )) || return 0
    page=$((page + 1))
  done
}

# The probe's own users, gone. They are not a stand volume (our panel never is),
# so without this every churn run leaves them behind, the next differential
# counts a different fleet, and the panel grows by 40 a run.
#
# Rounds, because the deletes themselves can reach the panel's request limit
# (100 a minute): each round re-lists, so a delete lost to a 429 is retried
# rather than assumed done. Reports failure by RETURN CODE, never by `die`: the
# caller wants to keep the probe's own verdict.
purge_churn_users() {
  local tok ids id code gone=0 round
  tok="$(tr -d '[:space:]' < "$TOKEN_FILE")"
  for round in 1 2 3 4; do
    ids="$(churn_ids "$tok")" || return 1
    [[ -n "$ids" ]] || break
    while read -r id; do
      [[ -n "$id" ]] || continue
      code="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE \
        -H "authorization: Bearer $tok" "$PANEL_URL/api/users/$id")"
      case "$code" in
        2*|404) gone=$((gone + 1)) ;;
        429) sleep 20 ;;
        *) echo "stand: could not remove churn-probe user $id: HTTP $code" >&2; return 1 ;;
      esac
    done <<< "$ids"
  done
  # Check, do not announce: the number above is what the deletes answered, not
  # what is on the panel.
  ids="$(churn_ids "$tok")" || return 1
  if [[ -n "$ids" ]]; then
    echo "stand: $(grep -c . <<<"$ids") churn-probe user(s) are STILL on the panel after cleanup.
The shop's fleet sync imports them on the next run, and the differential then
reports them as a facade divergence." >&2
    return 1
  fi
  echo "stand: removed $gone churn-probe user(s) from the panel; none left"
}

# Wait for a FULL tick of the shop's tariff worker after $1 (an RFC 3339 stamp).
# Only the full tick computes premium usage; it runs every TARIFF_WORKER_TICK_SECONDS
# (300) and `premium_fast` between ticks does not. Waiting for the tick itself
# rather than sleeping a guessed interval is the difference between "the route
# was not called" and "we did not wait". Eleven minutes at most.
#
# The log is captured first and NOT piped into `grep -q`: under `set -o pipefail`
# a pipeline reports the writer's status too, and `grep -q` exits the instant it
# matches, so the writer takes SIGPIPE and the pipeline returns 141 EXACTLY WHEN
# THE PATTERN IS FOUND. The check inverts, and only when the log is long enough
# that the writer is still going. A here-string is a file, not a pipe.
wait_for_full_tick() {
  local since="$1" _
  for _ in $(seq 1 66); do
    if grep -q 'worker=tariff kind=full' <<<"$(docker logs --since "$since" remnawave-minishop-worker 2>&1)"; then
      return 0
    fi
    sleep 10
  done
  return 1
}

assert_shim_hides_only_the_one_route() {
  # The shim is a fixture, and a wrong fixture makes the run report something
  # about the shop that is not true. Two directions, because either check alone
  # passes on a shim broken the other way: one answering 404 to EVERYTHING
  # satisfies the first and turns the probe into a test of a dead panel; one
  # forwarding everything satisfies the second, leaves the preferred route
  # answering, and the fallback is never reached.
  local shim="http://127.0.0.1:${PANEL_SHIM_PORT:-8086}/$PREFIX/api"
  local tok out code ctype body
  tok="$(tr -d '[:space:]' < "$TOKEN_FILE")"

  out="$(curl -sS -X POST "$shim/bandwidth-stats/nodes/usage" \
    -H "authorization: Bearer $tok" -H 'content-type: application/json' \
    -d '{"nodesUuids":[]}' -w $'\n%{http_code} %{content_type}')"
  read -r code ctype <<<"${out##*$'\n'}"
  body="${out%$'\n'*}"
  # The shop's predicate, not an eyeball: a 404 alone is not enough. The body
  # has to carry no errorCode and read like a router miss, and be declared JSON,
  # or the shop calls it a failed request and goes on preferring the route.
  python3 -I "$HERE/reads_as_missing_route.py" "$code" "$ctype" "$body" \
    || die "the shim answered $code ($ctype) / $body, which does NOT read to the shop as a
missing route (bot/services/panel_api_responses.py::_is_missing_endpoint_response).
The shop would treat it as a failed request and keep preferring /nodes/usage."

  # ...and the route right next to it still reaches the panel. Same prefix, same
  # method, one path segment apart - which is also the pair a suffix match is
  # most likely to get wrong.
  code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$shim/bandwidth-stats/nodes/users" \
    -H "authorization: Bearer $tok" -H 'content-type: application/json' \
    -d '{"nodesUuids":[]}')"
  [[ "$code" == 200 ]] || die "the shim answered $code for /bandwidth-stats/nodes/users, which it
is supposed to forward to the panel. A shim that hides everything proves nothing
about the fallback."
  echo "stand: panel-shim hides POST .../bandwidth-stats/nodes/usage and forwards the rest"
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
    # The mode first, because the env is built from it: HIDE_NODES_USAGE=1 and
    # CHURN_PAGING=1 (see write_stand_mode). Each `up-iceslab` states the mode
    # afresh, so none survives into the next one.
    write_stand_mode
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
    if flag_on "${HIDE_NODES_USAGE:-}"; then
      "${compose_iceslab[@]}" --profile shim up -d --wait panel-shim
      # Prove the shim is a panel-minus-one-route before anything depends on it:
      # the hidden route answers as absent, and the route next to it still reaches
      # the panel. Checking only the 404 would pass on a shim that answers 404 to
      # everything, a different experiment whose failures look like facade bugs.
      assert_shim_hides_only_the_one_route
    fi
    "${compose_iceslab[@]}" --profile seed up -d --build --wait "${SHOP_SERVICES[@]}"
    # The shop's demo fixtures, same as the reference half runs: without them
    # there is no user whose telegram_id is in ADMIN_IDS, and the admin API
    # answers 403 to everything. Seed BEFORE the restart, so both halves reach
    # the purchase with the same cache state.
    "${compose_iceslab[@]}" --profile seed up --no-deps dev-seed \
      || echo "stand: the shop's own demo seed exited non-zero; the admin row decides (below)" >&2
    assert_admin_seeded iceslab
    assert_worker_authenticated iceslab
    ensure_panel_squads
    seed_tariffs
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
    seed_tariffs
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
    rm -f "$MODE_FILE"
    ;;

  check)
    # The preconditions `up-*` asserts, against a stand that is already up.
    # Exists so the guards can be exercised without a twenty-minute run.
    shift
    which="${1:?usage: stand.sh check <iceslab|ref>}"
    assert_admin_seeded "$which"
    assert_worker_authenticated "$which"
    ;;

  seed-tariffs)
    # The catalogue step alone, against whichever half is up. Restart backend,
    # worker and then frontend afterwards if a page must see it at once: the
    # shop caches the squad list for 300 s.
    seed_tariffs
    ;;

  half)
    # One half of the differential, start to finish, from dropped volumes.
    #
    # Both halves go through this one code path on purpose: the comparison is
    # worth what the sameness of the two runs is worth, and two hand-typed
    # sequences drift in ways that then show up as findings. The buyer's address
    # is fixed for the same reason - the shop keys its user off it. Our panel's
    # leftovers are purged by up-iceslab.
    shift
    which="${1:-}"; outdir="${2:-}"
    [[ -n "$which" && -n "$outdir" ]] || die "usage: stand.sh half <iceslab|ref> <outdir>"
    mkdir -p "$outdir"
    case "$which" in
      iceslab) env_for_half="$RUNTIME_ENV" ;;
      ref)     env_for_half="$RUNTIME_REF_ENV" ;;
      *) die "half: expected iceslab or ref, got $which" ;;
    esac
    buyer="${STAND_BUYER:-stand-buyer@example.com}"
    "$0" reset
    "$0" "up-$which"
    # Node traffic, so the walk compares two FILLED `topNodes` lists. Without it
    # both halves report an empty one and the claim that we always fill it is
    # never exercised (see seed_node_traffic.py).
    python3 -I "$HERE/seed_node_traffic.py" "$which"
    SHOP_URL="$SHOP_URL" SHOP_PORT="$SHOP_PORT" STAND_ENV="$env_for_half" \
      "$HERE/buy.sh" "$buyer" > "$outdir/$which-buy.log" 2>&1 \
      || { tail -20 "$outdir/$which-buy.log" >&2; die "the purchase failed on the $which half"; }
    "$0" trace "$outdir/$which-buy.trace"
    # Open the trace window on a quiet worker: see wait_for_worker_idle.
    wait_for_worker_idle "$which"
    mark="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; sleep 1
    # admin.sh exits non-zero when a MUST_SUCCEED step failed; the pipe must not
    # hide that behind tee's status.
    SHOP_URL="$SHOP_URL" STAND_ENV="$env_for_half" \
      "$HERE/admin.sh" "$outdir/$which-admin.jsonl" "$buyer" 2>&1 | tee "$outdir/$which-admin.log"
    [[ "${PIPESTATUS[0]}" -eq 0 ]] || die "the admin walk failed on the $which half (see $outdir/$which-admin.log)"
    "$0" trace "$outdir/$which-admin.trace" "$mark"
    echo "stand: $which half done -> $outdir"
    ;;

  verdict)
    # The three comparisons on the files a differential left in <outdir>; needs
    # no stand and no docker. Exit 0: they agree. 1: a comparison found a
    # divergence. 2: a comparison refused (empty or unusable input) or a file is
    # missing - the run proved nothing, and that is not a finding.
    shift
    outdir="${1:?usage: stand.sh verdict <outdir>}"
    diverged=0; invalid=0
    for f in ref-buy.trace iceslab-buy.trace ref-admin.trace iceslab-admin.trace \
             ref-admin.jsonl iceslab-admin.jsonl; do
      [[ -f "$outdir/$f" ]] || { echo "stand: $outdir/$f is missing" >&2; invalid=1; }
    done
    [[ $invalid -eq 0 ]] || refuse "the differential left no complete set of files in $outdir; it proved nothing"
    compare_step() { # heading, script, args...
      local heading="$1" script="$2" rc=0
      shift 2
      echo; echo "===== $heading ====="
      python3 -I "$HERE/$script" "$@" || rc=$?
      case "$rc" in
        0) ;;
        1) diverged=1 ;;
        *) invalid=1 ;;
      esac
    }
    # Every comparison runs even after an earlier one found something: all three
    # are worth reading. A REFUSAL is not a finding, though - it must not end in
    # a zero (or a one) just because the message scrolled past.
    compare_step "call traces: the purchase" compare_traces.py \
      "$outdir/ref-buy.trace" "$outdir/iceslab-buy.trace"
    compare_step "call traces: the admin walk" compare_traces.py \
      "$outdir/ref-admin.trace" "$outdir/iceslab-admin.trace"
    compare_step "what the admin pages rendered" compare_admin.py \
      "$outdir/ref-admin.jsonl" "$outdir/iceslab-admin.jsonl"
    echo
    [[ $invalid -eq 0 ]] || refuse "a comparison refused to run - the differential proved nothing"
    if [[ $diverged -ne 0 ]]; then
      echo "stand: the halves differ (exit 1)"
      exit 1
    fi
    echo "stand: the halves agree (exit 0)"
    ;;

  differential)
    # Both halves, then the three comparisons, in one command. The halves cannot
    # run at once (the shop's container names are fixed), so this is a sequence,
    # and worth having for that: two halves typed hours apart are two different
    # experiments. Exit code as for `verdict`.
    shift
    outdir="${1:?usage: stand.sh differential <outdir>}"
    mkdir -p "$outdir"
    "$0" half iceslab "$outdir"
    "$0" half ref "$outdir"
    exec "$0" verdict "$outdir"
    ;;

  compare-admin)
    shift
    [[ $# -eq 2 ]] || die "usage: stand.sh compare-admin <reference.jsonl> <candidate.jsonl>"
    exec python3 -I "$HERE/compare_admin.py" "$1" "$2"
    ;;

  selftest)
    # The comparators against walks whose answer is known. Needs no stand, no
    # docker and no shop checkout: a comparator is a check, and an unchecked
    # check is how a differential reports something every run with nothing to
    # say whether it is true. The probes' verdicts are in it too: the churn
    # verdict and the shop's missing-route predicate.
    failed=0
    python3 -I "$HERE/compare_admin.py" --selftest || failed=1
    python3 -I "$HERE/churn_verdict.py" --selftest || failed=1
    python3 -I "$HERE/reads_as_missing_route.py" --selftest || failed=1
    exit $failed
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

  premium-probe)
    # POST /bandwidth-stats/nodes/usage, POST /users/bulk/update-squads and
    # POST /connections/drop, called by the SHOP rather than asserted with inject.
    #
    # They are capability routes served by the facade, and until a probe like this
    # none had been called by a real shop: their whole guard was the panel's own
    # tests. The shop reaches them only through a chain of preconditions, every
    # link of which fails QUIETLY: it must certify the Remnawave version the
    # facade declares (3.4.10 is in v3.8.6's `certified_versions`), a
    # premium-bearing subscription must be ALIVE (the admin walk deletes its
    # buyer, so a probe run after one finds no candidates), the tariff's premium
    # squad must resolve to nodes (or the worker logs "no accessible nodes" and
    # skips the accounting), and the worker must reach a FULL tick. An uncalled
    # route looks exactly like a route with nothing wrong, so every wait here ends
    # in a refusal (exit 2), never in a pass.
    #
    # Needs `up-iceslab` first (HIDE_NODES_USAGE=1 for the fallback variant).
    shift
    buyer="${PREMIUM_BUYER:-stand-premium@example.com}"
    [[ "$buyer" =~ ^[A-Za-z0-9._%+@-]+$ ]] || die "PREMIUM_BUYER=$buyer is not a plain address"
    buylog="${1:-${TMPDIR:-/tmp}/premium-probe-buy.log}"
    trace_file="${STAND_TRACE:-${TMPDIR:-/tmp}/premium-probe.trace}"

    # Leave both sides as they were found, whatever the outcome: the buyer on the
    # shop and on the panel (its usage rows too: the panel's delete is a soft one,
    # and the rows would stay attached to the deleted user) and the stand squads
    # granting nothing again, as the differential expects. The probe's own exit
    # code wins; a clean probe with dirty cleanup is not a pass. Subshells,
    # because `die` is an exit.
    premium_cleanup() {
      local rc=0
      ( purge_shop_user "$buyer" ) || rc=1
      ( purge_panel_user "$buyer" ) || rc=1
      ( panel_psql -c "delete from node_user_usage_history where user_id in
          (select id from users where email = '$buyer')" >/dev/null ) \
        || { echo "stand: could not remove the usage fixture of $buyer" >&2; rc=1; }
      ( clear_squad_profiles ) || rc=1
      return $rc
    }
    premium_exit() {
      local rc=$?
      trap - EXIT
      premium_cleanup || { (( rc )) || rc=1; }
      exit $rc
    }

    # Its own leftovers first, for the reason `half` does the same: our panel is
    # not a stand volume, so the buyer of the last probe is still there, and after
    # a demotion it is there in a state the shop reads as a DIFFERENT tariff,
    # answering `tariff_switch_required` to the purchase.
    purge_shop_user "$buyer"
    purge_panel_user "$buyer"
    trap premium_exit EXIT
    grant_squad_nodes
    drop_shop_squad_cache
    SHOP_URL="$SHOP_URL" SHOP_PORT="$SHOP_PORT" STAND_ENV="$RUNTIME_ENV" "$HERE/buy.sh" "$buyer" \
      > "$buylog" 2>&1 \
      || { tail -20 "$buylog" >&2; die "the premium probe's purchase failed; see $buylog"; }
    # AFTER the purchase, because the window has to start where the thing being
    # watched first becomes POSSIBLE. Marked before it, the wait below is
    # satisfied by the tick the restart triggers seconds earlier, a tick with no
    # subscription to meter, and the probe reports that the shop never called
    # the route.
    ppmark="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "stand: bought $buyer; waiting for a FULL tariff tick"
    wait_for_full_tick "$ppmark" || refuse "no full tariff tick in eleven minutes - the probe proved
nothing. A run that never reached the code under test is not a run that found
nothing, so this is a refusal, not a pass."

    # Which route the shop was MEANT to use depends on how the stand was brought
    # up; the probe reads that from the runtime env rather than from an argument
    # somebody may not have passed.
    if grep -q '^PANEL_API_URL=.*panel-shim' "$RUNTIME_ENV"; then
      want_source=multi_node_top_users
    else
      want_source=multi_node_usage
    fi
    "$0" trace "$trace_file" "$ppmark"
    if [[ "$want_source" == multi_node_top_users ]]; then
      # Both halves of the fallback: the hidden route was asked and refused, and
      # the route next to it was asked and answered. The halves have different
      # windows. The shop asks the hidden route ONCE per worker process, at its
      # capability probe before the purchase (the same one-shot as the
      # `Observed ... multi-node-usage=False` line below), so the 404 is looked
      # for from the worker's own start; only the answered fallback is bound to
      # the purchase window. A 404 required inside the window would fail a shop
      # that did exactly what it should.
      boot_trace="$trace_file.boot"
      "$0" trace "$boot_trace" >/dev/null
      grep -q '^POST /bandwidth-stats/nodes 404' "$boot_trace" \
        || die "the shop never asked the hidden route (POST /bandwidth-stats/nodes/usage, answered 404)"
      grep -q '^POST /bandwidth-stats/nodes 200' "$trace_file" \
        || die "the shop never got an answer from POST /bandwidth-stats/nodes/users, the fallback."
    else
      grep -q '^POST /bandwidth-stats/nodes 200' "$trace_file" \
        || die "the shop never called POST /bandwidth-stats/nodes.
Check the worker log for 'have no accessible nodes' (the tariff's premium squad
grants none) or for a version it will not certify."
    fi
    # The label `/bandwidth-stats/nodes` is shared by four operations, two of
    # them POST, so the trace alone cannot say WHICH. The worker names it:
    # `source=multi_node_usage` is the branch that consumes /nodes/usage,
    # `source=multi_node_top_users` the one that consumes /nodes/users, and
    # `complete=True` is the shop agreeing we answered for every node it asked
    # about, which is the contract that route is easiest to break. A line with
    # `source=cross_tick_cache` is the shop reusing an earlier answer; it proves
    # nothing and is skipped.
    plog="$(docker logs --since "$ppmark" remnawave-minishop-worker 2>&1)"
    snaps="$(grep -o 'premium_usage_snapshot .*' <<<"$plog" || true)"
    [[ -n "$snaps" ]] || die "no premium usage snapshot in the worker log; the route answered but
the shop did not build a snapshot from it."
    snap="$(grep "^premium_usage_snapshot source=$want_source " <<<"$snaps" | tail -1 || true)"
    [[ -n "$snap" ]] || die "no snapshot from $want_source, so this probe did not exercise the route
it exists for. The worker logged:
$snaps"
    echo "stand: $snap"
    grep -q 'complete=True' <<<"$snap" \
      || die "the shop calls the snapshot INCOMPLETE: $snap
It asked about a set of nodes and did not get an answer for all of them, which
is the silent half of the per-node billing path."
    if [[ "$want_source" == multi_node_top_users ]]; then
      # The fallback happening is the point, but the shop reaching it because it
      # OBSERVED our 404 as a missing route is the property the facade rests on.
      # If it read the 404 as a failed request instead, the capability would stay
      # unset and the shop would keep retrying the preferred route every tick.
      #
      # This line is one-shot per worker process (it is logged only when the
      # value CHANGES), so the window starts at the worker's own start, not at
      # the purchase mark: scoped to the purchase, a shop that had already
      # learned it on an earlier tick shows nothing, and the probe would blame
      # our 404 for a shop that read it correctly.
      wlog="$(docker logs --since "$(docker inspect -f '{{.State.StartedAt}}' remnawave-minishop-worker)" \
        remnawave-minishop-worker 2>&1)"
      grep -q 'Observed Remnawave capability multi-node-usage=False' <<<"$wlog" \
        || die "the shop never recorded /nodes/usage as missing. Our 404 did not read to it
as an absent route, so it will go on calling a route that is not there instead of
using the fallback."
      echo "stand: the shop observed multi-node-usage=False from our 404 and fell back"
    fi
    echo "stand: premium usage path exercised end to end via $want_source"

    # ---- stage 2: the demotion, which calls the other two routes ----
    #
    # `POST /users/bulk/update-squads` and `POST /connections/drop` are queued by
    # the SAME path: a premium subscriber over its premium allowance loses the
    # premium squad and has its sessions dropped (tariff_worker_premium_batches.py).
    # The desired squad set has to stay NON-EMPTY or this proves nothing: the shop
    # routes "clear the last squad" through per-user PATCHes instead, because
    # Remnawave 3.0.0 answers A088/500 to a bulk clear. So the tariff keeps its
    # base squad and loses only the premium one.
    tok="$(tr -d '[:space:]' < "$TOKEN_FILE")"
    pu="$(curl -sS -H "authorization: Bearer $tok" "$PANEL_URL/api/users/by-email/$buyer" \
      | python3 -I -c 'import json,sys
rows = (json.load(sys.stdin).get("users") or [])
print(rows[0]["id"] if rows else "")')"
    [[ -n "$pu" ]] || die "no panel user for $buyer; the purchase did not reach the panel"
    premium_nodes="$(curl -sS -H "authorization: Bearer $tok" \
      "$PANEL_URL/$PREFIX/api/internal-squads/$(stand_squad_ids --premium)/nodes")"
    fixture="$(python3 -I "$HERE/premium_fixture.py" "$HERE/tariffs.template.json" "$premium_nodes")" \
      || die "could not decide how much usage to write"
    read -r allowance node <<<"$fixture"
    # 20% over the allowance, on a node the premium squad actually grants: usage
    # anywhere else is not premium usage and the worker would be right to ignore
    # it. The day is UTC, as the facade reads it.
    panel_psql -c "insert into node_user_usage_history (node_id, date, user_id, bytes_in, bytes_out)
      values ('$node', (now() at time zone 'utc')::date, '$pu', $allowance, 0)
      on conflict (node_id, date, user_id) do update set bytes_in = excluded.bytes_in;" >/dev/null \
      || die "could not write the usage fixture"
    echo "stand: wrote $allowance bytes of premium usage for $pu on node $node"
    # The demotion is a ONE-SHOT event on the first full tick after the worker
    # restarts: marking after the restart missed it by seconds and then watched a
    # later tick do nothing. The window starts AFTER the usage fixture is written,
    # so a demotion inside it can only be this fixture's, and BEFORE the restart,
    # which is what triggers the tick and logs `connections-drop=True` (also
    # one-shot per process).
    dmark="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    drop_shop_squad_cache
    wait_for_full_tick "$dmark" || refuse "no full tariff tick in eleven minutes for the demotion stage"
    "$0" trace "$trace_file.demote" "$dmark"
    dlog="$(docker logs --since "$dmark" remnawave-minishop-worker 2>&1)"
    grep -q 'premium_squad_write_batch' <<<"$dlog" \
      || die "the shop never demoted the over-limit subscriber. Check the tick log for
'have no accessible nodes', or whether the usage landed on a node the premium
squad grants."
    # The bulk route's trace label is `/users`, shared with other operations, so
    # the trace CANNOT say it was called. The shop's own metric can, and it names
    # the selector: `userIds` is the numeric rw3 one.
    grep -q 'panel_squad_bulk .*selector=userIds' <<<"$dlog" \
      || die "the squad change did not go through POST /users/bulk/update-squads:
$(grep -o 'panel_squad_bulk .*' <<<"$dlog" | tail -1)
A per-user PATCH fallback here means the bulk route answered in a shape the shop
rejected: check the affected-rows key."
    grep -q '^POST /connections ' "$trace_file.demote" \
      || die "the shop never called POST /connections/drop after limiting premium access"
    grep -q 'connections-drop=True' <<<"$dlog" \
      || die "the shop did not record connections-drop as available; it will stop asking"
    echo "stand: $(grep -o 'panel_squad_bulk .*' <<<"$dlog" | tail -1)"
    echo "stand: $(grep -o 'panel_connection_drop .*' <<<"$dlog" | tail -1)"
    # The point of the whole stage, checked on the panel rather than in the log:
    # premium squad gone, base squad still there.
    curl -sS -H "authorization: Bearer $tok" "$PANEL_URL/api/users/$pu" \
      | python3 -I "$HERE/assert_demoted.py" "$(stand_squad_ids | tr '\n' ' ')" \
      || die "the panel does not show the demotion the shop reported"
    echo "stand: premium demotion exercised end to end (bulk squads + connections drop)"
    ;;

  churn-probe)
    # The fleet sync of the shop walks every page of /users/stream to decide who
    # still exists, and a user it never sees is PANEL_USER_NOT_FOUND:
    # is_active=False, a paid subscription quietly ended. With offset paging, one
    # row deleted AHEAD of the cursor mid-walk shifts the tail by one and exactly
    # one user is never returned; the facade's cursor is a keyset, which nothing
    # ahead of it can move.
    #
    # The shop reports "Panel records checked" at the end of a sync, and that
    # number is the finding. Seed the panel, make the walk slow enough to be
    # inside of (the shop's own page-size and page-delay settings, set by
    # `CHURN_PAGING=1 ./stand.sh up-iceslab`), delete the user the walk collected
    # FIRST, and count:
    #
    #   keyset  + churn : N     (the deleted one was collected before it went)
    #   offset  + churn : N-1   (and the missing one is somebody still alive)
    #
    # The first thing the verdict decides is whether this run proved anything: a
    # walk that fitted in one page followed no cursor, and a deletion outside the
    # walk crossed nothing. Both are a REFUSAL (exit 2), not a pass; the earlier
    # version of this probe passed in exactly those cases. Exit 0 the shop lost
    # nobody, 1 it lost someone, 2 the run proved nothing.
    shift
    seed="${1:-40}"
    [[ "$seed" =~ ^[0-9]+$ ]] && (( seed >= 2 )) || die "usage: stand.sh churn-probe [users >= 2]"
    tok="$(tr -d '[:space:]' < "$TOKEN_FILE")"
    jar="$(mktemp)"; delfile="$(mktemp)"

    # Its own users, gone, however the probe ends: after the verdict, so a failed
    # probe can still be looked at, but not best effort. The probe's own exit code
    # wins (a refusal must not be downgraded by the tidying); a clean probe with
    # dirty cleanup is not a pass.
    churn_exit() {
      local rc=$?
      trap - EXIT
      rm -f "$jar" "$delfile"
      purge_churn_users || { (( rc )) || rc=1; }
      exit $rc
    }
    trap churn_exit EXIT

    purge_churn_users || die "the panel is not clean of churn-probe users before the probe starts"
    echo "stand: seeding $seed users on the panel"
    for i in $(seq 1 "$seed"); do
      for attempt in 1 2 3; do
        code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $tok" \
          -H 'content-type: application/json' \
          -d "{\"username\":\"churn-probe-$(printf '%04d' "$i")\",\"expireDays\":30}" \
          "$PANEL_URL/api/users")" || die "could not seed churn-probe-$i"
        [[ "$code" == 429 ]] || break
        sleep 20
      done
      [[ "$code" == 2* ]] || die "seeding churn-probe-$i answered HTTP $code"
    done
    total="$(curl -sS -H "authorization: Bearer $tok" "$PANEL_URL/$PREFIX/api/users?size=1" \
      | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["response"]["total"])')"
    echo "stand: $total users on the panel"

    # The stream is newest first, so the last user seeded is on page one:
    # collected before the deletion, however the walk is paged.
    victim_name="churn-probe-$(printf '%04d' "$seed")"
    victim="$(curl -sS -H "authorization: Bearer $tok" \
      "$PANEL_URL/api/users/by-username/$victim_name" \
      | python3 -I -c 'import json,sys
d=json.load(sys.stdin)
print(d.get("id") or d["users"][0]["id"])')"

    csrf="$(shop_admin_session "$jar")"
    mark="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    # The shop's sync is QUEUED (the POST returns at once) and its walk starts
    # when the worker picks it up, so the deletion is timed from the walk's first
    # page, read off panel-front's access log, not from the POST.
    (
      for _ in $(seq 1 120); do
        if grep -q '/users/stream' <<<"$(docker logs --since "$mark" remnawave-minishop-panel-front 2>&1)"; then
          sleep "${CHURN_DELETE_AFTER:-4}"
          date +%s.%N > "$delfile"
          curl -sS -o /dev/null -X DELETE -H "authorization: Bearer $tok" "$PANEL_URL/api/users/$victim"
          echo "stand: deleted $victim_name mid-walk"
          exit 0
        fi
        sleep 0.5
      done
      echo "stand: the shop's walk never started (no /users/stream request in 60 s)" >&2
    ) &
    curl -sS -b "$jar" -H 'content-type: application/json' -H "X-CSRF-Token: $csrf" \
      -X POST "$SHOP_URL/api/admin/sync" -d '{}' > /dev/null || die "could not ask the shop for a sync"
    wait
    [[ -s "$delfile" ]] || refuse "the deletion was never issued: the shop's sync did not start a walk
in 60 s. The run proved nothing."
    deleted_at="$(cat "$delfile")"

    # The count appears when the sync ends. Not before the deletion: an earlier
    # sync's line (the worker syncs on its own) would be this probe's answer
    # taken mid-walk. Bounded: a sync that never ends is a refusal, not a hang.
    since_del="$(date -u -d "@${deleted_at%.*}" +%Y-%m-%dT%H:%M:%SZ)"
    checked=""
    for _ in $(seq 1 180); do
      checked="$(grep -oE 'Panel records checked: [0-9]+' <<<"$(docker logs --since "$since_del" remnawave-minishop-worker 2>&1)" \
        | tail -1 | grep -oE '[0-9]+' || true)"
      [[ -n "$checked" ]] && break
      sleep 1
    done
    [[ -n "$checked" ]] || refuse "the shop never reported 'Panel records checked' after the deletion (3 minutes)"
    echo
    echo "stand: panel had $total users; one was deleted after the walk collected it"
    # Delegated: the verdict's first question is whether this run proved anything.
    verdict=0
    docker logs --since "$mark" --timestamps remnawave-minishop-panel-front 2>&1 \
      | python3 -I "$HERE/churn_verdict.py" "$total" "$checked" "$deleted_at" \
      || verdict=$?
    # `|| verdict=$?` and not a bare assignment: under `set -e` a failing pipeline
    # ends the script THERE. The cleanup is the EXIT trap, so it runs either way.
    exit $verdict
    ;;

  webhook-probe)
    # HMAC body integrity through a REAL proxy. This probes the SHOP and the
    # PROXY, not the panel: the bodies are composed here, by hand, in the shape
    # the facade emits (remnawave.webhook.ts), and no panel code runs.
    #
    # The facade signs the raw body, so the shop's check passes only if the bytes
    # that arrive are the bytes that were signed - and in production the two are
    # never directly connected. Everywhere else this stand speaks plain HTTP
    # host-to-container, which is the one topology in which this cannot fail.
    # So: the same signed request, sent directly AND through a TLS nginx, must both
    # be accepted; and a body altered by one byte after signing must be rejected
    # through the same proxy. Without that last one the probe would pass against a
    # proxy that accepted anything.
    ensure_webhook_cert
    "${compose_iceslab[@]}" --profile tls up -d --wait webhook-tls
    secret="$(sed -n 's/^PANEL_WEBHOOK_SECRET=//p' "$RUNTIME_ENV" | tail -1)"
    [[ -n "$secret" ]] || die "no PANEL_WEBHOOK_SECRET in $RUNTIME_ENV"
    tls_port="${WEBHOOK_TLS_PORT:-8444}"
    direct="http://127.0.0.1:$SHOP_PORT/webhook/panel"
    proxied="https://127.0.0.1:$tls_port/webhook/panel"
    fail=0
    sign() { printf '%s' "$1" | openssl dgst -sha256 -hmac "$secret" -hex | sed 's/.*= //'; }
    probe() { # label url body expected [sent-body]
      local label="$1" url="$2" body="$3" want="$4" sent="${5:-$3}" code
      code="$(curl -sk -o /dev/null -w '%{http_code}' -X POST "$url" \
        -H 'content-type: application/json' -H "X-Remnawave-Signature: $(sign "$body")" -d "$sent")"
      if [[ "$code" == "$want" ]]; then
        printf '  %-46s %s\n' "$label" "$code"
      else
        printf '  %-46s %s  EXPECTED %s\n' "$label" "$code" "$want"; fail=1
      fi
    }

    # ASCII-escaped exactly as buildRemnaWebhookBody does, including the
    # non-ASCII case that motivates it.
    ascii='{"name":"user.expired","payload":{"user":{"uuid":"1","telegramId":null,"email":"probe@example.test","expireAt":"2030-01-01T00:00:00.000Z"}},"meta":{}}'
    escaped='{"name":"user.expired","payload":{"user":{"uuid":"1","telegramId":null,"email":"почта@example.test","expireAt":"2030-01-01T00:00:00.000Z"}},"meta":{}}'

    wmark="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "stand: webhook signature through a real proxy"
    probe "ascii body, direct to the shop"        "$direct"  "$ascii"   200
    probe "ascii body, through TLS nginx"         "$proxied" "$ascii"   200
    probe "escaped non-ascii body, direct"        "$direct"  "$escaped" 200
    probe "escaped non-ascii body, through nginx" "$proxied" "$escaped" 200
    # One byte different from what was signed: what a body-rewriting proxy
    # would produce.
    probe "body altered after signing, through nginx" "$proxied" "$ascii" 401 "$ascii "

    # The other event names the facade sends, through the same proxy. The shop
    # answers 200 to ANY correctly signed event and decides afterwards whether it
    # acts on it, so the status alone says nothing about the name: its backend
    # logs "Panel webhook event received: <name>" for each one it took in.
    # (Whether it ACTS needs a subscriber that exists: the shop's contract gate in
    # the panel's own tests covers that.)
    stage='{"name":"user.expires_in_24_hours","payload":{"user":{"uuid":"1","telegramId":null,"email":"probe@example.test","expireAt":"2030-01-01T00:00:00.000Z"}},"meta":{}}'
    # A WireGuard tunnel shown to the shop as a device: `wg:<id>` as the hwid.
    wg='{"name":"user_hwid_devices.added","payload":{"user":{"uuid":"1","telegramId":null,"email":"probe@example.test","expireAt":"2030-01-01T00:00:00.000Z"},"hwidUserDevice":{"hwid":"wg:00000000-0000-4000-8000-000000000001","platform":"WireGuard/AmneziaWG","osVersion":null,"deviceModel":"10.8.0.2 / fd00::2","createdAt":"2030-01-01T00:00:00.000Z"}},"meta":{}}'
    probe "24-hour stage event, through nginx"        "$proxied" "$stage" 200
    probe "new device event (wg: tunnel), through nginx" "$proxied" "$wg" 200
    wlog="$(docker logs --since "$wmark" remnawave-minishop-backend 2>&1)"
    for ev in user.expired user.expires_in_24_hours user_hwid_devices.added; do
      if grep -q "Panel webhook event received: $ev" <<<"$wlog"; then
        printf '  %-46s %s\n' "the shop took in $ev" taken
      else
        printf '  %-46s %s\n' "the shop took in $ev" "NOT IN ITS LOG"; fail=1
      fi
    done

    # And the failure the ASCII escaping exists to prevent, shown rather than
    # asserted: the same payload as raw UTF-8 put through a charset transcoding,
    # against the same payload escaped. Only the first breaks, because only the
    # first has bytes above 0x7F for a proxy to change. This goes to the shop
    # directly: the bytes are what is being varied.
    SHOP_PORT="$SHOP_PORT" python3 -I "$HERE/transcode_probe.py" "$secret" || fail=1

    [[ $fail -eq 0 ]] || { echo "stand: the signature did not survive the path it will take in production" >&2; exit 1; }
    echo "stand: the signed body survives a TLS reverse proxy unchanged"
    ;;

  full)
    # The differential plus every probe, in one command. Slow, and deliberately
    # so: a probe that has to be remembered is a probe that does not get run.
    # `premium-probe` is two full tariff ticks at five minutes each, about thirteen
    # minutes a pass, and it runs twice (the shop's usual route, then the fallback
    # behind `panel-shim`); budget about an hour and a half in all.
    #
    # Ordered: the differential leaves the REFERENCE half up, so the probes, which
    # test OUR facade, bring the iceslab half back first. Each env switch is bound
    # to the containers when they are CREATED, so a switch means a bring-up:
    #   plain   - churn refusal, webhook, premium (the shop's own route)
    #   paging  - churn
    #   shim    - premium fallback
    # The stand's env switches are cleared for the plain bring-ups, so a caller's
    # exported CHURN_PAGING or HIDE_NODES_USAGE cannot leak into them.
    shift
    outdir="${1:?usage: stand.sh full <outdir>}"
    mkdir -p "$outdir"
    # Every stage runs and is tabled at the end. `differential` exiting 1 is a
    # REPORTED divergence (on this stand a known one: our purchase trace has more
    # calls than the reference's, see the README), not a refusal, so it does not
    # stop the run; exit 2 from it, or any failing probe, still fails the run.
    stages=()
    fail=0
    stage() { # name expected-rc command...  (any other rc fails the run)
      local name="$1" want="$2" rc=0; shift 2
      "$@" || rc=$?
      if [[ $rc -eq $want ]]; then
        if [[ $want -ne 0 ]]; then stages+=("$name|0|ok (refused, as it must)"); else stages+=("$name|0|ok"); fi
      else
        [[ $rc -ne 0 ]] || rc=1
        stages+=("$name|$rc|failed")
        (( fail )) || fail=$rc
      fi
    }

    drc=0; "$0" differential "$outdir" || drc=$?
    case $drc in
      0) stages+=("differential|0|identical") ;;
      1) stages+=("differential|1|divergence (reported, does not stop the run)") ;;
      *) stages+=("differential|$drc|refusal or failure"); fail=$drc ;;
    esac

    bring_up() { # label env...
      local label="$1"; shift
      "$0" reset >/dev/null 2>&1 || true
      env -u CHURN_PAGING -u HIDE_NODES_USAGE "$@" "$0" up-iceslab > "$outdir/$label-up.log" 2>&1 \
        || { tail -20 "$outdir/$label-up.log" >&2; die "could not bring the stand up for $label"; }
    }

    echo; echo "===== the churn probe refuses a walk of one page ====="
    bring_up plain
    # It must refuse (2), or it can pass on nothing.
    stage "churn-probe (no paging)" 2 "$0" churn-probe

    echo; echo "===== signed webhook through a real TLS proxy ====="
    stage "webhook-probe" 0 "$0" webhook-probe

    # Same stand: the premium probe cleans up after itself on both sides, and the
    # webhook probe leaves nothing behind, so another bring-up here would cost
    # minutes to prove nothing.
    echo; echo "===== premium accounting and demotion (three capability routes) ====="
    stage "premium-probe" 0 env STAND_TRACE="$outdir/premium.trace" "$0" premium-probe "$outdir/premium-buy.log"

    echo; echo "===== the churn probe, with the walk paged ====="
    bring_up paging CHURN_PAGING=1
    stage "churn-probe (paging)" 0 "$0" churn-probe

    # A bring-up of its own: the shim is in the PATH to the panel, so it has to be
    # there before the shop's containers are created, and every other probe must
    # NOT be talking through it.
    echo; echo "===== the fallback route, with /nodes/usage hidden ====="
    bring_up shim HIDE_NODES_USAGE=1
    stage "premium-probe (fallback)" 0 env STAND_TRACE="$outdir/premium-fallback.trace" "$0" premium-probe "$outdir/premium-fallback-buy.log"

    # Exit: 0 all clear; 1 when the only non-zero is the differential's
    # divergence; otherwise the failing code (the first one, in stage order).
    echo; printf '%-28s %-5s %s\n' stage exit meaning
    for row in "${stages[@]}"; do
      IFS='|' read -r n c m <<<"$row"; printf '%-28s %-5s %s\n' "$n" "$c" "$m"
    done
    if (( fail )); then echo "stand: full run FAILED (exit $fail)"; exit "$fail"; fi
    if (( drc == 1 )); then echo "stand: full run finished; only the differential diverged (exit 1)"; exit 1; fi
    echo "stand: full run passed; run './stand.sh differential <dir>' again to check the probes left nothing behind"
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
  check <iceslab|ref>
               re-check what up-* asserts (admin seeded, worker has a panel key)
  seed-tariffs store the tariff catalogue on the half that is up (up-* does it)
  half <iceslab|ref> <outdir>
               one half end to end: reset, up, node traffic, buy, admin walk;
               writes <half>-buy.{log,trace} and <half>-admin.{log,jsonl,trace}
  differential <outdir>
               both halves, then verdict. Exit 0 agree, 1 differ, 2 refused
  verdict <outdir>
               the three comparisons on a differential's files (no docker)
  compare-admin a b
               diff two admin walks (what the pages rendered)
  selftest     the comparators against known answers (no stand, no docker)
  subpage <subscription-token>...
               the panel's install document through the shop's own validator
               (needs the shop checkout and the panel; no docker)
  churn-probe [users]
               a user deleted inside the shop's paged walk of /users/stream: does
               the shop lose anyone? Bring the stand up with CHURN_PAGING=1 first.
               Exit 0 nobody lost, 1 someone lost, 2 the run proved nothing
  webhook-probe
               signed webhook bodies through a TLS nginx to the shop; checks the
               shop and the proxy, not the panel
  premium-probe [buy-log]
               the shop's premium accounting and demotion against the facade
               (about 13 minutes); with HIDE_NODES_USAGE=1 on up-iceslab it must
               take the fallback route. Exit 2: the run proved nothing
  full <outdir>
               differential, then every probe (an hour and a half)

Environment: MINISHOP_DIR (required; checkout of remnawave-minishop at $SHOP_TAG),
PANEL_URL (http://127.0.0.1:3000), PANEL_TOKEN_FILE (.runtime/panel-token),
REMNAWAVE_COMPAT_PREFIX (rw), SHOP_PORT (8080), PANEL_BACKEND_ADDR (docker bridge
gateway:3000), PANEL_FRONT_PORT (8087), STAND_BUYER.

Probe switches for up-iceslab: CHURN_PAGING=1 (CHURN_PAGE_SIZE 5, CHURN_PAGE_DELAY 1.0),
HIDE_NODES_USAGE=1. Probe settings: CHURN_DELETE_AFTER (4 s), PREMIUM_BUYER,
WEBHOOK_TLS_PORT (8444), PANEL_SHIM_PORT (8086), PANEL_DB_CONTAINER/USER/NAME.

One at a time: the two halves share container names.
EOF
    exit 2 ;;
esac
