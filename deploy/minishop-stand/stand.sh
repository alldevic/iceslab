#!/usr/bin/env bash
# Drive the Mini Shop against either this panel's Remnawave-compat facade or a
# real Remnawave, for the differential test described in README.md next to this
# file.
#
# Everything lives here, nothing is written into the shop's checkout: the shop
# stays unmodified by design, so its compose files are referenced by absolute
# path and every override and env file is ours.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHOP="${MINISHOP_DIR:-/home/stdfo/workspace/minishop-361}"
TOKEN_FILE="${PANEL_TOKEN_FILE:-/var/tmp/iceslab-vmlab/minishop-panel-token}"
PANEL_URL="${PANEL_URL:-http://127.0.0.1:3000}"
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
export ICESLAB_REPO="${ICESLAB_REPO:-$(cd "$HERE/../.." && pwd)}"
iceslab_gateway_ip() {
  docker network inspect bridge \
    --format '{{ (index .IPAM.Config 0).Gateway }}' 2>/dev/null || echo 172.17.0.1
}
export ICESLAB_BACKEND_ADDR="${ICESLAB_BACKEND_ADDR:-$(iceslab_gateway_ip):3000}"

die() { echo "stand: $*" >&2; exit 1; }
# A run that never reached the code under test. Distinct from die() on purpose:
# "we did not wait long enough" must not read like "the shop did not call it".
refuse() { echo "stand: $*" >&2; exit 2; }

[[ -d "$SHOP" ]] || die "no minishop checkout at $SHOP (set MINISHOP_DIR)"
[[ -f "$SHOP/docker-compose-dev.yml" ]] || die "$SHOP is not a minishop checkout"

# The two stands share container names, so they cannot run at the same time.
# Their shop DATABASES are different volumes (the reference override renames
# them with a -323 suffix), which is what makes the two runs comparable instead
# of cumulative - but only one can be up.
# The project name is PINNED. Compose derives it from the project directory, so
# pointing MINISHOP_DIR at a different checkout (v3.6.1 vs dev) would silently
# make a second project: `reset` would tear down an empty one while the running
# stand kept its containers, and the next `up` would collide on their names. The
# two stands already cannot run at the same time, so one name is the truth.
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
# the services explicitly rather than relying on that.
SHOP_SERVICES=(postgres redis migrate backend worker frontend)
# The panel's own frontend image, brought up alongside the shop so the shop
# reaches the facade the way a real deploy does — through nginx. See item 6 in
# stand.override.yml: without it this stand could not have caught §54.2.
STAND_SERVICES=(panel-front)
# Every optional profile, for teardown. Naming them one by one is how a
# container gets left running: `down` has to cover what any `up` may have
# started, not what this particular invocation started.
STAND_PROFILES=(--profile seed --profile tls --profile shim)

fill_token() {
  [[ -f "$TOKEN_FILE" ]] || die "no panel API token at $TOKEN_FILE
Mint one and save it:
  curl -sX POST $PANEL_URL/api/api-tokens -H \"authorization: Bearer \$ADMIN_JWT\" \\
    -H 'content-type: application/json' -d '{\"name\":\"minishop-stand\"}' \\
    | python3 -c 'import json,sys;print(json.load(sys.stdin)[\"token\"])' > $TOKEN_FILE"
  local tok
  tok="$(tr -d '[:space:]' < "$TOKEN_FILE")"
  [[ "$tok" == icp_* ]] || die "$TOKEN_FILE does not hold an icp_ token"
  # Into a gitignored copy, not the template: the template is committed and a
  # credential must not be, and an env file rewritten in place shows up as a
  # dirty tree after every run.
  mkdir -p "$HERE/.runtime"
  sed -e "s|^PANEL_API_KEY=.*|PANEL_API_KEY=$tok|" \
      -e "s|^APP_ENV_FILE=.*|APP_ENV_FILE=$RUNTIME_ENV|" \
      "$HERE/iceslab.env" > "$RUNTIME_ENV"
  chmod 600 "$RUNTIME_ENV"
}

# The reference half's env, with the panel token the shop's own dev fixture
# seeds - because the shop's reference override sets PANEL_API_KEY on the
# BACKEND ONLY.
#
# The worker inherits nothing but `env_file`, so on the reference half it ran
# with an empty key and got 401 on every call it ever made. That is the whole of
# `panel_sync: failed` on that half, and downstream of it: a seeded user the
# shop cannot read (`traffic_strategy_lock_reason: panel_unavailable`), a
# subscription with no URL, and a `GET /users` count that has nothing to do with
# ours. Half of the reference was answering the shop unauthenticated, and the
# differential was comparing our working half against it.
#
# Taken from the shop's compose, not pasted here: it is that file's default for
# REMNAWAVE_DEV_API_TOKEN, and a copy would be a second place to be wrong.
fill_ref_token() {
  local compose="$SHOP/docker-compose.remnawave-dev.yml" tok
  [[ -f "$compose" ]] || die "no $compose - cannot learn the reference panel's token"
  tok="$(sed -n 's/.*PANEL_API_KEY: *${REMNAWAVE_DEV_API_TOKEN:-\([^}]*\)}.*/\1/p' "$compose" | head -1)"
  [[ -n "$tok" ]] || die "no REMNAWAVE_DEV_API_TOKEN default in $compose
Without it the shop's worker talks to the reference panel unauthenticated and
every sync on that half fails - which the differential then reports as though it
were something about our facade."
  mkdir -p "$HERE/.runtime"
  sed -e "s|^PANEL_API_KEY=.*|PANEL_API_KEY=$tok|" \
      -e "s|^APP_ENV_FILE=.*|APP_ENV_FILE=$RUNTIME_REF_ENV|" \
      "$HERE/remnawave-ref.env" > "$RUNTIME_REF_ENV"
}

# A self-signed cert for the webhook TLS front. Regenerated when missing, never
# committed: it exists so the stand can put a REAL proxy in the path, not to be
# trusted by anything.
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

# An admin session on the shop, as admin.sh gets one. Prints "<cookiejar> <csrf>".
shop_admin_session() {
  local jar="$1" email="${ADMIN_EMAIL:-runes.admin@example.com}" req code ver csrf
  req="$(curl -sS -b "$jar" -c "$jar" -H 'content-type: application/json' \
    -X POST "${SHOP_URL:-http://127.0.0.1:8082}/api/auth/email/request" -d "{\"email\":\"$email\"}")"
  code="$(python3 -c 'import json,sys,re
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
  [[ -n "$code" ]] || die "no verification code for the admin session"
  ver="$(curl -sS -b "$jar" -c "$jar" -H 'content-type: application/json' \
    -X POST "${SHOP_URL:-http://127.0.0.1:8082}/api/auth/email/verify" -d "{\"email\":\"$email\",\"code\":\"$code\"}")"
  csrf="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("csrf_token",""))' "$ver")"
  [[ -n "$csrf" ]] || die "no csrf token for the admin session"
  printf '%s' "$csrf"
}

# The shop's demo seed is EXPECTED to exit non-zero at v3.6.1, so its exit code
# says nothing about whether the admin user landed. Three statements, no
# --single-transaction: users, subscriptions, then the payments INSERT that
# trips the shop's own `funding_source NOT NULL`. Check the row, not the code -
# a silently unseeded admin makes every admin route answer 403, which reads
# like an auth defect in the facade and is not one.
assert_admin_seeded() {
  local which="$1" env_file admin_id out
  case "$which" in
    iceslab) env_file="$RUNTIME_ENV"; set -- "${compose_iceslab[@]}" ;;
    ref)     env_file="$RUNTIME_REF_ENV"; set -- "${compose_ref[@]}" ;;
    *) die "assert_admin_seeded: unknown stand $which" ;;
  esac
  admin_id="$(sed -n 's/^ADMIN_IDS=//p' "$env_file" | tail -1 | cut -d, -f1 | tr -d '[:space:]')"
  [[ -n "$admin_id" ]] || die "no ADMIN_IDS in $env_file"
  out="$("$@" exec -T postgres sh -ec \
    "psql -qtAX -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -c \
     \"select user_id, email from users where telegram_id = $admin_id\"")" \
    || die "could not query the shop database for the admin user"
  [[ -n "${out//[[:space:]]/}" ]] || die "the shop's demo seed left no user with telegram_id=$admin_id
ADMIN_IDS names it, so every /api/admin route will answer 403 and the walkthrough
will compare two forbidden responses."
  echo "stand: admin seeded -> $out"
}

# The squads the tariff template names, created on OUR panel if absent.
#
# Only this half needs it. The reference stand's own seed (deploy/dev/
# seed-remnawave.sql, "match the public development tariff fixture") inserts
# `MiniShop Standard` and `MiniShop Premium` with fixed uuids, so the reference
# panel arrives with them already - and if a later release stops doing that,
# seed_tariffs.py refuses by name rather than storing a catalogue that points
# nowhere.
#
# The names come from the template, not from a second list here: a catalogue
# naming a squad this never creates would fail at seed time, and one creating a
# squad no tariff names would be litter on a panel the stand does not own.
ensure_panel_squads() {
  local tok names name code
  tok="$(tr -d '[:space:]' < "$TOKEN_FILE")"
  names="$(python3 "$HERE/squad_names.py" "$HERE/tariffs.template.json")" \
    || die "could not read the squad names out of tariffs.template.json"
  [[ -n "$names" ]] || die "tariffs.template.json names no squad, so no tariff can move one"
  while read -r name; do
    [[ -n "$name" ]] || continue
    code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
      -H "authorization: Bearer $tok" -H 'content-type: application/json' \
      -d "$(python3 -c 'import json,sys; print(json.dumps({"name": sys.argv[1]}))' "$name")" \
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
#
# `premium-probe` attaches a profile so the squads resolve to nodes, and that
# attachment OUTLIVES the run: our panel is not a stand volume. The differential
# after a probe then had our half metering premium while the reference - whose
# panel has no nodes to grant - skipped it, which is a divergence the fixture
# invented. Third time this session that leftover state on our panel changed the
# next run; the rule is the same each time, so it is applied the same way: a run
# establishes the fixture it needs instead of inheriting one.
#
# Cheap and unconditional rather than conditional on what is attached: reading
# first and writing only on a difference would make the common path silent about
# what it did.
clear_squad_profiles() {
  local tok sid
  tok="$(tr -d '[:space:]' < "$TOKEN_FILE")"
  while read -r sid; do
    [[ -n "$sid" ]] || continue
    curl -sS -o /dev/null -X PUT -H "authorization: Bearer $tok" \
      -H 'content-type: application/json' -d '{"profileIds":[]}' \
      "$PANEL_URL/api/squads/$sid" || die "could not clear profiles on squad $sid"
  done <<< "$(stand_squad_ids)"
  echo "stand: squad profiles cleared (premium-probe grants them when it needs them)"
}

# The uuids of the squads the tariff template names, on this panel. With
# --premium, only the squads a tariff hands out as its premium segment.
stand_squad_ids() {
  local tok names
  tok="$(tr -d '[:space:]' < "$TOKEN_FILE")"
  names="$(python3 "$HERE/squad_names.py" "$HERE/tariffs.template.json" "$@" | tr '\n' '|')" \
    || die "could not read the squad names out of the tariff template"
  curl -sS -H "authorization: Bearer $tok" "$PANEL_URL/$PREFIX/api/internal-squads" \
    | python3 "$HERE/squad_ids.py" "$names"
}

# The shop caches "which nodes does this squad grant" in TWO places, and a
# fixture change is invisible until BOTH are dropped, in this order.
#
# AsyncTTLCache keeps an in-process copy AND a Redis copy
# (minishop-iceslab-stand:cache:panel:squads:nodes:<uuid>, 300s). Restarting the
# worker clears only the first; deleting the keys clears only the second, and if
# the worker has already loaded the stale value it goes on using it. The probe
# that first passed here did so because enough time had gone by, not because the
# restart it performed did anything - which is the same class of mistake as a
# green test that is green for the wrong reason, made while building a probe
# against exactly that.
#
# This is the SHOP's Redis (a stand container), never the panel's: the panel and
# the test suite share one Redis instance, and a prefix-scan delete there reaches
# into a running panel.
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

# psql inside the panel's database container. Read from the repo's own .env
# rather than pinned here, so it cannot drift from the panel this stand drives.
panel_psql() {
  local url user db
  url="$(sed -n 's/^DATABASE_URL=//p' "$HERE/../../.env" | tr -d '"' | tail -1)"
  [[ -n "$url" ]] || die "no DATABASE_URL in $HERE/../../.env - cannot write the usage fixture"
  user="$(sed -E 's#^[a-z]+://([^:]+):.*#\1#' <<<"$url")"
  db="$(sed -E 's#.*/([^/?]+)(\?.*)?$#\1#' <<<"$url")"
  [[ -n "$user" && -n "$db" ]] || die "could not read a user and database out of DATABASE_URL"
  docker exec "${PANEL_DB_CONTAINER:-iceslab-postgres-test}" \
    psql -U "$user" -d "$db" -qtAX "$@"
}

# A squad with no NODES is a squad the shop quietly refuses to meter.
#
# Called from `premium-probe`, NOT from `up-*`, and that placement is the point:
# only our half's squads can be given nodes (the reference panel has none to
# give), so doing it during a differential would make our half meter premium
# while the reference skips it - one more divergence line per run, explaining
# nothing about the facade. The probes that need a richer fixture than the
# comparison does are separate here for exactly this reason; see webhook-probe
# and churn-probe.
#
# A bare group grants no profiles, so the facade's accessible-nodes answers []
# ("the minishop treats [] the same as an error"), and the tariff worker logs
# `Premium squads for tariff <key> have no accessible nodes` and skips premium
# accounting entirely - which is the only thing that ever calls
# POST /bandwidth-stats/nodes/usage. The stand ran for a day with squads like
# that and reported no problem, because nothing was asking.
#
# So: give each of them a profile that actually resolves to nodes, and then
# CHECK that it did. Node status does not matter here - the facade maps
# group -> profiles -> bindings -> nodes without filtering on it - which is why
# a lab full of disabled and unreachable nodes is still a valid fixture.
grant_squad_nodes() {
  local tok squads profile sid nodes
  tok="$(tr -d '[:space:]' < "$TOKEN_FILE")"
  squads="$(stand_squad_ids)" || die "could not list the panel's squads"
  profile="$(curl -sS -H "authorization: Bearer $tok" "$PANEL_URL/api/profiles" \
    | python3 -c 'import json,sys
d = json.load(sys.stdin)
rows = d.get("profiles", d)
print("\n".join(p["id"] for p in rows if p.get("id")))')" || die "could not list the panel's profiles"
  [[ -n "$profile" ]] || die "the panel has no profile, so no squad can grant a node
and the shop will skip premium accounting without calling anything."
  while read -r sid; do
    [[ -n "$sid" ]] || continue
    # Every profile: which one carries the node bindings is lab state, not
    # something this should encode, and the check below is what decides.
    curl -sS -o /dev/null -w '' -X PUT -H "authorization: Bearer $tok" \
      -H 'content-type: application/json' \
      -d "$(python3 -c 'import json,sys; print(json.dumps({"profileIds": sys.argv[1].split()}))' "$profile")" \
      "$PANEL_URL/api/squads/$sid" || die "could not attach a profile to squad $sid"
    nodes="$(curl -sS -H "authorization: Bearer $tok" \
      "$PANEL_URL/$PREFIX/api/internal-squads/$sid/nodes" \
      | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("response") or []))')"
    (( nodes > 0 )) || die "squad $sid still grants no node after attaching every profile.
The shop logs 'Premium squads ... have no accessible nodes' and skips premium
accounting, so POST /bandwidth-stats/nodes/usage is never called and the run
proves nothing about it. Bind a profile to a node on the panel first."
    echo "stand: squad $sid grants $nodes node(s)"
  done <<< "$squads"
}

# The tariff catalogue itself, through the shop's own admin API. Both halves,
# same code, resolved against whichever panel the shop is pointed at.
seed_tariffs() {
  python3 "$HERE/seed_tariffs.py" \
    || die "the tariff catalogue was not configured; the two admin actions that
reach the panel through a tariff would answer 400 and 502 on both halves, and
the differential would compare two refusals."
}

# Every address the stand's own runs put on OUR panel.
#
# The buyer, plus the shop's demo users: its admin walkthrough ends in
# `POST /admin/sync`, and that sync CREATES a panel user for each seeded shop
# user that has none. On the reference half those users come from
# seed-remnawave.sql and go away with the volume; on ours they stay, because our
# panel is not a stand volume - so the NEXT run finds them, the shop rebinds the
# seeded subscription from the uuid its own fixture hardcodes to the real panel
# user, and the admin page for that user renders differently on the two halves.
# Ten divergences, none of them the facade's.
#
# Read out of the shop's own seed rather than listed here: a copy of the list
# would go stale exactly when the shop adds a fixture, and the run after that
# would be the one that looks broken.
stand_owned_emails() {
  local seed="$SHOP/deploy/dev/seed-minishop.sql" found
  [[ -f "$seed" ]] || die "no $seed - cannot tell which panel users this stand left behind"
  found="$(grep -oE "'[A-Za-z0-9._%+-]+@example\\.com'" "$seed" | tr -d "'" | sort -u)"
  [[ -n "$found" ]] || die "$seed names no @example.com address; the purge would silently purge nothing
and the next run would inherit this one's panel users."
  printf '%s\n%s\n%s\n' \
    "${STAND_BUYER:-stand-buyer@example.com}" \
    "${PREMIUM_BUYER:-stand-premium@example.com}" \
    "$found"
}

# The shop's WORKER, not just its backend, has to be able to talk to the panel.
#
# It is a separate container with its own environment, and the shop's reference
# override configures only the backend - so this was false on the reference half
# of every differential run here, silently: the backend answered every admin
# page while the worker got 401 on everything, and the only visible trace was a
# `panel_sync: failed` tile that looked like a property of the reference panel.
# Wait until the shop's worker stops talking, so the admin walk is measured
# against a quiet stand.
#
# The trace window used to open on a bare `sleep 1`. The worker syncs the fleet
# on its own schedule, and a round landing inside that window puts calls in the
# trace that the walk never made: two differentials run back to back counted 34
# and 41, with `iceslab-buy.trace` identical between them - so the extra calls
# were additional, not leaked from the purchase.
#
# That left idempotence holding as a property of the GATE and not of the run:
# the comparison passed because it compares multisets per step, not because the
# two runs did the same thing.
#
# Idleness is read as "the worker has written nothing for N consecutive
# seconds", not as a particular log line. A marker would tie this to one
# release's wording, and the shop is a dependency we do not control - the point
# is only that nothing is in flight.
wait_for_worker_idle() {
  local which="$1" quiet="${2:-4}" timeout="${3:-90}"
  local container="remnawave-minishop-worker"
  local waited=0 stable=0 prev="" now
  while (( waited < timeout )); do
    # `|| true`: docker logs exits non-zero for a container that is restarting,
    # and under `set -e` that would kill the run for a transient state we are
    # about to wait out anyway.
    now="$(docker logs --tail 5 "$container" 2>&1 | md5sum || true)"
    if [[ "$now" == "$prev" ]]; then
      stable=$(( stable + 1 ))
      (( stable >= quiet )) && {
        echo "stand: $which worker idle after ${waited}s"
        return 0
      }
    else
      stable=0
    fi
    prev="$now"
    sleep 1
    waited=$(( waited + 1 ))
  done
  # Not fatal. A worker that never goes quiet is worth saying out loud, but it
  # is not a reason to throw away a run that is otherwise fine - the trace will
  # simply carry the same noise it always did, and now it says so.
  echo "stand: WARNING - $which worker still talking after ${timeout}s; the admin" >&2
  echo "       trace may carry background sync calls the walk did not make" >&2
  return 0
}

assert_worker_authenticated() {
  local which="$1" key
  case "$which" in
    iceslab) set -- "${compose_iceslab[@]}" ;;
    ref)     set -- "${compose_ref[@]}" ;;
    *) die "assert_worker_authenticated: unknown stand $which" ;;
  esac
  key="$("$@" exec -T worker python3 -c \
    'import os; print(len(os.environ.get("PANEL_API_KEY","")))')" \
    || die "could not read the worker's environment on the $which stand"
  [[ "${key//[[:space:]]/}" =~ ^[0-9]+$ ]] || die "unexpected answer from the $which worker: $key"
  (( ${key//[[:space:]]/} > 0 )) || die "the $which stand's worker has no PANEL_API_KEY.
Every call it makes will be 401, its fleet sync will fail, and the admin pages
downstream of that sync will differ from the other half for a reason that has
nothing to do with the facade."
  echo "stand: $which worker authenticated (PANEL_API_KEY ${key//[[:space:]]/} chars)"
}

# Our panel is not part of the stand's volumes, so `reset` does not touch it -
# and the shop finds a panel user by EMAIL. A buyer left over from an earlier
# run therefore turns the purchase into an UPDATE of an existing panel user,
# while the reference panel (whose database IS a stand volume) starts empty and
# takes a CREATE. The two halves then diverge on a trace line, and the finding
# is the stand's, not the facade's - which is exactly the kind of false positive
# that teaches you to stop believing the diff.
purge_panel_user() {
  local email="${1:?}" tok ids id code
  tok="$(tr -d '[:space:]' < "$TOKEN_FILE")"
  ids="$(curl -sS -H "authorization: Bearer $tok" \
        "$PANEL_URL/api/users/by-email/$email" \
        | python3 -c 'import json,sys
try: d = json.load(sys.stdin)
except Exception: sys.exit(0)
print("\n".join(u["id"] for u in (d.get("users") or []) if u.get("id")))')"
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

# The users churn-probe seeds, by the names it gives them.
#
# ONE listing, not one search per user. The panel rate-limits every route to 100
# requests per minute per IP, and this runs straight after the probe has created
# forty users and driven a full fleet sync - so the tail of a per-user loop lands
# past the limit. It did: the searches that fell past it answered
# `{"error":"RATE_LIMITED"}`, matched nobody, deleted nothing and said nothing,
# leaving twelve of forty behind while the probe reported success. Those get
# imported by the shop's fleet sync on the NEXT run and surface as a differential
# finding that has nothing to do with the facade.
#
# Reports failure by RETURN CODE, never by `die`: the call site wants to keep the
# probe's own verdict, and `exit` inside a function ends the whole script, so a
# `die` here would overwrite a refusal with a 1 - and `|| true` at the call site
# cannot catch it either, because `|| true` does not catch `exit`.
purge_churn_users() {
  local tok ids id code gone=0 round
  tok="$(tr -d '[:space:]' < "$TOKEN_FILE")"

  # Rounds, because the deletes themselves can reach the limit on a big fixture.
  # Each round re-lists, so a delete lost to a 429 is retried rather than
  # assumed done.
  for round in 1 2 3; do
    ids="$(churn_ids "$tok")" || return 1
    [[ -n "$ids" ]] || break
    while read -r id; do
      [[ -n "$id" ]] || continue
      code="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE \
        -H "authorization: Bearer $tok" "$PANEL_URL/api/users/$id")"
      case "$code" in
        2*) gone=$((gone + 1)) ;;
        429) sleep 20 ;;
        # The previous version counted curl's EXIT CODE, which is zero whether
        # the panel answered 204 or 429, so "removed N" meant nothing at all.
        *) echo "stand: could not remove churn-probe user $id: HTTP $code" >&2; return 1 ;;
      esac
    done <<< "$ids"
  done

  # Check, do not announce. Every version of this cleanup so far printed a
  # number it had not verified, and twice now the fixture stayed on the panel
  # while the probe said it had tidied up.
  ids="$(churn_ids "$tok")" || return 1
  if [[ -n "$ids" ]]; then
    echo "stand: $(grep -c . <<<"$ids") churn-probe user(s) are STILL on the panel after cleanup.
The shop's fleet sync imports them on the next run, and the differential then
reports them as a facade divergence." >&2
    return 1
  fi
  echo "stand: removed $gone churn-probe user(s) from the panel; none left"
}

# Panel ids of every churn-probe user, in one request.
#
# Retries past the rate limit rather than returning an empty list: throttled and
# finished look identical from here, and that confusion is exactly what let the
# leftovers through. Signals failure by return code - a `die` would be swallowed,
# because this runs inside a command substitution and that is a subshell.
churn_ids() {
  local tok="${1:?}" body attempt
  for attempt in 1 2 3; do
    body="$(curl -sS -H "authorization: Bearer $tok" "$PANEL_URL/api/users?size=1000")"
    if [[ "$body" == *RATE_LIMITED* ]]; then
      sleep 20
      continue
    fi
    python3 -c 'import json,sys
try: d = json.load(sys.stdin)
except Exception: sys.exit(0)
for u in (d.get("users") or []):
    if str(u.get("username") or "").startswith("churn-probe-") and u.get("id"):
        print(u["id"])' <<< "$body"
    return 0
  done
  echo "stand: the panel kept answering RATE_LIMITED while listing churn-probe users" >&2
  return 1
}

# The SHOP's copy of a buyer, through its own admin API.
#
# Purging the panel side is not enough on its own: the shop's fleet sync imports
# panel users it does not know, so a panel user deleted after a demotion comes
# BACK as a shop subscription with no tariff_key - and the next purchase for
# that address answers `tariff_switch_required` instead of creating anything.
# That is how this probe failed twice: once on the panel leftover, then on the
# shop's re-import of it.
purge_shop_user() {
  local email="${1:?}" jar csrf uid
  jar="$(mktemp)"
  csrf="$(shop_admin_session "$jar")" || { rm -f "$jar"; die "no admin session to purge $email"; }
  uid="$(curl -sS -b "$jar" -c "$jar" "${SHOP_URL:-http://127.0.0.1:8082}/api/admin/users?limit=200" \
    | python3 -c 'import json,sys
rows = json.load(sys.stdin).get("users") or []
print(next((str(u["user_id"]) for u in rows if u.get("email") == sys.argv[1]), ""))' "$email")"
  if [[ -n "$uid" ]]; then
    curl -sS -o /dev/null -b "$jar" -c "$jar" -H "X-CSRF-Token: $csrf" \
      -X DELETE "${SHOP_URL:-http://127.0.0.1:8082}/api/admin/users/$uid" \
      || { rm -f "$jar"; die "could not remove the shop user $uid ($email)"; }
    echo "stand: removed the shop's user $uid ($email)"
  else
    echo "stand: no shop user for $email"
  fi
  rm -f "$jar"
}

# Every leftover, not just the buyer. Same reason, one run apart.
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
# frontend is restarted with it - and then this waits for the webapp itself,
# because a healthy container is not yet an answering one. Without the wait the
# next step fails on "no verification code in the response", which reads like a
# QA-mode misconfiguration and is not one.
wait_shop() {
  # Any answer FROM THE APP counts, including 401 and 404: what is being waited
  # on is nginx having an upstream that talks, and pinning the probe to one
  # route's success would make this fail whenever that route moves.
  local url="${SHOP_URL:-http://127.0.0.1:8082}/api/me" i code
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
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' "$PANEL_URL/$PREFIX/api/system/metadata")"
  case "$code" in
    401) : ;;  # mounted and asking for auth, which is what we want
    404) die "the facade is not mounted at $PANEL_URL/$PREFIX/api - set REMNAWAVE_COMPAT_ENABLED=true and restart the panel" ;;
    000) die "no panel answering at $PANEL_URL" ;;
    *)   echo "stand: warning - facade probe answered $code, expected 401" >&2 ;;
  esac
  local tok body
  tok="$(tr -d '[:space:]' < "$TOKEN_FILE")"
  body="$(curl -s -H "authorization: Bearer $tok" "$PANEL_URL/$PREFIX/api/system/metadata")"
  grep -q '"version"' <<<"$body" || die "the token does not authenticate against the facade: $body"
  echo "stand: facade says $body"
}

assert_front_proxies_the_facade() {
  # The frontend image is a fixture too, and a wrong one makes every probe after
  # it report something about the shop that is not true. Two directions, because
  # either check alone passes on an nginx broken the other way: one that
  # forwards nothing satisfies the second, and one whose SPA fallback swallows
  # the API satisfies the first — which is precisely §54.2, an index.html served
  # with a 200 on the prefix the shop is documented to use.
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
A 200 text/html here is the SPA fallback eating the facade (see §54.2); anything
else means nginx is not reaching the panel on $ICESLAB_BACKEND_ADDR." ;;
  esac
  case "$ctype" in
    *html*) die "the frontend image answered $code but with $ctype on
/$PREFIX/api/users: that is index.html, i.e. the SPA fallback, which is the
exact shape §54.2 had." ;;
  esac

  # 2. ...and it is still a single-page app for everything else, or the fixture
  #    is an nginx that proxies the whole world and proves nothing about which
  #    prefixes it forwards.
  read -r code ctype < <(curl -sS -o /dev/null \
    -w '%{http_code} %{content_type}\n' "$front/nodes")
  [[ "$code" == 200 && "$ctype" == *html* ]] \
    || die "the frontend image answered $code ($ctype) on /nodes, so it is not
serving the SPA at all and check 1 above proved nothing."
}

assert_shim_hides_only_the_one_route() {
  # The shim is a fixture, and a wrong fixture makes the run report something
  # about the shop that is not true. Two directions, because either check alone
  # passes on a shim broken the other way: one answering 404 to EVERYTHING
  # satisfies the first and turns the probe into a test of a dead panel; one
  # forwarding everything satisfies the second, leaves the preferred route
  # answering, and the fallback is never reached - the probe would then report
  # the wrong source without failing.
  local shim="http://127.0.0.1:${PANEL_SHIM_PORT:-8086}/$PREFIX/api"
  local tok body code
  tok="$(tr -d '[:space:]' < "$TOKEN_FILE")"

  body="$(curl -sS -X POST "$shim/bandwidth-stats/nodes/usage" \
    -H "authorization: Bearer $tok" -H 'content-type: application/json' \
    -d '{"nodesUuids":[]}' -w $'\n%{http_code}')"
  code="${body##*$'\n'}"; body="${body%$'\n'*}"
  # The shop's predicate, not an eyeball: a 404 alone is not enough. The body
  # has to carry no errorCode and a message that reads like a router miss, or
  # the shop calls it a failed request and goes on preferring the route.
  python3 "$HERE/reads_as_missing_route.py" "$code" "$body" \
    || die "the shim answered $code / $body, which does NOT read to the shop as a
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

# Unconditional: `down`, `reset` and `half ref` all reach for compose_ref, and
# `--env-file` on a file that is not there is a compose error, not a fallback.
fill_ref_token

case "${1:-}" in
  up-iceslab)
    # HIDE_NODES_USAGE=1 puts panel-shim in front of the panel, which makes
    # POST .../bandwidth-stats/nodes/usage read as a route this build does not
    # have. Only `premium-probe` cares; everything else would be measuring nginx.
    fill_token
    if [[ -n "${HIDE_NODES_USAGE:-}" ]]; then
      # Route the shop through the shim instead of straight at the panel, so the
      # preferred usage route reads as absent and the shop falls back to the one
      # no run has ever reached. Written into the runtime env BEFORE `up`,
      # because `env_file` is read when the container is created - the same
      # reason CHURN_PAGING is handled here and not later.
      #
      # The path keeps the facade's prefix: the shim matches by suffix and
      # forwards everything else, so this is the same URL with one route
      # removed.
      echo "PANEL_API_URL=http://panel-shim:8080/${PREFIX}/api" >> "$RUNTIME_ENV"
      echo "stand: the shop will reach the panel through panel-shim, which answers"
      echo "stand: POST .../bandwidth-stats/nodes/usage with a router miss"
    fi
    if [[ -n "${CHURN_PAGING:-}" ]]; then
      {
        echo "PANEL_ALL_USERS_PAGE_SIZE=${CHURN_PAGE_SIZE:-5}"
        echo "PANEL_ALL_USERS_PAGE_DELAY_SECONDS=${CHURN_PAGE_DELAY:-1.0}"
      } >> "$RUNTIME_ENV"
      echo "stand: sync paging forced to ${CHURN_PAGE_SIZE:-5} users, ${CHURN_PAGE_DELAY:-1.0}s between pages"
    fi
    preflight_facade
    if [[ -z "${HIDE_NODES_USAGE:-}" ]]; then
      # The ordinary run reaches the facade through the panel's OWN frontend
      # image, because that is what stands in front of it in a real deploy.
      # Pointing the shop straight at the backend is what made §54.2 invisible
      # here: the SPA fallback answered `/rw/api/*` with index.html and a 200,
      # on the prefix the shop is documented to use, and no request of this
      # stand's ever went through nginx to see it.
      #
      # Written into the runtime env BEFORE `up`, for the same reason the shim
      # line below is: `env_file` is read when the container is created.
      echo "PANEL_API_URL=http://panel-front/${PREFIX}/api" >> "$RUNTIME_ENV"
      "${compose_iceslab[@]}" up -d --wait "${STAND_SERVICES[@]}"
      assert_front_proxies_the_facade
      echo "stand: the shop will reach the panel through its own frontend image"
    fi
    if [[ -n "${HIDE_NODES_USAGE:-}" ]]; then
      "${compose_iceslab[@]}" --profile shim up -d --wait panel-shim
      # Prove the shim is a panel-minus-one-route before anything depends on it.
      # Both halves of that: the hidden route answers as absent, and a route
      # next to it still reaches the panel. Checking only the 404 would pass on
      # a shim that answers 404 to everything, which is a different experiment
      # entirely - and one whose failures would look like facade bugs.
      assert_shim_hides_only_the_one_route
    fi
    "${compose_iceslab[@]}" --profile seed up -d --wait "${SHOP_SERVICES[@]}"
    # The shop's demo fixtures, same as the reference half runs: without them
    # there is no user whose telegram_id is in ADMIN_IDS, and the admin API
    # answers 403 to everything. Seed BEFORE the restart, so both halves reach
    # the walkthrough with the same cache state.
    "${compose_iceslab[@]}" --profile seed up --no-deps dev-seed \
      || echo "stand: the shop's own demo seed exited non-zero (expected at v3.6.1, see stand.override.yml)" >&2
    assert_admin_seeded iceslab
    assert_worker_authenticated iceslab
    ensure_panel_squads
    seed_tariffs
    # `restart` returns when the container is running, not when the app inside
    # it answers - the next step then gets an empty reply through the shop's
    # nginx and fails on "no verification code". `up --wait` waits for healthy.
    "${compose_iceslab[@]}" restart backend worker
    "${compose_iceslab[@]}" up -d --wait backend worker
    # The frontend LAST and on its own: `restart a b c` gives no ordering
    # guarantee, and a restarted backend comes back on a NEW container IP, which
    # nginx resolved once at its own start. Restarting them together races - the
    # frontend can cache the address the backend is about to leave.
    "${compose_iceslab[@]}" restart frontend
    "${compose_iceslab[@]}" up -d --wait frontend
    wait_shop
    echo "stand: shop at http://127.0.0.1:8082 (webapp), backend http://127.0.0.1:8080"
    ;;
  up-ref)
    # The seed jobs have to be NAMED, not just enabled by their profile:
    # `--profile seed` with an explicit service list starts only the listed ones,
    # and without the seed the reference panel has no API token and answers 403
    # to everything. The shop then logs "Could not detect Remnawave panel
    # version", refuses to create a user, and the activation fails - which reads
    # like a facade problem and is not one.
    #
    # dev-seed (the shop's own demo fixtures) is expected to fail at v3.6.1: its
    # seed-minishop.sql inserts a payment row without funding_source, which the
    # shop's own migration made NOT NULL. Nothing this stand needs comes from it,
    # so its failure is tolerated rather than fixed in their tree.
    "${compose_ref[@]}" --profile seed up -d --wait \
      "${SHOP_SERVICES[@]}" remnawave remnawave-db remnawave-redis
    "${compose_ref[@]}" --profile seed up --no-deps remnawave-dev-seed || \
      die "the reference panel's API token was not seeded; it will answer 403 to everything"
    "${compose_ref[@]}" --profile seed up --no-deps dev-seed \
      || echo "stand: the shop's own demo seed failed (expected at v3.6.1, see above)" >&2
    assert_admin_seeded ref
    assert_worker_authenticated ref
    seed_tariffs
    # The shop cached "could not detect version" while the panel was unseeded.
    "${compose_ref[@]}" restart backend worker
    "${compose_ref[@]}" up -d --wait backend worker
    # The frontend LAST and on its own: `restart a b c` gives no ordering
    # guarantee, and a restarted backend comes back on a NEW container IP, which
    # nginx resolved once at its own start. Restarting them together races - the
    # frontend can cache the address the backend is about to leave.
    "${compose_ref[@]}" restart frontend
    "${compose_ref[@]}" up -d --wait frontend
    wait_shop
    echo "stand: reference panel published on http://127.0.0.1:${REMNAWAVE_DEV_PANEL_PORT:-3100} (the host's 3000 is our own panel)"
    ;;
  down)
    # Every profile the stand can START has to be named on the way DOWN, or its
    # container is left behind and the next run tries to start a stale one on a
    # network `down -v` has already removed ("network ... not found"). That was
    # the seed job's lesson; `shim` and `tls` are the same shape, and a left-over
    # shim is worse than a left-over seed - it still answers, so the next run
    # silently talks to a panel with a route missing.
    "${compose_iceslab[@]}" "${STAND_PROFILES[@]}" down --remove-orphans || true
    "${compose_ref[@]}" --profile seed down --remove-orphans || true
    ;;
  reset)
    # Volumes too. Between the two halves of a differential run this is not
    # optional: a shop database carried over from the other stand makes the
    # comparison meaningless in a way nothing announces.
    "${compose_iceslab[@]}" "${STAND_PROFILES[@]}" down -v --remove-orphans || true
    "${compose_ref[@]}" --profile seed down -v --remove-orphans || true
    ;;
  check)
    # The preconditions `up-*` asserts, against a stand that is already up.
    # Exists so the guards can be exercised without a twenty-minute run.
    shift
    which="${1:?usage: stand.sh check <iceslab|ref>}"
    assert_admin_seeded "$which"
    assert_worker_authenticated "$which"
    ;;
  premium-probe)
    # POST /bandwidth-stats/nodes/usage, called by the SHOP rather than asserted
    # with inject.
    #
    # It is one of the four capability routes served in 741d0cd, and until this
    # probe none of them had ever been called by a real shop in any run here -
    # their whole guard was our own tests. It is also the one route the shop
    # reaches only through a chain of preconditions, every link of which fails
    # QUIETLY: the shop must certify the version we declare (its `dev` branch
    # does, `support=current`), a premium-bearing subscription must be ALIVE
    # (the admin walkthrough deletes its buyer at the end, so a probe run after
    # one finds no candidates), and the tariff's premium squad must resolve to
    # nodes or the worker logs "no accessible nodes" and skips the whole
    # accounting. Each of those makes the route uncalled, and an uncalled route
    # looks exactly like a route with nothing wrong.
    shift
    # Its own leftovers first, for the reason `half` does the same: our panel is
    # not a stand volume, so the buyer from the last probe is still there - and
    # after a demotion it is there in a state the shop reads as a DIFFERENT
    # tariff, answering `tariff_switch_required` to the purchase. Deleting the
    # user takes its usage fixture with it (node_user_usage_history cascades).
    purge_shop_user "${PREMIUM_BUYER:-stand-premium@example.com}"
    purge_panel_user "${PREMIUM_BUYER:-stand-premium@example.com}"
    grant_squad_nodes
    drop_shop_squad_cache
    STAND_ENV="$RUNTIME_ENV" "$HERE/buy.sh" "${PREMIUM_BUYER:-stand-premium@example.com}" \
      > "${1:-/tmp/premium-probe-buy.log}" 2>&1 \
      || die "the premium probe's purchase failed; see ${1:-/tmp/premium-probe-buy.log}"
    # AFTER the purchase, because the window has to start where the thing being
    # watched first becomes POSSIBLE. Marked before it instead, the wait below is
    # satisfied by the tick the restart triggers seconds later - a tick with no
    # subscription to meter - and the probe then reports that the shop never
    # called the route. Stage 2 marks before ITS restart for the mirror-image
    # reason: there the restart is what triggers the one-shot it watches for.
    ppmark="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "stand: bought ${PREMIUM_BUYER:-stand-premium@example.com}; waiting for a FULL tariff tick"
    # Only the FULL tick computes usage, and it runs every five minutes
    # (measured: 13:53:10, 13:58:10, 14:03:10); premium_fast runs every minute
    # and does not. Waiting for the tick itself rather than sleeping a guessed
    # interval is the difference between "the route was not called" and "we did
    # not wait" - the first draft waited four minutes and refused.
    for _ in $(seq 1 66); do
      # Captured first, NOT piped into `grep -q`. Under `set -o pipefail` a
      # pipeline reports the writer's status too, and `grep -q` exits the instant
      # it matches - so the writer takes SIGPIPE and the pipeline returns 141
      # EXACTLY WHEN THE PATTERN IS FOUND. The check inverts, and only when the
      # log is long enough that the writer is still going, which is why it
      # survives being tried by hand. A here-string is a file, not a pipe.
      if grep -q 'kind=full' <<<"$(docker logs --since "$ppmark" remnawave-minishop-worker 2>&1)"; then
        ticked=1; break
      fi
      sleep 10
    done
    [[ "${ticked:-0}" == 1 ]] || refuse "no full tariff tick in eleven minutes - the probe proved
nothing. A run that never reached the code under test is not a run that found
nothing, so this is a refusal, not a pass."
    "$0" trace "${STAND_TRACE:-/tmp/premium-probe.trace}" "$ppmark"
    grep -q '^POST /bandwidth-stats/nodes ' "${STAND_TRACE:-/tmp/premium-probe.trace}" \
      || die "the shop never called POST /bandwidth-stats/nodes.
Check the worker log for 'have no accessible nodes' (the tariff's premium squad
grants none) or for a version it will not certify."
    # The label is shared by four operations, two of them POST, so the trace
    # alone cannot say WHICH. The worker names it: `source=multi_node_usage` is
    # the branch that consumes /nodes/usage (tariff_worker_premium_usage.py),
    # and `complete=True` is the shop agreeing we answered for every node it
    # asked about - which is the contract that route is easiest to break.
    snap="$(docker logs --since "$ppmark" remnawave-minishop-worker 2>&1 \
      | grep -o 'premium_usage_snapshot .*' | tail -1)"
    [[ -n "$snap" ]] || die "no premium usage snapshot in the worker log; the route answered but
the shop did not build a snapshot from it."
    echo "stand: $snap"
    # WHICH route the snapshot came from is the whole point, and the trace
    # cannot say: `/bandwidth-stats/nodes` is one label over four operations,
    # two of them POST. The shop's own metric names the branch. Which branch is
    # expected depends on how the stand was brought up - see below - so the
    # probe reads that from the runtime env rather than taking it on faith from
    # an argument somebody may not have passed.
    if grep -q '^PANEL_API_URL=.*panel-shim' "$RUNTIME_ENV"; then
      # The stand is up with HIDE_NODES_USAGE: the preferred route reads as
      # absent, so the shop must have fallen back to
      # POST /bandwidth-stats/nodes/users - the fourth capability route, and the
      # only one no run here had ever reached.
      want_source=multi_node_top_users
      # Two things at once, and both matter. The fallback happening at all is
      # the point; but the shop reaching it because it OBSERVED our 404 as a
      # missing route is the property the whole facade rests on, and it has
      # never been tested against a live shop - only against our transcription
      # of its predicate. If it read our 404 as a failed request instead, the
      # capability would stay unset, the shop would keep retrying the preferred
      # route every tick, and the fallback below would still eventually be
      # reached by a different path - passing the probe for the wrong reason.
      #
      # The window for THIS one starts at the worker's own start, not at the
      # purchase mark the tick is measured from. `remember_panel_capability`
      # logs only when the value CHANGES, so the line is one-shot per process:
      # scoped to the purchase, a shop that had already learned it on an earlier
      # tick shows nothing, and the probe would report that our 404 was
      # misread by a shop that read it correctly. Same rule as the demotion
      # stage below, applied to a different starting point - a one-shot is
      # watched from before whatever can trigger it, and nothing before the
      # worker existed could.
      wlog="$(docker logs --since "$(docker inspect -f '{{.State.StartedAt}}' remnawave-minishop-worker)" \
        remnawave-minishop-worker 2>&1)"
      grep -q 'Observed Remnawave capability multi-node-usage=False' <<<"$wlog" \
        || die "the shop never recorded /nodes/usage as missing. Our 404 did not read to
it as an absent route, so it will go on calling a route that is not there
instead of using the fallback."
      echo "stand: the shop observed multi-node-usage=False from our 404 and fell back"
    else
      want_source=multi_node_usage
    fi
    grep -q "source=$want_source" <<<"$snap" \
      || die "the snapshot came from '$snap' - not from $want_source, so this probe
did not exercise the route it exists for."
    grep -q 'complete=True' <<<"$snap" \
      || die "the shop calls the snapshot INCOMPLETE: $snap
It asked about a set of nodes and did not get an answer for all of them, which
is the silent half of the per-node billing path."
    echo "stand: premium usage path exercised end to end via $want_source"

    # ---- stage 2: the demotion, which is what calls the other two routes ----
    #
    # `POST /users/bulk/update-squads` and `POST /connections/drop` are queued by
    # the SAME path: a premium subscriber going over its premium allowance loses
    # the premium squad and has its sessions dropped
    # (tariff_worker_premium_batches.py). Neither had ever been called by a real
    # shop here before this.
    #
    # The desired squad set has to stay NON-EMPTY or this proves nothing: the
    # shop deliberately routes "clear the last squad" through per-user PATCHes
    # instead, because Remnawave 3.0.0 answers A088/500 to a bulk clear. So the
    # tariff keeps its base squad and loses only the premium one.
    pu="$(curl -sS -H "authorization: Bearer $(tr -d '[:space:]' < "$TOKEN_FILE")" \
      "$PANEL_URL/api/users/by-email/${PREMIUM_BUYER:-stand-premium@example.com}" \
      | python3 -c 'import json,sys
rows = (json.load(sys.stdin).get("users") or [])
print(rows[0]["id"] if rows else "")')"
    [[ -n "$pu" ]] || die "no panel user for ${PREMIUM_BUYER:-stand-premium@example.com}; the purchase did not reach the panel"
    read -r allowance node <<<"$(python3 "$HERE/premium_fixture.py" \
      "$HERE/tariffs.template.json" \
      "$(curl -sS -H "authorization: Bearer $(tr -d '[:space:]' < "$TOKEN_FILE")" \
         "$PANEL_URL/$PREFIX/api/internal-squads/$(stand_squad_ids --premium)/nodes")")" \
      || die "could not decide how much usage to write"
    # 20% over the allowance, on a node the premium squad actually grants -
    # usage on any other node is not premium usage and the worker would be right
    # to ignore it.
    panel_psql -c "insert into node_user_usage_history (node_id, date, user_id, bytes_in, bytes_out)
      values ('$node', current_date, '$pu', $allowance, 0)
      on conflict (node_id, date, user_id) do update set bytes_in = excluded.bytes_in;" >/dev/null \
      || die "could not write the usage fixture"
    echo "stand: wrote $allowance bytes of premium usage for $pu on node $node"
    # Same ordering, and here it decides the result rather than the timing: the
    # demotion is a ONE-SHOT event on the first full tick after the restart, so
    # marking afterwards missed it by four seconds and then watched a later tick
    # do nothing - a probe reporting "the shop never demoted" about a shop that
    # already had. The window still starts AFTER the usage fixture is written,
    # so a demotion inside it can only be this fixture's.
    dmark="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    drop_shop_squad_cache
    for _ in $(seq 1 66); do
      # Same reason as the first stage: see the note there.
      if grep -q 'kind=full' <<<"$(docker logs --since "$dmark" remnawave-minishop-worker 2>&1)"; then
        dticked=1; break
      fi
      sleep 10
    done
    [[ "${dticked:-0}" == 1 ]] || refuse "no full tariff tick in eleven minutes for the demotion stage"
    "$0" trace "${STAND_TRACE:-/tmp/premium-probe.trace}.demote" "$dmark"
    dlog="$(docker logs --since "$dmark" remnawave-minishop-worker 2>&1)"
    grep -q 'premium_squad_write_batch' <<<"$dlog" \
      || die "the shop never demoted the over-limit subscriber. Check the tick log for
'have no accessible nodes', or whether the usage landed on a node the premium
squad grants."
    # The bulk route's trace label is `/users`, shared with four other
    # operations, so the trace CANNOT say it was called. The shop's own metric
    # can, and it names the selector - `userIds` is the numeric rw3 one.
    grep -q 'panel_squad_bulk .*selector=userIds' <<<"$dlog" \
      || die "the squad change did not go through POST /users/bulk/update-squads:
$(grep -o 'panel_squad_bulk .*' <<<"$dlog" | tail -1)
A per-user PATCH fallback here means the bulk route answered in a shape the shop
rejected - check the affectedRows key."
    grep -q '^POST /connections ' "${STAND_TRACE:-/tmp/premium-probe.trace}.demote" \
      || die "the shop never called POST /connections/drop after limiting premium access"
    grep -q 'connections-drop=True' <<<"$dlog" \
      || die "the shop did not record connections-drop as available; it will stop asking"
    echo "stand: $(grep -o 'panel_squad_bulk .*' <<<"$dlog" | tail -1)"
    echo "stand: $(grep -o 'panel_connection_drop .*' <<<"$dlog" | tail -1)"
    # The point of the whole stage, checked on the panel rather than in the log:
    # premium squad gone, base squad still there.
    curl -sS -H "authorization: Bearer $(tr -d '[:space:]' < "$TOKEN_FILE")" \
      "$PANEL_URL/api/users/$pu" \
      | python3 "$HERE/assert_demoted.py" "$(stand_squad_ids | tr '\n' ' ')" \
      || die "the panel does not show the demotion the shop reported"
    echo "stand: premium demotion exercised end to end (bulk squads + connections drop)"
    # And leave both sides as they were found, usage fixture included.
    purge_shop_user "${PREMIUM_BUYER:-stand-premium@example.com}"
    purge_panel_user "${PREMIUM_BUYER:-stand-premium@example.com}"
    ;;
  seed-tariffs)
    # Re-run the catalogue step alone, against whatever half is up.
    seed_tariffs
    ;;
  mark)   date -u +%Y-%m-%dT%H:%M:%SZ ;;

  half)
    # One half of the differential, start to finish, from a dropped volume.
    #
    # Driving both halves from ONE code path is the point: the comparison is
    # only worth what the sameness of the two runs is worth, and two hand-typed
    # sequences drift in ways that then show up as findings. The buyer's address
    # is fixed for the same reason - the shop keys its user off it.
    shift
    which="${1:-}"; outdir="${2:-}"
    [[ -n "$which" && -n "$outdir" ]] || die "usage: stand.sh half <iceslab|ref> <outdir>"
    mkdir -p "$outdir"
    case "$which" in
      iceslab) env_for_half="$RUNTIME_ENV" ;;
      ref)     env_for_half="$RUNTIME_REF_ENV" ;;
      *) die "half: expected iceslab or ref, got $which" ;;
    esac
    "$0" reset
    # Only the iceslab half needs this: the reference panel's database is a
    # stand volume and `reset` already dropped it. An `if`, not `[[ ]] &&`: a
    # false test as the last statement of the branch would end the script under
    # `set -e`.
    if [[ "$which" == iceslab ]]; then
      purge_panel_leftovers
    fi
    "$0" "up-$which"
    # Node traffic, so the walkthrough compares two FILLED `topNodes` lists.
    # Without it both halves report an empty one, and the acceptance that rides
    # on "we always fill topNodes" is never exercised — see seed_node_traffic.py.
    python3 "$HERE/seed_node_traffic.py" "$which"
    STAND_ENV="$env_for_half" "$HERE/buy.sh" "${STAND_BUYER:-stand-buyer@example.com}" \
      > "$outdir/$which-buy.log" 2>&1 \
      || { tail -20 "$outdir/$which-buy.log" >&2; die "the purchase failed on the $which stand"; }
    "$0" trace "$outdir/$which-buy.trace"
    # Open the window on a quiet stand: see wait_for_worker_idle.
    wait_for_worker_idle "$which"
    mark="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; sleep 1
    STAND_ENV="$env_for_half" "$HERE/admin.sh" "$outdir/$which-admin.jsonl" \
      "${STAND_BUYER:-stand-buyer@example.com}" 2>&1 | tee "$outdir/$which-admin.log"
    "$0" trace "$outdir/$which-admin.trace" "$mark"
    echo "stand: $which half done -> $outdir"
    ;;

  differential)
    # Both halves and both comparisons, in one command. The halves cannot run at
    # the same time (the shop's container names are fixed), so this is a
    # sequence, not a fan-out - which is also why it is worth having: two halves
    # typed by hand hours apart are two different experiments.
    shift
    outdir="${1:?usage: stand.sh differential <outdir>}"
    mkdir -p "$outdir"
    "$0" half iceslab "$outdir"
    "$0" half ref "$outdir"
    # Each comparison runs even if an earlier one found something - all three
    # are worth reading. But a REFUSAL (exit 2, "nothing to compare") is not a
    # finding, it means the run was invalid, and that must not end in a zero
    # exit code just because the message scrolled past.
    invalid=0
    compare_step() { # heading, script, args...
      local heading="$1"; shift
      local script="$1"; shift
      echo; echo "===== $heading ====="
      python3 "$HERE/$script" "$@" || [[ $? -eq 1 ]] || invalid=1
    }
    compare_step "call traces: the purchase" compare_traces.py \
      "$outdir/ref-buy.trace" "$outdir/iceslab-buy.trace"
    compare_step "call traces: the admin walkthrough" compare_traces.py \
      "$outdir/ref-admin.trace" "$outdir/iceslab-admin.trace"
    compare_step "what the admin pages rendered" compare_admin.py \
      "$outdir/ref-admin.jsonl" "$outdir/iceslab-admin.jsonl"
    [[ $invalid -eq 0 ]] || die "a comparison refused to run - the differential proved nothing"
    ;;

  full)
    # The differential plus every probe that needs a stand of its own.
    # Ordered: the differential leaves the REFERENCE half up, so the probes -
    # which test OUR facade - bring the iceslab half back first.
    #
    # Slow, and deliberately so. `premium-probe` used to be a command you had to
    # remember to type, which means a command that does not get run: it is the
    # only thing that drives a real shop into the capability routes, and it sat
    # outside the one entry point that claims to run everything. Two full tariff
    # ticks at five minutes each puts it near thirteen minutes per pass, and
    # `full` runs it twice - once against the panel as it is, once through
    # `panel-shim`, which is the only way the fourth route is reached at all.
    # Budget roughly an hour for the whole command.
    shift
    outdir="${1:?usage: stand.sh full <outdir>}"
    "$0" differential "$outdir"

    echo; echo "===== signed webhook through a real TLS proxy ====="
    "$0" reset >/dev/null 2>&1 || true
    "$0" up-iceslab > "$outdir/probe-up.log" 2>&1 || { tail -20 "$outdir/probe-up.log" >&2; die "could not bring the stand back for the probes"; }
    "$0" webhook-probe

    # Same stand: the premium probe cleans up after itself on both sides, and
    # the webhook probe leaves nothing behind, so a second bring-up here would
    # cost four minutes to prove nothing.
    echo; echo "===== premium accounting and demotion (three capability routes) ====="
    STAND_TRACE="$outdir/premium.trace" "$0" premium-probe "$outdir/premium-buy.log"

    # And again with the preferred usage route hidden, which is the only way the
    # shop reaches the fourth. A stand of its own because the shim is in the
    # PATH to the panel: it has to be there before the shop's containers are
    # created, and every other probe must NOT be talking through it.
    echo; echo "===== the fallback route, with /nodes/usage hidden ====="
    "$0" reset >/dev/null 2>&1 || true
    HIDE_NODES_USAGE=1 "$0" up-iceslab > "$outdir/shim-up.log" 2>&1 \
      || { tail -20 "$outdir/shim-up.log" >&2; die "could not bring the stand up behind panel-shim"; }
    STAND_TRACE="$outdir/premium-fallback.trace" "$0" premium-probe "$outdir/premium-fallback-buy.log"
    ;;

  churn-probe)
    # Live risk (3), reproduced against the SHOP rather than asserted with
    # inject: its fleet sync walks every page of /users/stream to decide who
    # still exists, and a user it never sees is PANEL_USER_NOT_FOUND -
    # is_active=False, a paid subscription quietly ended.
    #
    # The shop reports "Panel records checked" at the end of a sync, and that
    # number is the whole finding. Seed the panel, start a sync slow enough to
    # watch (the shop's own page-size and page-delay knobs, set in the runtime
    # env only), delete ONE user the walk has already collected, and count.
    #
    #   keyset  + churn : N     (the deleted one was collected before it went)
    #   offset  + churn : N-1   (and the missing one is somebody still alive)
    #
    # Run it with the route reverted to offset paging to see the second line;
    # that is how it was established, and it is the only way to tell the two
    # apart - on a quiet panel they are identical.
    shift
    seed="${1:-40}"
    tok="$(tr -d '[:space:]' < "$TOKEN_FILE")"
    jar="$(mktemp)"; trap 'rm -f "$jar"' RETURN

    echo "stand: seeding $seed users on the panel"
    for i in $(seq 1 "$seed"); do
      curl -sS -o /dev/null -X POST -H "authorization: Bearer $tok" \
        -H 'content-type: application/json' \
        -d "{\"username\":\"churn-probe-$(printf '%04d' "$i")\",\"expireDays\":30}" \
        "$PANEL_URL/api/users" || die "could not seed churn-probe-$i"
    done
    total="$(curl -sS -H "authorization: Bearer $tok" "$PANEL_URL/$PREFIX/api/users?size=1" \
      | python3 -c 'import json,sys; print(json.load(sys.stdin)["response"]["total"])')"
    echo "stand: $total users on the panel"

    # Newest first, so the last one seeded is on page one - collected before the
    # deletion no matter how the walk is paged.
    victim_name="churn-probe-$(printf '%04d' "$seed")"
    victim="$(curl -sS -H "authorization: Bearer $tok" \
      "$PANEL_URL/api/users/by-username/$victim_name" \
      | python3 -c 'import json,sys
d=json.load(sys.stdin)
print(d.get("id") or d["users"][0]["id"])')"

    csrf="$(shop_admin_session "$jar")"
    mark="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    ( sleep "${CHURN_DELETE_AFTER:-4}"
      curl -sS -o /dev/null -X DELETE -H "authorization: Bearer $tok" "$PANEL_URL/api/users/$victim"
      echo "stand: deleted $victim_name mid-walk" ) &
    curl -sS -b "$jar" -H 'content-type: application/json' -H "X-CSRF-Token: $csrf" \
      -X POST "${SHOP_URL:-http://127.0.0.1:8082}/api/admin/sync" -d '{}' > /dev/null
    wait

    # Same pipefail/SIGPIPE inversion as the premium probe's tick waits, and
    # here it is worse: this loop has no bound, so a pipeline that returns 141
    # on a MATCH spins forever and the probe hangs rather than fails.
    until grep -q 'Panel records checked' <<<"$(docker logs --since "$mark" remnawave-minishop-worker 2>&1)"; do
      sleep 1
    done
    checked="$(docker logs --since "$mark" remnawave-minishop-worker 2>&1 \
      | grep -oE 'Panel records checked: [0-9]+' | tail -1 | grep -oE '[0-9]+')"
    echo
    verdict=0
    echo "stand: panel had $total users; one was deleted after the walk collected it"
    # The verdict is delegated because the FIRST thing it has to decide is
    # whether this run proved anything at all: a walk that fitted in one page
    # never followed a cursor, and the earlier version of this probe reported
    # success in exactly that case.
    docker logs --since "$mark" remnawave-minishop-worker 2>&1 \
      | python3 "$HERE/churn_verdict.py" "$total" "$checked" "${CHURN_DELETE_AFTER:-4}" \
      || verdict=$?
    # `|| verdict=$?` and not a bare `verdict=$?`: under `set -e` a failing
    # pipeline ends the script THERE, so the assignment would only ever run when
    # the probe passed - and the cleanup below with it. Cleanup that happens
    # only on success is cleanup missing exactly when a run is worth repeating.
    # Its own 40 users, gone. They are not a stand volume - our panel never is -
    # so without this every churn run leaves them behind, the next differential
    # counts a different fleet, and the panel grows by 39 a run. Fifth thing
    # this session that outlived the run that made it; the rule has not changed.
    # After the verdict, so a failed probe can still be looked at. NOT best
    # effort any more: a cleanup that quietly failed is how twelve of forty
    # users stayed on the panel while the probe reported success, and the next
    # differential inherited them. The probe's own verdict still wins - a
    # refusal must not be downgraded to a plain failure by the tidying - but a
    # clean probe with dirty cleanup is not a passing run.
    purge_churn_users || cleanup=1
    [[ $verdict -ne 0 ]] && exit $verdict
    exit ${cleanup:-0}
    ;;

  webhook-probe)
    # Live risk (5): HMAC body integrity through a REAL proxy.
    #
    # The facade signs the raw body, so the shop's check passes only if the bytes
    # that arrive are the bytes that were signed - and in production the two are
    # never directly connected. Everywhere else this stand speaks plain HTTP
    # host-to-container, which is the one topology in which this cannot fail.
    #
    # So: the same signed request, sent directly AND through a TLS nginx, must
    # both be accepted; and a body altered by one byte after signing must be
    # rejected through the same proxy. Without that last one the probe would
    # pass against a proxy that accepted anything.
    fill_token
    ensure_webhook_cert
    "${compose_iceslab[@]}" --profile tls up -d --wait webhook-tls
    secret="$(sed -n 's/^PANEL_WEBHOOK_SECRET=//p' "$RUNTIME_ENV" | tail -1)"
    [[ -n "$secret" ]] || die "no PANEL_WEBHOOK_SECRET in $RUNTIME_ENV"
    tls_port="${WEBHOOK_TLS_PORT:-8444}"
    fail=0
    probe() { # label url body expected
      local label="$1" url="$2" body="$3" want="$4" sig code
      sig="$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$secret" -hex | sed 's/.*= //')"
      code="$(curl -sk -o /dev/null -w '%{http_code}' -X POST "$url" \
        -H 'content-type: application/json' -H "X-Remnawave-Signature: $sig" -d "$body")"
      if [[ "$code" == "$want" ]]; then
        printf '  %-46s %s\n' "$label" "$code"
      else
        printf '  %-46s %s  EXPECTED %s\n' "$label" "$code" "$want"; fail=1
      fi
    }
    probe_tampered() { # label url body
      local label="$1" url="$2" body="$3" sig code
      sig="$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$secret" -hex | sed 's/.*= //')"
      # One byte different from what was signed - what a body-rewriting proxy
      # would produce.
      code="$(curl -sk -o /dev/null -w '%{http_code}' -X POST "$url" \
        -H 'content-type: application/json' -H "X-Remnawave-Signature: $sig" -d "${body} ")"
      if [[ "$code" == 401 ]]; then
        printf '  %-46s %s\n' "$label" "$code"
      else
        printf '  %-46s %s  EXPECTED 401\n' "$label" "$code"; fail=1
      fi
    }

    # The body the facade actually emits, ASCII-escaped exactly as
    # buildRemnaWebhookBody does, including the non-ASCII case that motivates it.
    ascii='{"name":"user.expired","payload":{"user":{"uuid":"1","telegramId":null,"email":"probe@example.test","expireAt":"2030-01-01T00:00:00.000Z"}},"meta":{}}'
    escaped='{"name":"user.expired","payload":{"user":{"uuid":"1","telegramId":null,"email":"\u043f\u043e\u0447\u0442\u0430@example.test","expireAt":"2030-01-01T00:00:00.000Z"}},"meta":{}}'

    echo "stand: webhook signature through a real proxy"
    probe "ascii body, direct to the shop"        "http://127.0.0.1:8080/webhook/panel"        "$ascii"   200
    probe "ascii body, through TLS nginx"         "https://127.0.0.1:$tls_port/webhook/panel"  "$ascii"   200
    probe "escaped non-ascii body, direct"        "http://127.0.0.1:8080/webhook/panel"        "$escaped" 200
    probe "escaped non-ascii body, through nginx" "https://127.0.0.1:$tls_port/webhook/panel"  "$escaped" 200
    probe_tampered "body altered after signing, through nginx" "https://127.0.0.1:$tls_port/webhook/panel" "$ascii"

    # And the failure the ASCII escaping exists to prevent, shown rather than
    # asserted: the same payload as raw UTF-8 put through a charset transcoding,
    # against the same payload escaped. Only the first breaks, because only the
    # first has bytes above 0x7F for a proxy to change.
    python3 "$HERE/transcode_probe.py" "$secret" || fail=1

    [[ $fail -eq 0 ]] || die "the signature did not survive the path it will take in production"
    echo "stand: the signed body survives a TLS reverse proxy unchanged"
    ;;

  compare-admin)
    shift
    [[ $# -eq 2 ]] || die "usage: stand.sh compare-admin <reference.jsonl> <candidate.jsonl>"
    exec python3 "$HERE/compare_admin.py" "$1" "$2"
    ;;

  subpage)
    # The install document the panel emits, through the SHOP'S validator.
    #
    # Belongs here rather than in the backend suite for the reason the whole
    # third tier exists: a check that only consults our own opinion of the
    # contract cannot see the shop deciding our document is unusable. It fails
    # ALL-OR-NOTHING and silently, so from the panel side a discarded document
    # and an accepted one look identical.
    #
    # Needs the shop CHECKOUT (not the stand) and a live panel.
    shift
    [[ $# -ge 1 ]] || die "usage: stand.sh subpage <subscription-token> [<subscription-token> ...]"
    MINISHOP_DIR="$SHOP" exec python3 "$HERE/subpage_validate.py" "$@"
    ;;

  selftest)
    # The comparators, against walkthroughs whose answer is known. Needs no
    # stand and no docker, so there is no excuse for skipping it: a comparator
    # is a check, and an unchecked check is exactly what this stand keeps
    # finding - it reports something every run and nothing says whether that
    # something is true.
    exec python3 "$HERE/compare_admin.py" --selftest
    ;;
  status) docker ps --filter name=remnawave --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' ;;
  logs)   shift; "${compose_iceslab[@]}" logs --tail "${1:-80}" backend worker ;;

  trace)
    # The diffable half of the differential test.
    #
    # The shop logs one line per panel response carrying the OPERATION LABEL
    # from its own contract registry plus the status - and the label is
    # deliberately identifier-free ("Never log the raw URL: path/query values
    # can contain Telegram ids, usernames, emails, user ids, or UUIDs"). That
    # makes the sequence of calls comparable between two stands without any
    # normalisation of ids or timestamps.
    #
    # What a diff catches that a green run does not: the shop taking a DIFFERENT
    # PATH against us. If it reads /users instead of /users/stream, it decided
    # our panel is not really 3.x; if a call is missing entirely, it decided a
    # capability is absent. Both look like success from the outside.
    shift
    out="${1:-/dev/stdout}"
    # From this container run only. `docker logs` keeps output across restarts,
    # and a trace that carries a previous run's calls compares two things that
    # never happened together - it cost me a diff full of 403s from an unseeded
    # panel before I noticed.
    # BOTH containers. This read the backend alone until 2026-08-24, and the
    # shop is two processes: the fleet sync, the premium tariff workers and
    # every capability-gated bulk call live in the WORKER. A trace that cannot
    # see them reports "the shop never called that" about calls it was not
    # listening for - which is the answer a probe gives when it is looking in
    # the wrong place, and it is indistinguishable from the real one.
    #
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
      # Under `set -e` with pipefail that ended the whole script - no message,
      # an empty trace file, and (once this loop existed) the second container
      # never read at all.
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
    exec python3 "$HERE/compare_traces.py" "$1" "$2"
    ;;

  *)
    cat <<EOF
usage: $(basename "$0") <command>

  up-iceslab   shop -> this panel's facade (needs the panel running, facade on)
  up-ref       shop -> a real Remnawave 3.2.3 in docker (the reference half)
  down         stop both stands, keep their volumes
  reset        stop both stands AND drop their volumes
  status       what is running
  logs [n]     tail the shop's backend and worker
  trace [file] [since]
               dump the shop's panel-API call trace (operation labels + status);
               the optional RFC3339 stamp (e.g. from 'mark') scopes it to one step
  mark         print a timestamp to hand to 'trace' later
  check <iceslab|ref>
               re-check what up-* asserts, against a stand already up
  premium-probe [buylog]
               buy, wait for a full tariff tick, and check the shop really called
               POST /bandwidth-stats/nodes/usage and built a COMPLETE snapshot,
               then drive the demotion (bulk squads + connections drop).
               Brought up with HIDE_NODES_USAGE=1 it expects the FALLBACK route
               POST /bandwidth-stats/nodes/users instead, and checks the shop
               reached it by reading our 404 as an absent route.
               ~13 min: two full tariff ticks, five minutes apart
  seed-tariffs re-store the tariff catalogue on the half that is up (up-* does
               this already; without a catalogue the tariff and premium-override
               admin actions answer 400 and 502 without calling the panel)
  half <iceslab|ref> <outdir>
               one half of the differential end to end: reset, bring the stand
               up, buy, walk the admin, and write both traces into <outdir>
  compare-admin a b
               diff two admin walkthroughs (what the pages rendered)
  selftest     run the comparators against known answers (no stand, no docker)
  differential <outdir>
               both halves and all three comparisons, in one command
  full <outdir>
               everything: the differential, the webhook probe, the premium
               probe, and the premium probe again behind panel-shim for the
               fallback route. ~1 hour
  webhook-probe
               send a signed webhook through a real TLS nginx and check the
               shop still accepts it (needs the iceslab stand up)
  churn-probe [n]
               seed n users, run the shop's fleet sync, delete one mid-walk and
               count what the shop saw (needs CHURN_PAGING=1 on up-iceslab)
  compare a b  diff two traces as multisets

One at a time: the two stands share container names.
EOF
    exit 2 ;;
esac
