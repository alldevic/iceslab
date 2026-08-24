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

die() { echo "stand: $*" >&2; exit 1; }

[[ -d "$SHOP" ]] || die "no minishop checkout at $SHOP (set MINISHOP_DIR)"
[[ -f "$SHOP/docker-compose-dev.yml" ]] || die "$SHOP is not a minishop checkout"

# The two stands share container names, so they cannot run at the same time.
# Their shop DATABASES are different volumes (the reference override renames
# them with a -323 suffix), which is what makes the two runs comparable instead
# of cumulative - but only one can be up.
compose_iceslab=(docker compose
  --project-directory "$SHOP"
  -f "$SHOP/docker-compose-dev.yml"
  -f "$HERE/stand.override.yml"
  --env-file "$RUNTIME_ENV")
compose_ref=(docker compose
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
    preflight_facade
    "${compose_iceslab[@]}" up -d --wait "${SHOP_SERVICES[@]}"
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
    # The shop cached "could not detect version" while the panel was unseeded.
    "${compose_ref[@]}" restart backend worker
    echo "stand: reference panel published on http://127.0.0.1:${REMNAWAVE_DEV_PANEL_PORT:-3100} (the host's 3000 is our own panel)"
    ;;
  down)
    "${compose_iceslab[@]}" down --remove-orphans || true
    "${compose_ref[@]}" down --remove-orphans || true
    ;;
  reset)
    # Volumes too. Between the two halves of a differential run this is not
    # optional: a shop database carried over from the other stand makes the
    # comparison meaningless in a way nothing announces.
    "${compose_iceslab[@]}" down -v --remove-orphans || true
    "${compose_ref[@]}" down -v --remove-orphans || true
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
    since="$(docker inspect -f '{{.State.StartedAt}}' remnawave-minishop-backend)"
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
  trace [file] dump the shop's panel-API call trace (operation labels + status)
  compare a b  diff two traces as multisets

One at a time: the two stands share container names.
EOF
    exit 2 ;;
esac
