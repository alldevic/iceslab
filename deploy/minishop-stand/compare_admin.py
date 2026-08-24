#!/usr/bin/env python3
"""Compare two admin walkthroughs - what the shop's admin pages RENDERED.

`compare_traces.py` next to this file compares what the shop CALLED. That alone
cannot see a page which called correctly and drew nothing: a squad list that
came back empty, a stats card of zeros, a health panel with a field the page
reads and we never sent. Those are answers the shop accepts and an operator
cannot use, and against one stand they look exactly like a working page.

So this compares the rendered bodies, on three levels, loudest first:

  status      the page answered the same way at all
  shape       the same key paths carrying the same kinds of value; a key that
              only the reference produced is a field we do not serve, and an
              empty list where the reference had entries is the classic
              silent-empty failure - so list emptiness is part of the shape
  values      the same scalars, once the unavoidably-different ones are masked

Only status and shape fail the comparison. Values are reported, because two
stands legitimately differ there (the reference IS a different panel version,
with different ids and its own clock) and a diff that cries about it every run
teaches you to stop reading it. What it must never do is hide one: every
surviving difference is printed with its path.
"""

from __future__ import annotations

import json
import re
import sys
from typing import Any

UUID = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")
ISOTS = re.compile(r"\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?")
ISODATE = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")
EMAIL = re.compile(r"\b[^\s@]+@[^\s@]+\.[A-Za-z]{2,}\b")
OPAQUE = re.compile(r"^[A-Za-z0-9_\-]{16,}$")

# Keys whose scalar value differs between the halves for a reason that is the
# point of the exercise rather than a finding. Kept short and named: a broad
# ignore list is how a differential stops differentiating.
EXPECTED_VALUE_DIFFS = {
    # The reference IS Remnawave 3.2.3 and we declare 3.3.2. Any comparison of
    # the two would report this, forever.
    "panelVersion", "panel_version", "version",
    # The panel's own address, and how long it took to answer.
    "panel_url", "panelUrl", "url", "latency_ms", "latencyMs", "duration_ms",
}


def mask(value: Any) -> Any:
    if isinstance(value, str):
        v = UUID.sub("<uuid>", value)
        v = ISOTS.sub("<ts>", v)
        v = ISODATE.sub("<date>", v)
        v = EMAIL.sub("<email>", v)
        if OPAQUE.fullmatch(v):
            v = "<opaque>"
        return v
    return value


def shape(node: Any, path: str = "") -> dict[str, str]:
    """Key path -> kind. Lists carry their emptiness, not their length: a length
    difference is data, an empty-vs-populated difference is a broken page."""
    out: dict[str, str] = {}
    if isinstance(node, dict):
        out[path or "$"] = "object"
        for key in sorted(node):
            out.update(shape(node[key], f"{path}.{key}" if path else key))
    elif isinstance(node, list):
        out[path or "$"] = "list[]" if not node else "list"
        # One representative element: the shop's lists are homogeneous, and
        # walking all of them would drown the report in indices.
        if node:
            out.update(shape(node[0], f"{path}[]"))
    elif node is None:
        out[path or "$"] = "null"
    elif isinstance(node, bool):
        out[path or "$"] = "bool"
    elif isinstance(node, (int, float)):
        out[path or "$"] = "number"
    else:
        out[path or "$"] = "string"
    return out


def scalars(node: Any, path: str = "") -> dict[str, Any]:
    out: dict[str, Any] = {}
    if isinstance(node, dict):
        for key in sorted(node):
            out.update(scalars(node[key], f"{path}.{key}" if path else key))
    elif isinstance(node, list):
        for i, item in enumerate(node[:20]):
            out.update(scalars(item, f"{path}[{i}]"))
    else:
        out[path or "$"] = mask(node)
    return out


def load(p: str) -> dict[str, dict]:
    steps: dict[str, dict] = {}
    with open(p, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            steps[rec["step"]] = rec
    return steps


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: compare_admin.py <reference.jsonl> <candidate.jsonl>", file=sys.stderr)
        return 2
    ref, cand = load(sys.argv[1]), load(sys.argv[2])

    # Nothing to compare is not agreement. An empty walkthrough - the login
    # failed, the half died early, somebody passed the wrong path - would
    # otherwise print a confident sentence about every admin page having
    # matched, which is the failure mode this whole file exists to catch,
    # committed by the file itself.
    if not ref or not cand:
        print(
            f"refusing to compare: {len(ref)} step(s) on the reference side and "
            f"{len(cand)} on the candidate.\nAn empty walkthrough agrees with "
            "everything and says nothing.",
            file=sys.stderr,
        )
        return 2

    hard: list[str] = []
    soft: list[str] = []

    only_ref = sorted(set(ref) - set(cand))
    only_cand = sorted(set(cand) - set(ref))
    if only_ref:
        hard.append(f"steps only in the reference walkthrough: {', '.join(only_ref)}")
    if only_cand:
        hard.append(f"steps only in the candidate walkthrough: {', '.join(only_cand)}")

    for step in sorted(set(ref) & set(cand)):
        r, c = ref[step], cand[step]
        if r["status"] != c["status"]:
            hard.append(f"{step}: status {r['status']} (reference) vs {c['status']} (facade)")
            # A different status makes the bodies incomparable; say so and move on.
            continue

        rs, cs = shape(r["body"]), shape(c["body"])
        for key in sorted(set(rs) - set(cs)):
            hard.append(f"{step}: the reference rendered `{key}` ({rs[key]}) and we did not")
        for key in sorted(set(cs) - set(rs)):
            soft.append(f"{step}: we rendered `{key}` ({cs[key]}) and the reference did not")
        for key in sorted(set(rs) & set(cs)):
            if rs[key] != cs[key]:
                if {rs[key], cs[key]} == {"list", "list[]"}:
                    which = "we" if cs[key] == "list[]" else "the reference"
                    hard.append(f"{step}: `{key}` is empty for {which} and populated for the other")
                elif "null" in (rs[key], cs[key]):
                    hard.append(f"{step}: `{key}` is {rs[key]} (reference) vs {cs[key]} (facade)")
                else:
                    soft.append(f"{step}: `{key}` is {rs[key]} (reference) vs {cs[key]} (facade)")

        rv, cv = scalars(r["body"]), scalars(c["body"])
        for key in sorted(set(rv) & set(cv)):
            if rv[key] == cv[key]:
                continue
            leaf = key.rsplit(".", 1)[-1].split("[")[0]
            if leaf in EXPECTED_VALUE_DIFFS:
                continue
            soft.append(f"{step}: `{key}` = {rv[key]!r} (reference) vs {cv[key]!r} (facade)")

    print(f"admin walkthrough: {len(set(ref) & set(cand))} step(s) compared")
    if hard:
        print(f"\nDIVERGENCE ({len(hard)}) - a page answered differently or lost a field:")
        for line in hard:
            print(f"  ! {line}")
    if soft:
        print(f"\ndifferences ({len(soft)}) - reported, not failed:")
        for line in soft:
            print(f"  · {line}")
    if not hard:
        print("\nno divergence: every admin page answered with the same status and the same"
              "\nshape against the facade as against a real Remnawave.")
    return 1 if hard else 0


if __name__ == "__main__":
    raise SystemExit(main())
