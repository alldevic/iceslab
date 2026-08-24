#!/usr/bin/env bash
# One scripted purchase through the shop's public webapp API, end to end, with
# no Telegram and no payment gateway.
#
# Both are the shop's own QA affordances, not something bolted on:
#   QA_AUTH_ENABLED    - the public auth API returns the email code in its own
#                        response, so a session can be obtained without a real
#                        mailbox or Telegram OAuth
#   QA_PAYMENT_ENABLED - a `qa` payment provider whose webhook is HMAC-signed
#                        with QA_PAYMENT_SECRET, so an activation can be
#                        completed with one signed POST
#
# Activation is the point: it is when the shop WRITES to the panel. Everything
# before it is the shop talking to itself.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${STAND_ENV:-$HERE/iceslab.env}"
SHOP="${SHOP_URL:-http://127.0.0.1:8082}"
HOOK="${SHOP_HOOK_URL:-http://127.0.0.1:8080}"
JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT

envval() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }
QA_SECRET="$(envval QA_PAYMENT_SECRET)"
[[ -n "$QA_SECRET" ]] || { echo "buy: QA_PAYMENT_SECRET missing from $ENV_FILE" >&2; exit 1; }

EMAIL="${1:-stand-$(date +%s)@example.com}"
MONTHS="${MONTHS:-1}"
j() { python3 -c 'import json,sys; d=json.load(sys.stdin); print(eval("d"+sys.argv[1]))' "$1"; }
CSRF=""
# The webapp double-submits a CSRF token: a cookie plus X-CSRF-Token, compared
# with compare_digest. Verify hands the token back in its response body, and
# every mutating call after that needs it.
post() {
  curl -sS -b "$JAR" -c "$JAR" -H 'content-type: application/json' \
    ${CSRF:+-H "X-CSRF-Token: $CSRF"} -X POST "$SHOP$1" -d "$2"
}

echo "buy: email=$EMAIL"

echo "buy: 1/5 requesting a code"
REQ="$(post /api/auth/email/request "{\"email\":\"$EMAIL\"}")"
# QA mode is what puts the code in the response. If it is absent the stand is
# misconfigured, and saying so beats failing four steps later on an empty code.
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
[[ -n "$CODE" ]] || { echo "buy: no verification code in the response - is QA_AUTH_ENABLED=True and APP_RUNTIME_MODE a dev/test value?" >&2; echo "$REQ" | head -c 400 >&2; exit 1; }
echo "buy: got code $CODE"

echo "buy: 2/5 verifying"
VER="$(post /api/auth/email/verify "{\"email\":\"$EMAIL\",\"code\":\"$CODE\"}")"
CSRF="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("csrf_token",""))' "$VER")"
[[ -n "$CSRF" ]] || { echo "buy: no csrf_token in the verify response" >&2; echo "$VER" >&2; exit 1; }
echo "buy: session established, csrf ${CSRF:0:12}…"

echo "buy: 3/5 creating a QA payment"
PAY="$(post /api/payments "{\"method\":\"qa\",\"months\":$MONTHS}")"
echo "$PAY" | head -c 400; echo
PAYMENT_ID="$(python3 -c 'import json,sys,re
d=json.loads(sys.argv[1])
def find(o):
    if isinstance(o,dict):
        for k,v in o.items():
            if k in ("payment_id","id") and isinstance(v,(int,str)): return str(v)
            r=find(v)
            if r: return r
    elif isinstance(o,list):
        for v in o:
            r=find(v)
            if r: return r
    return None
print(find(d) or "")' "$PAY")"
[[ -n "$PAYMENT_ID" ]] || { echo "buy: no payment id in the response" >&2; exit 1; }
echo "buy: payment $PAYMENT_ID"

# The webhook has to echo the invoice. The provider refuses to finalize when a
# "successful" callback omits either monetary field - "treating a missing
# currency as the default currency would turn an unverified callback into a paid
# order" - so take the price from the shop's own quote for the same months
# rather than inventing one. GET /api/payments/{id} reports status only.
QUOTE="$(post /api/subscription/quote "{\"months\":$MONTHS,\"method\":\"qa\"}")"
read -r AMOUNT CURRENCY <<<"$(python3 -c '
import json,sys
d=json.loads(sys.argv[1])
# `payable` is a boolean flag, not a price - the amount is effective_amount
# (subtotal minus discount plus addons), which is what the shop charges.
amount = d.get("effective_amount")
if amount is None: amount = d.get("subtotal_amount")
print(amount, d.get("currency"))' "$QUOTE")"
[[ -n "$AMOUNT" && "$AMOUNT" != None ]] || { echo "buy: no price in the quote" >&2; echo "$QUOTE" | head -c 800 >&2; exit 1; }
echo "buy: quote $(echo "$QUOTE" | head -c 240)"
echo "buy: invoice $AMOUNT $CURRENCY"

echo "buy: 4/5 signing and posting the QA webhook"
BODY="$(python3 -c 'import json,sys; print(json.dumps({"payment_id": sys.argv[1], "status": "succeeded", "amount": sys.argv[2], "currency": sys.argv[3]}, separators=(",",":")))' "$PAYMENT_ID" "$AMOUNT" "$CURRENCY")"
SIG="$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$QA_SECRET" -hex | sed 's/.*= //')"
curl -sS -X POST "$HOOK/webhook/qa-payment" -H 'content-type: application/json' \
  -H "X-QA-Payment-Signature: $SIG" -d "$BODY" -w '\nhook: %{http_code}\n'

echo "buy: 5/5 reading the account back"
curl -sS -b "$JAR" "$SHOP/api/me" | head -c 600; echo
