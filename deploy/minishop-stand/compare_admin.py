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

Lists of records are matched by identity before any of that, never by position.
The shop does not promise an order and does not hold the same rows on both
halves, so `users[1]` is one subscriber here and a different one there: a
positional walk then reports every field of two unrelated rows as a difference
while silently dropping the comparison that was worth making. Both failure
directions were live - the admin user list produced two dozen fictions and hid
a subscriber whose panel reference our sync had never resolved. Where no key
identifies the rows on both halves the walk stays positional and SAYS SO, so a
list that was never really compared cannot read as a list that agreed.
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


# Keys that can name a row on BOTH halves. Panel-assigned identifiers are
# absent on purpose: `uuid`, `panel_user_uuid` and friends are exactly what the
# two panels disagree about, so aligning on them would pair nothing and quietly
# fall back to position - the failure this is here to prevent.
IDENTITY_KEYS = ("email", "username", "key", "name", "id", "label", "code")


def identity_key(ref_rows: list, cand_rows: list) -> str | None:
    """The field that names the same row on both sides, or None.

    Demands more than presence. The key must be unique WITHIN each side (a
    repeated value cannot address a row) and its values must overlap ACROSS the
    sides by at least half of the shorter list - two lists sharing one value out
    of twenty are not the same list seen twice, and pairing them would invent a
    comparison rather than find one.
    """
    if not ref_rows or not cand_rows:
        return None
    if not all(isinstance(row, dict) for row in (*ref_rows, *cand_rows)):
        return None
    best: tuple[int, int, str] | None = None
    for rank, key in enumerate(IDENTITY_KEYS):
        if not all(key in row and row[key] is not None for row in (*ref_rows, *cand_rows)):
            continue
        ref_ids = [str(row[key]) for row in ref_rows]
        cand_ids = [str(row[key]) for row in cand_rows]
        if len(set(ref_ids)) != len(ref_ids) or len(set(cand_ids)) != len(cand_ids):
            continue
        overlap = len(set(ref_ids) & set(cand_ids))
        if overlap < max(1, min(len(ref_ids), len(cand_ids)) // 2):
            continue
        scored = (overlap, -rank, key)
        if best is None or scored > best:
            best = scored
    return best[2] if best else None


def align(ref_node: Any, cand_node: Any, path: str, notes: list[str]) -> tuple[Any, Any]:
    """Rewrite both trees so paired lists are addressed by identity, not index.

    An aligned list becomes a mapping keyed by that identity and TRIMMED TO THE
    ROWS BOTH SIDES HAVE. A row only one half holds is a different row, not a
    lost field, so it is reported as a difference and kept out of the shape
    comparison - otherwise the reference simply owning one more subscriber would
    read as us having dropped every field of it.

    Lists that cannot be aligned are returned untouched, which keeps the
    empty-vs-populated rule intact: a list that is empty on either side never
    gets an identity, so it still reaches `shape` as a list.
    """
    if isinstance(ref_node, dict) and isinstance(cand_node, dict):
        ref_out, cand_out = dict(ref_node), dict(cand_node)
        for key in sorted(set(ref_node) & set(cand_node)):
            child = f"{path}.{key}" if path else key
            ref_out[key], cand_out[key] = align(ref_node[key], cand_node[key], child, notes)
        return ref_out, cand_out

    if isinstance(ref_node, list) and isinstance(cand_node, list):
        key = identity_key(ref_node, cand_node)
        if key is None:
            # An empty list on either side needs no disclosure: it never had rows
            # to pair, and `shape` already fails empty-vs-populated outright.
            if min(len(ref_node), len(cand_node)) > 1 and all(
                isinstance(row, dict) for row in (*ref_node, *cand_node)
            ):
                notes.append(
                    f"{path}: {len(ref_node)} vs {len(cand_node)} row(s) with no key that names "
                    "them on both halves - compared by position, so a reordering reads as a "
                    "difference and a shared row at different indexes is never compared"
                )
            return ref_node, cand_node
        # Braced, because the identity is data and may contain the separator the
        # paths are built from - an email turns `users.a.b@c.com.status` into a
        # path nobody can split back into a row and a field.
        ref_rows = {"{" + str(row[key]) + "}": row for row in ref_node}
        cand_rows = {"{" + str(row[key]) + "}": row for row in cand_node}
        for only in sorted(set(ref_rows) - set(cand_rows)):
            notes.append(f"{path}: the reference has a row we do not, {key}={only[1:-1]}")
        for only in sorted(set(cand_rows) - set(ref_rows)):
            notes.append(f"{path}: we have a row the reference does not, {key}={only[1:-1]}")
        ref_out, cand_out = {}, {}
        for row_id in sorted(set(ref_rows) & set(cand_rows)):
            ref_out[row_id], cand_out[row_id] = align(
                ref_rows[row_id], cand_rows[row_id], f"{path}.{row_id}", notes
            )
        return ref_out, cand_out

    return ref_node, cand_node


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


def compare(ref: dict[str, dict], cand: dict[str, dict]) -> tuple[list[str], list[str]]:
    """The whole comparison, as data: (divergences, differences).

    Split out from `main` so `--selftest` can drive it on crafted walkthroughs.
    A comparator nobody compares against a known answer is the same kind of
    thing it exists to find: it will report something on every run, and nothing
    tells you whether that something is the truth.
    """
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

        # Pair the rows of every list that can be paired, BEFORE shape and
        # values look at either tree: both of them address list elements by the
        # path they are handed, and a path built from an index compares whatever
        # happens to sit there.
        notes: list[str] = []
        ref_body, cand_body = align(r["body"], c["body"], step, notes)
        soft.extend(notes)

        rs, cs = shape(ref_body), shape(cand_body)
        for key in sorted(set(rs) - set(cs)):
            hard.append(f"{step}: the reference rendered `{key}` ({rs[key]}) and we did not")
        for key in sorted(set(cs) - set(rs)):
            soft.append(f"{step}: we rendered `{key}` ({cs[key]}) and the reference did not")
        for key in sorted(set(rs) & set(cs)):
            if rs[key] != cs[key]:
                if {rs[key], cs[key]} == {"list", "list[]"}:
                    which = "we" if cs[key] == "list[]" else "the reference"
                    hard.append(f"{step}: `{key}` is empty for {which} and populated for the other")
                elif rs[key] != "null" and cs[key] == "null":
                    # We answered null where the reference had a value: a field
                    # the page reads and we do not fill. `last_vpn_connected_at`
                    # was exactly this.
                    hard.append(f"{step}: `{key}` is {rs[key]} (reference) vs null (facade)")
                elif rs[key] == "null":
                    # The other direction is us carrying data a real Remnawave
                    # does not, which is not a page that lost anything - the
                    # same reason a key only WE render is already a difference
                    # rather than a divergence. Squad member counts arrive here:
                    # the reference never fills them and we sometimes do.
                    soft.append(f"{step}: `{key}` is null (reference) vs {cs[key]} (facade)")
                else:
                    soft.append(f"{step}: `{key}` is {rs[key]} (reference) vs {cs[key]} (facade)")

        rv, cv = scalars(ref_body), scalars(cand_body)
        for key in sorted(set(rv) & set(cv)):
            if rv[key] == cv[key]:
                continue
            leaf = key.rsplit(".", 1)[-1].split("[")[0]
            if leaf in EXPECTED_VALUE_DIFFS:
                continue
            soft.append(f"{step}: `{key}` = {rv[key]!r} (reference) vs {cv[key]!r} (facade)")

    return hard, soft


SELFTEST_CASES: list[tuple[str, Any, Any, list[str], list[str]]] = [
    # (name, reference body, candidate body, substrings that must appear in a
    #  DIVERGENCE, substrings that must appear in a difference)
    #
    # Rows shuffled, nothing else changed. This is the case that motivated the
    # whole alignment: by position it reported every field of two unrelated rows
    # and hid the comparison worth making.
    (
        "rows reordered but identical say nothing",
        {"users": [{"email": "a@x", "tier": "free"}, {"email": "b@x", "tier": "paid"}]},
        {"users": [{"email": "b@x", "tier": "paid"}, {"email": "a@x", "tier": "free"}]},
        [], [],
    ),
    # ... and the same shuffle carrying ONE real change reports exactly it,
    # named by the row it belongs to rather than by an index.
    (
        "a changed field is found through the shuffle",
        {"users": [{"email": "a@x", "tier": "free"}, {"email": "b@x", "tier": "paid"}]},
        {"users": [{"email": "b@x", "tier": "free"}, {"email": "a@x", "tier": "free"}]},
        [], ["users.{b@x}.tier", "'paid'", "'free'"],
    ),
    # A row only one half holds is a different row, not a lost field: the halves
    # own different subscribers by construction, and failing on that would make
    # every run red for a reason nobody can fix.
    (
        "a row only one side has is data, not divergence",
        {"users": [{"email": "a@x", "tier": "free"}]},
        {"users": [{"email": "a@x", "tier": "free"}, {"email": "c@x", "tier": "free"}]},
        [], ["we have a row the reference does not, email=c@x"],
    ),
    (
        "a row only the reference has is also data",
        {"users": [{"email": "a@x"}, {"email": "d@x"}]},
        {"users": [{"email": "a@x"}]},
        [], ["the reference has a row we do not, email=d@x"],
    ),
    # Before alignment `shape` looked at element 0 and no further, so a field
    # dropped anywhere else in the list was invisible however long the list was.
    (
        "a field lost on a row that is not the first still fails",
        {"users": [{"email": "a@x", "tier": "free"}, {"email": "b@x", "tier": "paid"}]},
        {"users": [{"email": "a@x", "tier": "free"}, {"email": "b@x"}]},
        ["users.{b@x}.tier"], [],
    ),
    # No key names these rows on both halves, so they are compared by position -
    # which is a fact about the comparison and has to be printed, or a list that
    # was never really compared reads as a list that agreed.
    (
        "an unalignable list is compared by position and says so",
        {"events": [{"at": 1, "text": "x"}, {"at": 2, "text": "y"}]},
        {"events": [{"at": 3, "text": "x"}, {"at": 4, "text": "y"}]},
        [], ["no key that names them on both halves"],
    ),
    # Unique on each side, but the two sides share almost nothing: pairing them
    # would invent a comparison instead of finding one.
    (
        "an identity that barely overlaps is refused",
        {"rows": [{"key": "k1"}, {"key": "k2"}, {"key": "k3"}, {"key": "k4"}]},
        {"rows": [{"key": "k1"}, {"key": "z2"}, {"key": "z3"}, {"key": "z4"}]},
        [], ["no key that names them on both halves"],
    ),
    # Null is judged by direction, the same way key presence already was. A null
    # from us where the reference had a value is a field the page reads and we
    # never fill...
    (
        "null where the reference had a value is a divergence",
        {"user": {"last_seen": "2026-01-01"}},
        {"user": {"last_seen": None}},
        ["`user.last_seen` is string (reference) vs null (facade)"],
        # The value pass reports it a second time, at its own volume. Spelled
        # out rather than tolerated: "the loud line is present" would still hold
        # if the quiet one had gone missing.
        ["`user.last_seen` = '<date>' (reference) vs None (facade)"],
    ),
    # ...while the reverse is us carrying data a real Remnawave does not, which
    # costs the page nothing.
    (
        "a value where the reference had null is only a difference",
        {"squads": {"members": None}},
        {"squads": {"members": 2}},
        [], ["`squads.members` is null (reference) vs number (facade)"],
    ),
    # The silent-empty rule predates alignment and must survive it: an empty
    # list can carry no identity, so it has to reach `shape` as a list.
    (
        "empty against populated is still a divergence",
        {"users": [{"email": "a@x"}]},
        {"users": []},
        ["`users` is empty for we and populated for the other"], [],
    ),
    # ...and it must not ALSO draw the positional disclosure, which would be a
    # second line about a list that had no rows to pair. The reference side
    # needs more than one row here: with a shorter list the guard reads the same
    # whether it asks about the shorter side or the longer one, and the case
    # cannot see which one it got.
    (
        "an emptied list draws no positional disclosure",
        {"users": [{"email": "a@x"}, {"email": "b@x"}]},
        {"users": []},
        ["`users` is empty for we and populated for the other"], [],
    ),
]


def selftest() -> int:
    """Run the comparator against walkthroughs whose answer is known.

    Each case names what must be reported AND at which volume; a case expecting
    nothing is as load-bearing as one expecting a finding, because the failure
    this file guards against is a confident report of agreement.
    """
    failures = 0
    for name, ref_body, cand_body, want_hard, want_soft in SELFTEST_CASES:
        ref = {"step": {"step": "step", "status": 200, "body": ref_body}}
        cand = {"step": {"step": "step", "status": 200, "body": cand_body}}
        hard, soft = compare(ref, cand)
        problems = []
        for needle in want_hard:
            if not any(needle in line for line in hard):
                problems.append(f"expected a divergence mentioning {needle!r}")
        for needle in want_soft:
            if not any(needle in line for line in soft):
                problems.append(f"expected a difference mentioning {needle!r}")
        if not want_hard and hard:
            problems.append("expected no divergence")
        if not want_soft and soft:
            problems.append("expected no difference")
        if problems:
            failures += 1
            print(f"  FAIL  {name}")
            for problem in problems:
                print(f"          {problem}")
            for line in hard:
                print(f"          got ! {line}")
            for line in soft:
                print(f"          got · {line}")
        else:
            print(f"  ok    {name}")
    print(f"\n{len(SELFTEST_CASES) - failures}/{len(SELFTEST_CASES)} case(s) passed")
    return 1 if failures else 0


def main() -> int:
    if len(sys.argv) == 2 and sys.argv[1] == "--selftest":
        return selftest()
    if len(sys.argv) != 3:
        print(
            "usage: compare_admin.py <reference.jsonl> <candidate.jsonl>\n"
            "       compare_admin.py --selftest",
            file=sys.stderr,
        )
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

    hard, soft = compare(ref, cand)

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
