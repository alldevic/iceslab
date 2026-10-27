#!/usr/bin/env python3
"""Run the install document the panel emits through the SHOP'S OWN validator.

The panel builds a Subscription Page v1 document for each subscription
(`remnawave-compat/subpage`). Whether that document is any good is not our
opinion to hold: the shop validates it all-or-nothing, and a document that
fails ANY rule is discarded whole, with the buyer silently getting the shop's
generic guide (or, when the shop's own default file is not on disk, no guide at
all — seen on this stand, 2026-08-25). Nothing about that failure is visible
from the panel side. A green panel test suite proves only that we agree with
ourselves.

So this check imports `config.subscription_guides_config` out of the shop's
checkout and runs the real thing. It also mutates the document seven ways and
requires each mutation to be REJECTED — otherwise "the validator accepted it"
would mean nothing more than "the validator ran".

    ./subpage_validate.py <subscription-token> [<subscription-token> ...]

Env:
    PANEL_URL     panel base, default http://127.0.0.1:3000
    PANEL_TOKEN   icp_ API token, default read from
                  /var/tmp/iceslab-vmlab/minishop-panel-token
    MINISHOP_DIR  shop checkout, default /home/stdfo/workspace/minishop-361
"""

from __future__ import annotations

import copy
import json
import os
import sys
import urllib.request

PANEL_URL = os.environ.get("PANEL_URL", "http://127.0.0.1:3000").rstrip("/")
MINISHOP_DIR = os.environ.get("MINISHOP_DIR", "/home/stdfo/workspace/minishop-361")
TOKEN_FILE = "/var/tmp/iceslab-vmlab/minishop-panel-token"

sys.path.insert(0, os.path.join(MINISHOP_DIR, "backend"))
try:
    from config.subscription_guides_config import (  # noqa: E402
        SubscriptionGuidesConfigError,
        validate_panel_subscription_guides_config,
    )
except ImportError as exc:  # pragma: no cover - operator-facing
    sys.exit(f"subpage: cannot import the shop's validator from {MINISHOP_DIR}: {exc}")


def panel_token() -> str:
    token = os.environ.get("PANEL_TOKEN", "")
    if token:
        return token
    try:
        with open(TOKEN_FILE, encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError as exc:
        sys.exit(f"subpage: no PANEL_TOKEN and cannot read {TOKEN_FILE}: {exc}")


def fetch(token: str, sub_token: str) -> dict:
    req = urllib.request.Request(
        f"{PANEL_URL}/rw/api/subscriptions/subpage-config/{sub_token}",
        headers={"Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


# Each mutation breaks one rule the shop enforces. If a mutation is ACCEPTED the
# validator is not looking at what we think it is looking at, and every "OK"
# printed by this script is worth nothing.
MUTATIONS = [
    ("svgLibrary removed", lambda d: d.pop("svgLibrary", None)),
    (
        "svgIconKey not in the library",
        lambda d: d["platforms"][next(iter(d["platforms"]))]["apps"][0]["blocks"][0].__setitem__(
            "svgIconKey", "NoSuchIcon"
        ),
    ),
    (
        "platform with no apps",
        lambda d: d["platforms"][next(iter(d["platforms"]))].__setitem__("apps", []),
    ),
    (
        "a locale missing from a block title",
        lambda d: d["platforms"][next(iter(d["platforms"]))]["apps"][0]["blocks"][0]["title"].pop(
            d["locales"][-1]
        ),
    ),
    ("version is not '1'", lambda d: d.__setitem__("version", "2")),
    (
        "a platform the shop does not know",
        lambda d: d["platforms"].__setitem__("router", d["platforms"][next(iter(d["platforms"]))]),
    ),
    (
        "javascript: in a button link",
        lambda d: d["platforms"][next(iter(d["platforms"]))]["apps"][0]["blocks"][0]["buttons"][
            0
        ].__setitem__("link", "javascript:alert(1)"),
    ),
]


def check(sub_token: str, api_token: str) -> bool:
    payload = fetch(api_token, sub_token)
    body = payload.get("response", payload)
    if not body:
        print(f"  --   {sub_token[:12]}…: panel has nothing to say (shop keeps its own guide)")
        return True

    try:
        cfg = validate_panel_subscription_guides_config(payload)
    except SubscriptionGuidesConfigError as exc:
        print(f"  FAIL {sub_token[:12]}…: the shop would DISCARD this document: {exc}")
        return False

    plats = {k: [a["name"] for a in v["apps"]] for k, v in cfg["platforms"].items()}
    print(f"  OK   {sub_token[:12]}…: v1 accepted, locales={cfg['locales']}")
    for k, apps in plats.items():
        print(f"         {k:10s} {apps}")

    ok = True
    for name, mutate in MUTATIONS:
        broken = copy.deepcopy(payload)
        try:
            mutate(broken.get("response", broken))
        except (KeyError, IndexError, ValueError):
            # Not applicable to this document's shape (no buttons, one locale).
            continue
        try:
            validate_panel_subscription_guides_config(broken)
        except SubscriptionGuidesConfigError:
            continue
        print(f"  FAIL {sub_token[:12]}…: validator ACCEPTED a document with {name}")
        ok = False
    return ok


def main() -> int:
    tokens = sys.argv[1:]
    if not tokens:
        sys.exit(__doc__)
    api_token = panel_token()
    print(f"subpage: validating against {MINISHOP_DIR}")
    failed = [t for t in tokens if not check(t, api_token)]
    if failed:
        print(f"subpage: {len(failed)} of {len(tokens)} would be discarded by the shop")
        return 1
    print(f"subpage: {len(tokens)} document(s) the shop accepts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
