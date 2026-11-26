#!/usr/bin/env python3
"""Does this response read to the shop as "this panel build lacks the route"?

The shop's own predicate, `bot/services/panel_api_responses.py::
_is_missing_endpoint_response` (v3.8.6), applied to the dict the shop's request
layer builds from a non-2xx answer (`panel_api_core.py`): the status, and a
`details` dict that starts as `{message: "Request failed with status N",
raw_response_text: <body>}` and is updated with the body's own keys when the
answer is `application/json`. The same predicate is transcribed on the panel side
in `remnawave.contract.test.ts` (`readsAsMissingRoute`).

Everything the facade decides about which capabilities the shop believes it has
flows through exactly this function, so it is reproduced rather than approximated.
Used to check the stand's own fixture: `panel-shim` claims to be a panel missing
one route, and a 404 that does NOT satisfy this reads to the shop as a failed
request. The shop would go on preferring the route, the fallback would never be
reached, and the probe would report the wrong source without failing.

    reads_as_missing_route.py <status> <content-type> <body>   exit 0 if it does
    reads_as_missing_route.py --selftest
"""

import json
import sys


def shop_response(status: int, content_type: str, body: str) -> dict:
    """The dict the shop's request layer returns for a non-2xx answer."""
    details = {
        "message": f"Request failed with status {status}",
        "raw_response_text": body,
    }
    if "application/json" in content_type.lower():
        try:
            parsed = json.loads(body)
        except ValueError:
            parsed = None
        if isinstance(parsed, dict):
            details.update(parsed)
    return {"error": True, "status_code": status, "details": details}


def reads_as_missing_route(status: int, content_type: str, body: str) -> bool:
    response = shop_response(status, content_type, body)
    if response["status_code"] != 404:
        return False
    details = response["details"]
    code = response.get("errorCode") or response.get("code") or details.get("errorCode") or details.get("code")
    if code:
        return False
    message = (
        response.get("message")
        or details.get("message")
        or details.get("error")
        or details.get("raw_response_text")
    )
    message = str(message or "").replace("\n", " ").strip().lower()
    return "cannot post" in message or "cannot get" in message or "not found" in message


def selftest() -> int:
    fastify = '{"message":"Route POST:/rw/api/x not found","error":"Not Found","statusCode":404}'
    cases = [
        ("the panel's own router miss", 404, "application/json; charset=utf-8", fastify, True),
        ("the same body, not declared as JSON", 404, "text/plain", fastify, False),
        ("a 404 that carries an errorCode", 404, "application/json", '{"errorCode":"A062","message":"not found"}', False),
        ("a 404 with no message at all", 404, "application/json", "{}", False),
        ("express-style text", 404, "text/html", "Cannot POST /x", False),
        ("a 500", 500, "application/json", fastify, False),
    ]
    failed = 0
    for name, status, ctype, body, want in cases:
        got = reads_as_missing_route(status, ctype, body)
        failed += got != want
        print(f"  {'ok  ' if got == want else 'FAIL'} reads_as_missing_route: {name} -> {got}")
    return 1 if failed else 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--selftest"]:
        raise SystemExit(selftest())
    if len(sys.argv) != 4:
        print(__doc__.strip().splitlines()[-2], file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(0 if reads_as_missing_route(int(sys.argv[1]), sys.argv[2], sys.argv[3]) else 1)
