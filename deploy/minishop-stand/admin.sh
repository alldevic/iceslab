#!/usr/bin/env bash
# Walk the shop's ADMIN API, the half of the integration that has never been
# tested.
#
# Everything before this walked the subscriber path: buy, activate, hand out a
# config. The admin pages went untested while they counted as somebody else's
# front end. They are ours - the decision of 2026-08-24 is that we do not build
# an admin of our own and use the shop's - so the same differential the purchase
# gets, they get: one run against our facade, one against a real Remnawave, and
# a comparison of both what the pages RENDER and what they CALL.
#
# The rendered half matters on its own. A trace only shows that a call was made;
# it cannot show that the answer arrived shaped in a way the page could not use.
# An admin page that draws an empty squad list, a zero user count or a blank
# health card is a page that looks like it works.
#
# Usage: ./admin.sh <out.jsonl> [buyer-email]
#
# `buyer-email` is the account buy.sh purchased with. Given one, the panel-
# touching mutations target that user - the only one on this stand whose panel
# user actually exists. Without it they are skipped rather than run against a
# seeded user whose panel uuid was never on any panel: a 404 identical on both
# stands proves nothing about the facade.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${STAND_ENV:-$HERE/iceslab.env}"
SHOP="${SHOP_URL:-http://127.0.0.1:8082}"
OUT="${1:?usage: admin.sh <out.jsonl> [buyer-email]}"
BUYER="${2:-}"
JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT

die() { echo "admin: $*" >&2; exit 1; }
envval() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }

# The admin is whoever the shop's own demo seed inserted with a telegram_id that
# ADMIN_IDS names; the shop's email auth binds a login to an EXISTING row by
# address (`user_dal.get_user_by_email`), so signing in as that address is
# signing in as the admin. An email-only user cannot be one - the middleware
# reads telegram_id and finds None.
ADMIN_EMAIL="${ADMIN_EMAIL:-runes.admin@example.com}"

CSRF=""
call() { # method path [body]
  local method="$1" path="$2" body="${3:-}"
  curl -sS -o "$TMPBODY" -w '%{http_code}' -b "$JAR" -c "$JAR" \
    -H 'content-type: application/json' \
    ${CSRF:+-H "X-CSRF-Token: $CSRF"} \
    -X "$method" "$SHOP$path" ${body:+-d "$body"}
}

TMPBODY="$(mktemp)"; trap 'rm -f "$JAR" "$TMPBODY"' EXIT

record() { # name method path [body]
  local name="$1" method="$2" path="$3" body="${4:-}" code
  code="$(call "$method" "$path" "$body")"
  python3 - "$name" "$method" "$path" "$code" "$TMPBODY" >> "$OUT" <<'PY'
import json, sys
name, method, path, code, bodyfile = sys.argv[1:6]
raw = open(bodyfile, "rb").read()
try:
    body = json.loads(raw)
except Exception:
    body = {"__nonjson__": raw.decode("utf-8", "replace")[:2000]}
print(json.dumps({"step": name, "method": method, "path": path,
                  "status": int(code), "body": body},
                 sort_keys=True, ensure_ascii=False))
PY
  printf '  %-34s %s %s -> %s\n' "$name" "$method" "$path" "$code" >&2
}

: > "$OUT"

echo "admin: signing in as $ADMIN_EMAIL" >&2
REQ="$(curl -sS -b "$JAR" -c "$JAR" -H 'content-type: application/json' \
  -X POST "$SHOP/api/auth/email/request" -d "{\"email\":\"$ADMIN_EMAIL\"}")"
CODE="$(python3 - "$REQ" <<'PY'
import json,sys,re
d=json.loads(sys.argv[1])
def find(o):
    if isinstance(o,dict):
        for k,v in o.items():
            if 'code' in k.lower() and isinstance(v,str) and re.fullmatch(r'\d{4,8}',v): return v
            r=find(v)
            if r: return r
    elif isinstance(o,list):
        for v in o:
            r=find(v)
            if r: return r
    return None
print(find(d) or '')
PY
)"
[[ -n "$CODE" ]] || die "no verification code in the response - QA_AUTH_ENABLED off? $REQ"
VER="$(curl -sS -b "$JAR" -c "$JAR" -H 'content-type: application/json' \
  -X POST "$SHOP/api/auth/email/verify" -d "{\"email\":\"$ADMIN_EMAIL\",\"code\":\"$CODE\"}")"
CSRF="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("csrf_token",""))' "$VER")"
[[ -n "$CSRF" ]] || die "no csrf_token in the verify response: $VER"

# Prove the session is an ADMIN session before recording a single page. Every
# admin route answers 403 to a non-admin, and 403-vs-403 compares clean: the
# walkthrough would pass by testing nothing.
ME_CODE="$(call GET /api/admin/me)"
[[ "$ME_CODE" == 200 ]] || die "GET /api/admin/me answered $ME_CODE - $ADMIN_EMAIL is not in ADMIN_IDS,
or the shop's demo seed did not run. $(head -c 300 "$TMPBODY")"

# The buyer's shop user id, resolved through the admin list rather than assumed:
# it is assigned by the shop and differs between the two stands.
TARGET=""
if [[ -n "$BUYER" ]]; then
  # Via a file, not a pipe: a heredoc script IS stdin, so `curl | python3 - <<'PY'`
  # hands the reader the script and throws the JSON away.
  curl -sS -b "$JAR" -o "$TMPBODY" "$SHOP/api/admin/users?limit=200"
  TARGET="$(python3 - "$BUYER" "$TMPBODY" <<'PY'
import json,sys
email=sys.argv[1].lower()
d=json.load(open(sys.argv[2], encoding="utf-8"))
def walk(o):
    if isinstance(o,dict):
        if str(o.get("email") or "").lower()==email and o.get("user_id") is not None:
            return o["user_id"]
        for v in o.values():
            r=walk(v)
            if r is not None: return r
    elif isinstance(o,list):
        for v in o:
            r=walk(v)
            if r is not None: return r
    return None
print(walk(d) if walk(d) is not None else "")
PY
)"
  [[ -n "$TARGET" ]] || die "no shop user with email $BUYER in the admin list - did buy.sh run on THIS stand?"
  echo "admin: panel-backed target user = $TARGET ($BUYER)" >&2
fi

echo "admin: reading the pages" >&2
record me                GET /api/admin/me
record stats             GET /api/admin/stats
record health            GET /api/admin/health
record panel-squads      GET /api/admin/panel/internal-squads
record users-list        GET '/api/admin/users?limit=50'
record user-seeded       GET /api/admin/users/910000002
record user-seeded-refs  GET /api/admin/users/910000002/referrals
record payments          GET '/api/admin/payments?limit=50'
record promos            GET /api/admin/promos
record promo-options     GET /api/admin/promos/options
record logs              GET /api/admin/logs
record support-tickets   GET /api/admin/support/tickets
record support-stats     GET /api/admin/support/stats
record audience-counts   GET /api/admin/broadcast/audience-counts
record broadcast-codes   GET /api/admin/broadcast/shortcodes
record broadcasts        GET /api/admin/broadcasts
record ads               GET /api/admin/ads
record settings          GET /api/admin/settings
record tariffs           GET /api/admin/tariffs
record tribute-catalog   GET /api/admin/tariffs/tribute/catalog
record themes            GET /api/admin/themes
record backups           GET /api/admin/backups
record partners-overview GET /api/admin/partners/overview
record partners          GET /api/admin/partners
record partners-attn     GET /api/admin/partners/attention
record partner-apps      GET /api/admin/partner-applications
record partner-withdraws GET /api/admin/partner-withdrawals

if [[ -n "$TARGET" ]]; then
  echo "admin: acting on the panel-backed user" >&2
  record user-detail       GET  "/api/admin/users/$TARGET"
  record squad-refresh     POST "/api/admin/users/$TARGET/squad-overrides/refresh"
  # Empty lists with sync_panel: an idempotent write of the user's effective
  # squads. It is the write the page makes on every save, and the one where a
  # facade that echoes squads it did not store shows up.
  record squad-sync        PATCH "/api/admin/users/$TARGET/squad-overrides" \
    '{"add_internal_squad_uuids":[],"remove_internal_squad_uuids":[],"sync_panel":true}'
  record hwid-limit        POST "/api/admin/users/$TARGET/hwid-device-limit" '{"hwid_device_limit":3}'
  record traffic-strategy  POST "/api/admin/users/$TARGET/traffic-strategy" '{"traffic_limit_strategy":"MONTH"}'
  record traffic-grant     POST "/api/admin/users/$TARGET/traffic-grant" '{"kind":"regular","gb":1}'
  record extend            POST "/api/admin/users/$TARGET/extend" '{"days":7}'
  # Reaches the panel through sync_main_traffic_limit_to_panel - a PATCH of the
  # user's traffic limit, which is the field the shop bills on.
  record traffic-override  POST "/api/admin/users/$TARGET/regular-traffic-override" '{"gb":50}'
  # These two would reach the panel (a squad switch and a premium-squad push,
  # the most facade-relevant writes the admin can make) but both stop earlier
  # while the shop has no tariff catalogue: `tariff` answers 400
  # tariffs_not_configured and `premium-override` answers 502 without making a
  # single panel call. Recorded anyway, because they are pages an operator uses
  # and the two halves must agree about them - but they prove nothing about the
  # facade until a catalogue with REAL squad uuids exists on this stand.
  record premium-override  POST "/api/admin/users/$TARGET/premium-override" '{"enabled":true}'
  record tariff-switch     POST "/api/admin/users/$TARGET/tariff" '{"tariff_key":"standard"}'
  record sub-reissue       POST "/api/admin/users/$TARGET/subscription-reissue"
  record user-detail-after GET  "/api/admin/users/$TARGET"
  # Last, and destructive: delete_user_from_panel is a real panel call, and
  # after it the target is gone for anything that came before.
  record user-delete       DELETE "/api/admin/users/$TARGET"
  record user-detail-gone  GET    "/api/admin/users/$TARGET"
fi

# Last, because it queues fleet-wide work on the worker: anything recorded after
# it would race the sync's own panel calls.
record sync              POST /api/admin/sync '{}'

echo "admin: wrote $(wc -l < "$OUT") step(s) to $OUT" >&2
