#!/usr/bin/env python3
"""Configure the shop's tariff catalogue, on whichever panel it is pointed at.

Without a catalogue the two admin actions that reach the panel through a tariff
never get there: `POST /admin/users/{id}/tariff` answers 400
`tariffs_not_configured` and `POST /admin/users/{id}/premium-override` answers
502 without a single call to the panel. Both halves of the differential then
compare two refusals, which is a comparison of nothing.

The catalogue is `tariffs.template.json` next to this file, with squads written
as `@<name>`. The names are resolved HERE, per half, against the squads the shop
itself can see (`GET /api/admin/panel/internal-squads`) - the two panels mint
their own uuids, so a catalogue with fixed ones would be wrong on one half and
would fail inside the shop, before any panel call.

Written through the shop's own admin API rather than into the volume: the shop
validates the payload, reconciles existing subscriptions against it, and
refreshes its caches. A file dropped in beside it would skip all three.

Usage: seed_tariffs.py [--template FILE] [--shop URL] [--admin-email ADDR]
Exit 0 = catalogue stored and read back with every squad resolved.
"""
from __future__ import annotations

import argparse
import http.client
import json
import re
import sys
import urllib.parse

REQUIRED_TARIFF_KEYS = ("standard", "pro")  # what buy.sh and admin.sh name


class Shop:
    """The shop's web API with a cookie jar, kept deliberately small.

    http.cookiejar declines to store cookies whose host is a bare IP under its
    default policy, which is exactly what the stand is - so the jar is a dict
    and the Cookie header is built by hand.
    """

    def __init__(self, base: str) -> None:
        self.url = urllib.parse.urlparse(base)
        self.cookies: dict[str, str] = {}
        self.csrf: str | None = None

    def call(self, method: str, path: str, body: object | None = None) -> tuple[int, object]:
        conn = http.client.HTTPConnection(self.url.hostname, self.url.port or 80, timeout=180)
        headers = {"accept": "application/json"}
        if self.cookies:
            headers["cookie"] = "; ".join(f"{k}={v}" for k, v in self.cookies.items())
        if self.csrf:
            headers["X-CSRF-Token"] = self.csrf
        payload = None
        if body is not None:
            payload = json.dumps(body).encode()
            headers["content-type"] = "application/json"
        conn.request(method, path, payload, headers)
        res = conn.getresponse()
        raw = res.read()
        for name, value in res.getheaders():
            if name.lower() == "set-cookie":
                for chunk in re.split(r",(?=[^;=]+=)", value):
                    pair = chunk.split(";", 1)[0].strip()
                    if "=" in pair:
                        k, v = pair.split("=", 1)
                        self.cookies[k] = v
        conn.close()
        try:
            return res.status, json.loads(raw)
        except Exception:
            return res.status, {"__nonjson__": raw.decode("utf-8", "replace")[:500]}

    def sign_in(self, email: str) -> None:
        status, body = self.call("POST", "/api/auth/email/request", {"email": email})
        code = _find_code(body)
        if not code:
            die(f"no verification code in the auth response ({status}) - QA_AUTH_ENABLED off? {body}")
        status, body = self.call("POST", "/api/auth/email/verify", {"email": email, "code": code})
        token = body.get("csrf_token") if isinstance(body, dict) else None
        if not token:
            die(f"no csrf_token in the verify response ({status}): {body}")
        self.csrf = token
        status, body = self.call("GET", "/api/admin/me")
        if status != 200:
            die(f"GET /api/admin/me answered {status} - {email} is not an admin on this stand: {body}")


def die(message: str) -> None:
    print(f"tariffs: {message}", file=sys.stderr)
    raise SystemExit(1)


def _find_code(payload: object) -> str | None:
    if isinstance(payload, dict):
        for key, value in payload.items():
            if "code" in key.lower() and isinstance(value, str) and re.fullmatch(r"\d{4,8}", value):
                return value
            found = _find_code(value)
            if found:
                return found
    elif isinstance(payload, list):
        for value in payload:
            found = _find_code(value)
            if found:
                return found
    return None


def strip_comments(node: object) -> object:
    """Drop the template's own annotations; the shop's model does not want them."""
    if isinstance(node, dict):
        return {k: strip_comments(v) for k, v in node.items() if not k.startswith("_")}
    if isinstance(node, list):
        return [strip_comments(v) for v in node]
    return node


def resolve(node: object, squads: dict[str, str], unresolved: list[str]) -> object:
    """Replace every `@<squad name>` with that squad's uuid on THIS panel."""
    if isinstance(node, dict):
        return {k: resolve(v, squads, unresolved) for k, v in node.items()}
    if isinstance(node, list):
        return [resolve(v, squads, unresolved) for v in node]
    if isinstance(node, str) and node.startswith("@"):
        name = node[1:]
        if name not in squads:
            unresolved.append(name)
            return node
        return squads[name]
    return node


def find_placeholders(node: object) -> list[str]:
    if isinstance(node, dict):
        return [p for v in node.values() for p in find_placeholders(v)]
    if isinstance(node, list):
        return [p for v in node for p in find_placeholders(v)]
    if isinstance(node, str) and node.startswith("@"):
        return [node]
    return []


def squad_uuids_in(catalog: object) -> set[str]:
    found: set[str] = set()

    def walk(node: object) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                if key.endswith("squad_uuids") and isinstance(value, list):
                    found.update(v for v in value if isinstance(v, str))
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(catalog)
    return found


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--template", default=None)
    parser.add_argument("--shop", default="http://127.0.0.1:8082")
    parser.add_argument("--admin-email", default="runes.admin@example.com")
    args = parser.parse_args()

    here = __file__.rsplit("/", 1)[0]
    template_path = args.template or f"{here}/tariffs.template.json"
    with open(template_path, encoding="utf-8") as handle:
        template = json.load(handle)

    shop = Shop(args.shop)
    shop.sign_in(args.admin_email)

    status, body = shop.call("GET", "/api/admin/panel/internal-squads")
    if status != 200 or not isinstance(body, dict):
        die(f"the shop could not list the panel's squads ({status}): {body}")
    rows = body.get("squads") or []
    squads = {row["name"]: row["uuid"] for row in rows if row.get("name") and row.get("uuid")}
    if not squads:
        die("the panel reports no squads at all, so no tariff can name one")

    catalog = strip_comments(template)
    unresolved: list[str] = []
    catalog = resolve(catalog, squads, unresolved)
    if unresolved:
        die(
            "these squads are not on this panel: "
            + ", ".join(sorted(set(unresolved)))
            + "\navailable: "
            + ", ".join(sorted(squads))
            + "\nA tariff pointing at a squad the panel does not have is refused by the"
            "\nshop before it makes a single panel call, so the walkthrough would prove"
            "\nnothing. Create the squads on the panel first."
        )

    status, body = shop.call("PUT", "/api/admin/tariffs", {"catalog": catalog})
    if status != 200:
        die(f"the shop refused the catalogue ({status}): {json.dumps(body)[:600]}")

    # Read it back rather than trust the write. The save route answers with what
    # it parsed, and what the next request will read is the FILE.
    status, body = shop.call("GET", "/api/admin/tariffs")
    if status != 200 or not isinstance(body, dict):
        die(f"could not read the catalogue back ({status}): {body}")
    stored = body.get("catalog") or {}
    if not body.get("exists"):
        die("the shop says no catalogue file exists after a successful save")

    leftovers = find_placeholders(stored)
    if leftovers:
        die(f"placeholders survived into the stored catalogue: {sorted(set(leftovers))}")

    stored_keys = {t.get("key") for t in stored.get("tariffs") or []}
    missing = [k for k in REQUIRED_TARIFF_KEYS if k not in stored_keys]
    if missing:
        die(
            f"the stored catalogue has no tariff {missing} - buy.sh and admin.sh name them,"
            f" and would get 400 invalid_plan. Stored: {sorted(stored_keys)}"
        )

    referenced = squad_uuids_in(stored)
    stray = sorted(referenced - set(squads.values()))
    if stray:
        die(f"the stored catalogue references squads this panel does not have: {stray}")
    if not referenced:
        die("the stored catalogue names no squad at all, so no tariff can move one")

    print(
        "tariffs: stored "
        + ", ".join(sorted(stored_keys))
        + " -> squads "
        + ", ".join(sorted(name for name, uuid in squads.items() if uuid in referenced))
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
