#!/usr/bin/env python3
"""Show the charset transcoding that an ASCII-only webhook body is immune to.

The facade signs an HMAC over the raw body, so between it and the shop any
intermediary that re-encodes character sets changes the signed bytes and the
shop answers 401 - quietly, and only for the subscribers whose data is not
ASCII. This sends the same payload twice, raw and escaped, each intact and each
transcoded, and the contrast is the finding: the raw one breaks, the escaped one
cannot, because it has no byte above 0x7F to change.
"""

import hashlib
import hmac
import json
import subprocess
import sys

SHOP_WEBHOOK = "http://127.0.0.1:8080/webhook/panel"

BODY = {
    "name": "user.expired",
    "payload": {
        "user": {
            "uuid": "1",
            "telegramId": None,
            "email": "почта@example.test",
            "expireAt": "2030-01-01T00:00:00.000Z",
        }
    },
    "meta": {},
}


def post(raw: bytes, signature: str) -> str:
    proc = subprocess.run(
        [
            "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST",
            SHOP_WEBHOOK,
            "-H", "content-type: application/json",
            "-H", f"X-Remnawave-Signature: {signature}",
            "--data-binary", "@-",
        ],
        input=raw,
        capture_output=True,
    )
    return proc.stdout.decode().strip()


def main() -> int:
    secret = sys.argv[1].encode()
    bad = 0
    for label, raw in (
        ("raw utf-8 body", json.dumps(BODY, separators=(",", ":"), ensure_ascii=False).encode("utf-8")),
        ("escaped ascii body", json.dumps(BODY, separators=(",", ":"), ensure_ascii=True).encode("ascii")),
    ):
        signature = hmac.new(secret, raw, hashlib.sha256).hexdigest()
        intact = post(raw, signature)
        # What a gateway that re-encodes the charset produces: same characters,
        # different bytes.
        transcoded = post(raw.decode("utf-8").encode("cp1251"), signature)
        print(f"  {label + ', intact':<46}{intact}")
        print(f"  {label + ', charset transcoded':<46}{transcoded}")
        if intact != "200":
            bad = 1
        if label.startswith("escaped") and transcoded != "200":
            bad = 1
        if label.startswith("raw") and transcoded == "200":
            # Not a failure of the facade, but the demonstration has stopped
            # demonstrating and somebody should know before trusting it.
            print("  (a transcoded raw body was accepted - this contrast no longer proves anything)")
    return bad


if __name__ == "__main__":
    raise SystemExit(main())
