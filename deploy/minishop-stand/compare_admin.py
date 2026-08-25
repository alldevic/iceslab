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


# Divergences that are known, named, and NOT defects. Every entry carries the
# reason it is here, because the whole risk of a list like this is that it
# becomes the place where real findings go to be quiet.
#
# It exists because the alternative was worse. `compare-admin` failed on every
# single run over these same twenty-three lines, and a gate that is always red
# is a gate nobody reads - the same failure this stand keeps finding in its own
# checks, one level up. With them named, the twenty-fourth divergence is
# visible the moment it appears.
#
# Two guards keep it from rotting. A reference-only field that is NOT listed is
# still a DIVERGENCE, so the list cannot absorb anything by accident. And a
# listed path that produced no finding is reported as stale, so entries cannot
# outlive their reason unnoticed.
#
# A path covers what nests under it: listing `x.y` accepts `x.y`, `x.y[]` and
# `x.y[].z`. Element types are not separate decisions.
ACCEPTED_DIVERGENCE: dict[str, dict[str, str]] = {
    "stats": {
        # The shop's admin declares exactly what it reads from this payload, in
        # the `PanelStats` type in frontend/src/lib/admin/statsDerivations.ts.
        # None of these is in it. Sending them would be inventing numbers to
        # quiet this report, which is the same trade already refused for
        # `activeInboundsCount` - an empty column is honester than a wrong one.
        # Only visible since the halves got node traffic (seed_node_traffic.py):
        # while both `topNodes` lists were empty there was nothing to compare.
        # Remnawave derives it from the node uuid — its last six hex digits,
        # checked against a real pair — and `parseNodesBandwidthTop` reads only
        # total/uuid/name/usersOnline. Nothing in the shop consumes a colour.
        "panel.nodes_bandwidth.topNodes[].color": "no reader anywhere in the shop's frontend",
        # Same shape, same check: `aggregatePanelNodeRows` keys rows on
        # nodeUuid/uuid/nodeName/name and sums bytes, and `panelRowLabel` falls
        # back through the name fields to a uuid stub. Neither looks at a date.
        "panel.nodes.lastSevenDays[].date": "no reader anywhere in the shop's frontend",
        "panel.bandwidth.bandwidthCalendarMonth.difference": "shop reads only `current` from a bandwidth pair",
        "panel.bandwidth.bandwidthCurrentYear.difference": "shop reads only `current` from a bandwidth pair",
        "panel.bandwidth.bandwidthLast30Days.difference": "shop reads only `current` from a bandwidth pair",
        "panel.bandwidth.bandwidthLastSevenDays.difference": "shop reads only `current` from a bandwidth pair",
        "panel.bandwidth.bandwidthLastTwoDays.difference": "shop reads only `current` from a bandwidth pair",
        "panel.nodes_bandwidth.categories": "no reader anywhere in the shop's frontend",
        "panel.nodes_bandwidth.sparklineData": "no reader anywhere in the shop's frontend",
        "panel.nodes_bandwidth.series": "read only as a fallback when `topNodes` is empty, and we always fill `topNodes`",
        "panel.system.memory.free": "shop declares only memory.total and memory.used, and derives the rest",
        "panel.system.nodes.totalBytesLifetime": "read on a NODE row, not on this aggregate; our node rows carry totalBytes",
        "panel.system.timestamp": "no reader",
        "panel.system.uptime": "no reader",
    },
    "user-seeded": {
        # Not a facade gap: a fixture the two halves cannot share. The
        # reference's own seed-remnawave.sql puts this user in a squad and
        # stamps a connection time; on our side the shop's fleet sync creates
        # the panel user, with no squads and no connection. Mirroring somebody
        # else's SQL was declined deliberately - squads are already compared on
        # the buyer, who exists identically on both halves.
        "panel_squad_overrides.effective_internal_squad_uuids": "reference-only fixture: their SQL seeds this user into a squad",
        "panel_squad_overrides.manual_internal_squads": "reference-only fixture: their SQL seeds this user into a squad",
        # Guarded where it belongs, not here: that we send `onlineAt` at all is
        # asserted in remnawave.mappers.test.ts, by a case that transcribes the
        # shop's predicate and is checked by mutation. What is left in THIS
        # report is only that their seeded user has a connection timestamp and
        # ours has genuinely never connected.
        "last_vpn_connected_at": "reference-only fixture: their SQL stamps a connection time; ours truly never connected",
    },
}


# Reasons that hold only while some OTHER field carries data.
#
# `panel.nodes_bandwidth.series` is accepted because the shop reads it only as a
# fallback when `topNodes` is empty - "and we always fill `topNodes`". True, and
# until now untested: the walkthrough's window has no node traffic at all, so
# `topNodes` comes back empty on BOTH halves and the claim the acceptance rides
# on is never exercised. Emptying ours changed nothing about the report.
#
# That is the third time on this stand that a comparison has answered
# confidently about something neither side did. The first two were fixed by
# sharpening the fixture; this one names the dependency instead, so the report
# says which of its own conclusions the run did not earn.
#
# Deliberately NOT a hard divergence. In a window with genuinely no node
# traffic an empty `topNodes` is the truth, and failing there would be a false
# alarm on every pass. What is wrong is only the silence.
CONDITIONAL_ACCEPTANCE: dict[tuple[str, str], tuple[str, str]] = {
    ("stats", "panel.nodes_bandwidth.series"): (
        "panel.nodes_bandwidth.topNodes",
        "the shop falls back to `series` exactly when `topNodes` is empty",
    ),
}


def value_at(body: object, dotted: str) -> object:
    """The value at a dotted path, or None when any step of it is missing."""
    node = body
    for part in dotted.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def carries_data(body: object, dotted: str) -> bool:
    """Whether the path holds something a reader could draw."""
    value = value_at(body, dotted)
    if value is None:
        return False
    if isinstance(value, (list, dict, str)):
        return len(value) > 0
    return True


def accepted_reason(step: str, line: str) -> tuple[str, str] | None:
    """The (path, reason) this divergence is known by, or None if it is news.

    The PATH comes back, not just the reason, because the staleness guard has to
    tick off entries one by one. Keyed by reason it silently did not: several
    entries share wording ("no reader" covers both `uptime` and `timestamp`), so
    one of them matching marked the others alive, and an entry that had stopped
    being true went on looking checked.

    Matched on the path inside the backticks rather than on the whole sentence:
    the same path arrives phrased three different ways (a missing key, a null, an
    emptied list), and a list keyed by wording would silently stop covering one
    of them the next time a message is reworded.
    """
    paths = ACCEPTED_DIVERGENCE.get(step)
    if not paths:
        return None
    quoted = re.findall(r"`([^`]+)`", line)
    for path in quoted:
        for known, reason in paths.items():
            if path == known or path.startswith(known + "[") or path.startswith(known + "."):
                return known, reason
    return None


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


def compare(
    ref: dict[str, dict], cand: dict[str, dict]
) -> tuple[list[str], list[str], list[str]]:
    """The whole comparison, as data: (divergences, differences, accepted).

    Split out from `main` so `--selftest` can drive it on crafted walkthroughs.
    A comparator nobody compares against a known answer is the same kind of
    thing it exists to find: it will report something on every run, and nothing
    tells you whether that something is the truth.
    """
    hard: list[str] = []
    soft: list[str] = []
    known: list[str] = []
    matched: set[tuple[str, str]] = set()

    def divergence(step: str, line: str) -> None:
        """Route one divergence: news fails the run, a named one is recorded."""
        hit = accepted_reason(step, line)
        if hit is None:
            hard.append(line)
        else:
            path, reason = hit
            known.append(f"{line}\n      ^ accepted: {reason}")
            matched.add((step, path))

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
            divergence(step, f"{step}: the reference rendered `{key}` ({rs[key]}) and we did not")
        for key in sorted(set(cs) - set(rs)):
            soft.append(f"{step}: we rendered `{key}` ({cs[key]}) and the reference did not")
        for key in sorted(set(rs) & set(cs)):
            if rs[key] != cs[key]:
                if cs[key] == "list[]" and rs[key] == "list":
                    # The silent-empty failure: the reference drew rows and we
                    # drew none. A squad list that came back empty, a traffic
                    # table of dashes - a page the shop accepts and an operator
                    # cannot use.
                    divergence(step, f"{step}: `{key}` is empty for us and populated for the reference")
                elif rs[key] == "list[]" and cs[key] == "list":
                    # The mirror image is not that failure. We drew rows the
                    # reference had none of, which costs the page nothing - and
                    # the two rules either side of this one already read by
                    # direction for exactly this reason. Left symmetric, the
                    # reference simply having no node traffic in its window
                    # failed the run on every pass.
                    soft.append(f"{step}: `{key}` is empty for the reference and populated for us")
                elif rs[key] != "null" and cs[key] == "null":
                    # We answered null where the reference had a value: a field
                    # the page reads and we do not fill. `last_vpn_connected_at`
                    # was exactly this.
                    divergence(step, f"{step}: `{key}` is {rs[key]} (reference) vs null (facade)")
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

    # An entry that matched nothing this run has outlived its reason - we started
    # serving the field, or the reference stopped sending it. Reported rather
    # than failed: the reference's own data moves between runs, and a gate that
    # goes red because a fixture had no node traffic is a gate that gets muted.
    # The direction that matters is guarded the other way round - anything NOT
    # in the table is still a divergence.
    # An acceptance whose reason depends on data this run did not produce was
    # not tested by it. Said out loud, because the alternative is a report that
    # counts an untested assumption among its agreements.
    for (step, path), (needs, why) in CONDITIONAL_ACCEPTANCE.items():
        if (step, path) not in matched:
            continue
        if not carries_data(cand.get(step, {}).get("body"), needs):
            soft.append(
                f"{step}: `{path}` was accepted on the grounds that `{needs}` is filled "
                f"({why}), but `{needs}` is EMPTY for us in this run - the acceptance "
                "was not exercised, so this report does not stand behind it"
            )

    for step, paths in ACCEPTED_DIVERGENCE.items():
        # Only for steps this walkthrough actually compared. A run that never
        # visited the page cannot say whether its entries still hold, and
        # claiming otherwise would make every partial comparison print a list of
        # things to go and check.
        if step not in set(ref) & set(cand):
            continue
        for path in paths:
            if (step, path) not in matched:
                soft.append(
                    f"{step}: the accepted-divergence entry for `{path}` matched nothing this "
                    "run - check whether it is still true, and remove it if not"
                )

    return hard, soft, known


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
        ["`users` is empty for us and populated for the reference"], [],
    ),
    # ...and the mirror image is only a difference, for the same reason the null
    # rule reads by direction: we drew rows, so the page lost nothing.
    (
        "a list empty only on the reference is not a divergence",
        {"nodes": []},
        {"nodes": [{"uuid": "n1"}]},
        [], ["`nodes` is empty for the reference and populated for us"],
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
        ["`users` is empty for us and populated for the reference"], [],
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
        hard, soft, _known = compare(ref, cand)
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
    # The acceptance table gets its own block rather than a row in the table
    # above: these cases have to name a REAL step, and every other entry for
    # that step then reports itself stale, which the all-or-nothing assertions
    # up there would read as a failure. The three checks are the three ways the
    # mechanism can be wrong.
    def walk(ref_body, cand_body, step="stats"):
        return compare(
            {step: {"step": step, "status": 200, "body": ref_body}},
            {step: {"step": step, "status": 200, "body": cand_body}},
        )

    accept_checks: list[tuple[str, bool]] = []

    # 1. A listed field the reference renders and we do not is recorded, not failed.
    hard, _soft, known = walk({"panel": {"system": {"uptime": 1.0}}}, {"panel": {"system": {}}})
    accept_checks.append(("a listed divergence is accepted, not failed", not hard and bool(known)))

    # 2. Its NEIGHBOUR is not sheltered by it. This is the one that decides
    #    whether the table is a list of exceptions or a hole in the gate.
    hard, _soft, _known = walk({"panel": {"system": {"uptimeExtra": 1}}}, {"panel": {"system": {}}})
    accept_checks.append(("an unlisted field next to a listed one still fails", bool(hard)))

    # 3. An entry that stopped being true says so. Keyed by reason instead of by
    #    path it did not: several entries share wording, so one matching marked
    #    the rest alive and a dead entry went on looking checked.
    # `timestamp` has to be here, diverging, and it has to be an entry whose
    # REASON is worded the same as `uptime`'s. Without a same-reason neighbour
    # actually matching, keying by reason and keying by path behave identically
    # and the case cannot see which one it got - it passed happily against the
    # bug it exists for.
    _hard, soft, _known = walk(
        {"panel": {"system": {"uptime": 1.0, "timestamp": 123}}},
        {"panel": {"system": {"uptime": 2.0}}},
    )
    accept_checks.append((
        "an accepted entry that stopped being true is reported stale",
        any("`panel.system.uptime` matched nothing" in line for line in soft),
    ))

    # 4 and 5. A conditional acceptance says when the run did not earn it.
    #
    # Both directions, because either alone is worthless: with only the empty
    # case this passes against a comparator that complains unconditionally, and
    # with only the filled case it passes against one that never complains at
    # all. `series` must be accepted quietly when `topNodes` carries rows, and
    # must be flagged as unexercised when it does not.
    ref_series = {"panel": {"nodes_bandwidth": {"series": [{"n": 1}]}}}

    _hard, soft, known = walk(
        ref_series,
        {"panel": {"nodes_bandwidth": {"topNodes": [{"nodeName": "n1", "total": 5}]}}},
    )
    accept_checks.append((
        "a conditional acceptance is silent when its condition holds",
        bool(known) and not any("was not exercised" in line for line in soft),
    ))

    _hard, soft, known = walk(ref_series, {"panel": {"nodes_bandwidth": {"topNodes": []}}})
    accept_checks.append((
        "a conditional acceptance says so when the run did not exercise it",
        bool(known)
        and any(
            "`panel.nodes_bandwidth.series`" in line and "was not exercised" in line
            for line in soft
        ),
    ))

    for name, ok in accept_checks:
        print(f"  {'ok   ' if ok else 'FAIL '} {name}")
        if not ok:
            failures += 1

    total = len(SELFTEST_CASES) + len(accept_checks)
    print(f"\n{total - failures}/{total} case(s) passed")
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

    hard, soft, known = compare(ref, cand)

    print(f"admin walkthrough: {len(set(ref) & set(cand))} step(s) compared")
    if hard:
        print(f"\nDIVERGENCE ({len(hard)}) - a page answered differently or lost a field:")
        for line in hard:
            print(f"  ! {line}")
    if known:
        print(f"\naccepted divergences ({len(known)}) - named, with a reason, not failed:")
        for line in known:
            print(f"  ~ {line}")
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
