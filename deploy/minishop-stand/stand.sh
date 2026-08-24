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
# The shop's compose is read with --project-directory pointed at ITS checkout,
# so every relative path in our override would resolve there. Absolute, via the
# environment, is the only way our files stay ours.
export STAND_DIR="$HERE"

die() { echo "stand: $*" >&2; exit 1; }

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
  --env-file "$RUNTIME_ENV")
compose_ref=(docker compose
  -p "$STAND_PROJECT"
  --project-directory "$SHOP"
  -f "$SHOP/docker-compose-dev.yml"
  -f "$SHOP/docker-compose.remnawave-dev.yml"
  --env-file "$HERE/remnawave-ref.env")

# newt is a tunnel client the stand has no use for; the env files carry
# placeholder credentials only so `docker compose config` can interpolate. Name
# the services explicitly rather than relying on that.
SHOP_SERVICES=(postgres redis migrate backend worker frontend)

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

# Live-risk (3) end to end: the shop's own fleet sync, walking our /users/stream
# while the set changes underneath it.
#
# The unit test proves the panel's paging with inject. This proves the thing the
# risk is actually about: the SHOP walking every page to decide who still exists,
# and a user it never sees being marked PANEL_USER_NOT_FOUND. It needs the walk
# to take more than an instant, so the probe rewrites two of the shop's own knobs
# in the runtime env - a five-user page and a one-second pause between pages -
# and puts them there rather than in the committed template, because the
# differential's two halves must stay comparable.
churn_probe_env() {
  fill_token
  local size="${CHURN_PAGE_SIZE:-5}" delay="${CHURN_PAGE_DELAY:-1.0}"
  {
    echo "PANEL_ALL_USERS_PAGE_SIZE=$size"
    echo "PANEL_ALL_USERS_PAGE_DELAY_SECONDS=$delay"
  } >> "$RUNTIME_ENV"
  echo "stand: sync paging forced to $size users, ${delay}s between pages"
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
    ref)     env_file="$HERE/remnawave-ref.env"; set -- "${compose_ref[@]}" ;;
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

# Our panel is not part of the stand's volumes, so `reset` does not touch it -
# and the shop finds a panel user by EMAIL. A buyer left over from an earlier
# run therefore turns the purchase into an UPDATE of an existing panel user,
# while the reference panel (whose database IS a stand volume) starts empty and
# takes a CREATE. The two halves then diverge on a trace line, and the finding
# is the stand's, not the facade's - which is exactly the kind of false positive
# that teaches you to stop believing the diff.
purge_panel_buyer() {
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

case "${1:-}" in
  up-iceslab)
    fill_token
    if [[ -n "${CHURN_PAGING:-}" ]]; then
      {
        echo "PANEL_ALL_USERS_PAGE_SIZE=${CHURN_PAGE_SIZE:-5}"
        echo "PANEL_ALL_USERS_PAGE_DELAY_SECONDS=${CHURN_PAGE_DELAY:-1.0}"
      } >> "$RUNTIME_ENV"
      echo "stand: sync paging forced to ${CHURN_PAGE_SIZE:-5} users, ${CHURN_PAGE_DELAY:-1.0}s between pages"
    fi
    preflight_facade
    "${compose_iceslab[@]}" --profile seed up -d --wait "${SHOP_SERVICES[@]}"
    # The shop's demo fixtures, same as the reference half runs: without them
    # there is no user whose telegram_id is in ADMIN_IDS, and the admin API
    # answers 403 to everything. Seed BEFORE the restart, so both halves reach
    # the walkthrough with the same cache state.
    "${compose_iceslab[@]}" --profile seed up --no-deps dev-seed \
      || echo "stand: the shop's own demo seed exited non-zero (expected at v3.6.1, see stand.override.yml)" >&2
    assert_admin_seeded iceslab
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
    # `--profile seed` on the way down too: without it the exited seed container
    # is left behind, and the next run tries to start that stale container on a
    # network `down -v` has already removed ("network ... not found").
    "${compose_iceslab[@]}" --profile seed down --remove-orphans || true
    "${compose_ref[@]}" --profile seed down --remove-orphans || true
    ;;
  reset)
    # Volumes too. Between the two halves of a differential run this is not
    # optional: a shop database carried over from the other stand makes the
    # comparison meaningless in a way nothing announces.
    "${compose_iceslab[@]}" --profile seed down -v --remove-orphans || true
    "${compose_ref[@]}" --profile seed down -v --remove-orphans || true
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
      ref)     env_for_half="$HERE/remnawave-ref.env" ;;
      *) die "half: expected iceslab or ref, got $which" ;;
    esac
    "$0" reset
    # Only the iceslab half needs this: the reference panel's database is a
    # stand volume and `reset` already dropped it. An `if`, not `[[ ]] &&`: a
    # false test as the last statement of the branch would end the script under
    # `set -e`.
    if [[ "$which" == iceslab ]]; then
      purge_panel_buyer "${STAND_BUYER:-stand-buyer@example.com}"
    fi
    "$0" "up-$which"
    STAND_ENV="$env_for_half" "$HERE/buy.sh" "${STAND_BUYER:-stand-buyer@example.com}" \
      > "$outdir/$which-buy.log" 2>&1 \
      || { tail -20 "$outdir/$which-buy.log" >&2; die "the purchase failed on the $which stand"; }
    "$0" trace "$outdir/$which-buy.trace"
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
    echo; echo "===== call traces: the purchase ====="
    python3 "$HERE/compare_traces.py" "$outdir/ref-buy.trace" "$outdir/iceslab-buy.trace" || true
    echo; echo "===== call traces: the admin walkthrough ====="
    python3 "$HERE/compare_traces.py" "$outdir/ref-admin.trace" "$outdir/iceslab-admin.trace" || true
    echo; echo "===== what the admin pages rendered ====="
    python3 "$HERE/compare_admin.py" "$outdir/ref-admin.jsonl" "$outdir/iceslab-admin.jsonl" || true
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

    until docker logs --since "$mark" remnawave-minishop-worker 2>&1 | grep -q 'Panel records checked'; do
      sleep 1
    done
    checked="$(docker logs --since "$mark" remnawave-minishop-worker 2>&1 \
      | grep -oE 'Panel records checked: [0-9]+' | tail -1 | grep -oE '[0-9]+')"
    echo
    echo "stand: panel had $total users; one was deleted after the walk collected it"
    echo "stand: the shop walked $checked"
    if [[ "$checked" == "$total" ]]; then
      echo "stand: nothing was lost - every user the walk should have seen, it saw"
    else
      echo "stand: LOST $((total - checked)) user(s) that were alive throughout the walk." >&2
      echo "The shop reads each of them as deleted from the panel." >&2
      exit 1
    fi
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
    [[ $fail -eq 0 ]] || die "the signature did not survive the path it will take in production"
    echo "stand: the signed body survives a TLS reverse proxy unchanged"
    ;;

  compare-admin)
    shift
    [[ $# -eq 2 ]] || die "usage: stand.sh compare-admin <reference.jsonl> <candidate.jsonl>"
    exec python3 "$HERE/compare_admin.py" "$1" "$2"
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
    since="${2:-$(docker inspect -f '{{.State.StartedAt}}' remnawave-minishop-backend)}"
    docker logs --since "$since" remnawave-minishop-backend 2>&1 \
      | grep -oE 'method=[A-Z]+ endpoint=[^ ]+ status=[0-9]+' \
      | sed -E 's/method=([A-Z]+) endpoint=([^ ]+) status=([0-9]+)/\1 \2 \3/' \
      > "$out"
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
  half <iceslab|ref> <outdir>
               one half of the differential end to end: reset, bring the stand
               up, buy, walk the admin, and write both traces into <outdir>
  compare-admin a b
               diff two admin walkthroughs (what the pages rendered)
  differential <outdir>
               both halves and all three comparisons, in one command
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
