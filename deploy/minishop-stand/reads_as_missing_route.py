#!/usr/bin/env python3
"""Does this response read to the shop as "this panel build lacks the route"?

The shop's own predicate, transcribed from
`bot/services/panel_api_responses.py::_is_missing_endpoint_response` - the same
one `remnawave.contract.test.ts::readsAsMissingRoute` transcribes on the panel
side, and for the same reason: everything the facade decides about which
capabilities the shop believes it has flows through exactly this function, so it
is reproduced rather than approximated.

Used to check the stand's own fixture. `panel-shim` claims to be a panel missing
one route, and a 404 that does NOT satisfy this reads to the shop as a request
that failed - it would go on preferring the route, the fallback would never be
reached, and the probe would report the wrong source without ever failing.

usage: reads_as_missing_route.py <status> <body>   -> exit 0 if it does
"""

import json
import sys


def reads_as_missing_route(status: int, body: str) -> bool:
    if status != 404:
        return False
    try:
        payload = json.loads(body)
    except ValueError:
        return False
    if not isinstance(payload, dict):
        return False
    details = payload.get("details")
    details = details if isinstance(details, dict) else {}
    if payload.get("errorCode") or payload.get("code") or details.get("errorCode") or details.get("code"):
        return False
    message = (
        payload.get("message")
        or details.get("message")
        or details.get("error")
        or details.get("raw_response_text")
    )
    message = str(message or "").replace("\n", " ").strip().lower()
    return "cannot post" in message or "cannot get" in message or "not found" in message


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(0 if reads_as_missing_route(int(sys.argv[1]), sys.argv[2]) else 1)
