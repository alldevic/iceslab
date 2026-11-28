#!/usr/bin/env python3
"""Compare two stand traces the way the question deserves.

A trace is `METHOD <operation-label> <status>` per panel call, taken from the
shop's own logs. Two differences are not the same kind of thing:

  * an operation one panel got and the other did not - the shop took a
    different path, decided a capability was absent, or fell back to a legacy
    route. That is the failure this whole exercise exists to find, and it is
    invisible from a green run.

  * the same operation answered with a different STATUS. Whether that matters
    is not a judgement call: the shop's own contract registry declares
    `success_statuses` per operation, so a status inside that set is a
    difference the shop is documented to accept.

Reporting both as one undifferentiated diff is how a cosmetic 200-vs-201 gets
treated as a defect, and how a real capability divergence gets waved away as
noise the next time.
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

CONTRACT = (
    Path(__file__).resolve().parents[2]
    / "apps/panel-backend/src/modules/remnawave-compat/contracts/minishop-contract.json"
)


# Calls the shop makes only when its own 300-second cache has expired. Whether
# one lands inside a trace window is decided by the wall-clock gap between the
# steps, not by anything the panel did - so a +-1 count difference on these is
# timing. Named rather than suppressed: still reported as a divergence, with the
# reason attached, because a count difference here CAN also mean a re-detection
# the other half never needed.
#
#   /system/metadata  - panel_api_core.py `_PANEL_COMPATIBILITY_TTL_SECONDS`
#   /internal-squads  - settings `PANEL_EXTERNAL_SQUADS_CACHE_TTL_SECONDS`
CACHED_BEHIND_TTL = {
    "/system/metadata": "_PANEL_COMPATIBILITY_TTL_SECONDS = 300s",
    "/internal-squads": "PANEL_EXTERNAL_SQUADS_CACHE_TTL_SECONDS = 300s",
}


# Differences the project has accepted as properties of the STAND, not of the
# facade, and the only ones that do not fail a run. Keyed by (METHOD, label).
# Every entry names where it was accepted, because a list like this is where
# real findings go to be quiet. Two guards keep it narrow:
#
#   * `candidate_more` - only the direction "the facade's half called it MORE
#     often than the reference" is covered. The reverse (the shop asked the
#     reference for something the facade never got) is the failure this file
#     exists to find, and stays unexpected.
#   * `statuses` - extra statuses that may appear on either side besides the
#     contract's declared success set (a 404 is a probe answer, not a success).
#
# Source of all of them: the reference half's seed-remnawave.sql puts the
# `runes_*` users in the panel beforehand; on our half `up-iceslab` clears them
# and the shop creates them itself, so its purchase makes more calls: extra
# `by-username` 404 -> `POST /users` x2, `PATCH` x2, `users/stream`
# (m15-01.md "Свойство стенда: фикстуры"; repeated as the same picture in
# m15-02.md and m15-03.md and again in 20.2 - purchase 29 calls against 12-17,
# the reference's own count floats with the worker's background sweeps). The
# admin walk's `GET /users` 26 against 24-25 is the shop's cache and background
# calls (m15-01.md "Мелочь"; one `GET /users` inside the contract in m17-07.md).
# Accepted in prose there; entered here in pass 7 (customer decision, 20.1/20.2
# remainder: differential exits 0 when every divergence is a registered one).
#
# `/internal-squads` (CACHED_BEHIND_TTL) is here with a bound of one call either
# way (stand 20.2: 0 versus 1; entered by the orchestrator in pass 7).
# `/system/metadata`, cached the same way, is not: no run has shown it differ.
ACCEPTED_TRACE_DIFFERENCES: dict[tuple[str, str], dict] = {
    ("GET", "/users"): {
        "candidate_more": True,
        "statuses": (),
        "reason": "runes_* fixtures the reference seeds and the shop creates on our half; "
        "admin walk: shop cache and background calls (m15-01.md, m17-07.md)",
    },
    ("GET", "/users/by-username"): {
        "candidate_more": True,
        "statuses": (404,),
        "reason": "the shop looks the fixture users up (404) before creating them (m15-01.md)",
    },
    ("GET", "/users/stream"): {
        "candidate_more": True,
        "statuses": (),
        "reason": "extra fleet-sync walks after the fixture users are created (m15-01.md)",
    },
    ("POST", "/users"): {
        "candidate_more": True,
        "statuses": (),
        "reason": "the shop creates the runes_* fixture users itself (m15-01.md)",
    },
    ("PATCH", "/users"): {
        "candidate_more": True,
        "statuses": (),
        "reason": "squad assignment of the fixture users it just created (m15-01.md)",
    },
    # Cached by the shop for PANEL_EXTERNAL_SQUADS_CACHE_TTL_SECONDS (300 s): whether
    # a half calls it at all depends on how long ago the previous step did, so the
    # two halves may differ by ONE call either way, never more (stand 20.2: 0 vs 1).
    ("GET", "/internal-squads"): {
        "candidate_more": False,
        "either_way_by": 1,
        "statuses": (),
        "reason": "shop cache of 300 s: one call more or less is the gap between the halves' steps (m20-02.md)",
    },
}


def load(path: str) -> list[tuple[str, str, int]]:
    rows = []
    for line in Path(path).read_text().splitlines():
        parts = line.split()
        if len(parts) == 3:
            rows.append((parts[0], parts[1], int(parts[2])))
    return rows


def contract_index() -> tuple[dict[tuple[str, str], set[int]], dict[tuple[str, str], list[str]]]:
    """Accepted statuses and covering operations, keyed by (METHOD, log_label).

    The label is all the trace has, and it is NOT one operation. `GET /users`
    covers users.list and users.get; `POST /users` covers five - create,
    bulk-update-squads, status, revoke, reset-traffic. So the accepted statuses
    have to be unioned across everything behind a label, which makes a status
    check on a crowded label weak. Reported alongside the result rather than
    hidden, because a tool that looks precise and is not is worse than one that
    says where it stops.
    """
    statuses: dict[tuple[str, str], set[int]] = {}
    covering: dict[tuple[str, str], list[str]] = {}
    doc = json.loads(CONTRACT.read_text())
    for op in doc["operations"]:
        key = (op["method"], op["log_label"])
        statuses.setdefault(key, set()).update(op["success_statuses"])
        covering.setdefault(key, []).append(op["operation"])
    return statuses, covering


def compare(ref, cand):
    """The comparison as data, so `--selftest` can drive it.

    Returns a dict: `unexpected_counts` / `accepted_counts` (key, ref, cand
    [, reason]), `unexpected_status` / `accepted_status` (key, r, c, declared
    [, reason]) and `cosmetic`.
    """
    accepted, covering = contract_index()
    ref_ops = Counter((m, e) for m, e, _ in ref)
    cand_ops = Counter((m, e) for m, e, _ in cand)

    out = {"unexpected_counts": [], "accepted_counts": [], "unexpected_status": [],
           "accepted_status": [], "cosmetic": [], "covering": covering}
    for key in sorted(set(ref_ops) | set(cand_ops)):
        r, c = ref_ops[key], cand_ops[key]
        if r == c:
            continue
        entry = ACCEPTED_TRACE_DIFFERENCES.get(key)
        if entry and ((entry["candidate_more"] and c > r) or abs(c - r) <= entry.get("either_way_by", 0)):
            out["accepted_counts"].append((key, r, c, entry["reason"]))
        else:
            out["unexpected_counts"].append((key, r, c))

    for key in sorted(set(ref_ops) & set(cand_ops)):
        r = Counter(s for m, e, s in ref if (m, e) == key)
        c = Counter(s for m, e, s in cand if (m, e) == key)
        if r == c:
            continue
        ok = accepted.get(key, set())
        # Every status on both sides declared a success for this operation => the
        # shop accepts either, and the difference is not one to chase.
        if set(r) <= ok and set(c) <= ok:
            out["cosmetic"].append((key, dict(r), dict(c), sorted(ok)))
            continue
        entry = ACCEPTED_TRACE_DIFFERENCES.get(key)
        if entry and (set(r) | set(c)) <= ok | set(entry["statuses"]):
            out["accepted_status"].append((key, dict(r), dict(c), sorted(ok), entry["reason"]))
        else:
            out["unexpected_status"].append((key, dict(r), dict(c), sorted(ok)))
    return out


def main() -> int:
    if len(sys.argv) == 2 and sys.argv[1] == "--selftest":
        return selftest()
    if len(sys.argv) != 3:
        print("usage: compare_traces.py <reference-trace> <candidate-trace>\n"
              "       compare_traces.py --selftest", file=sys.stderr)
        return 2
    ref_path, cand_path = sys.argv[1], sys.argv[2]
    ref, cand = load(ref_path), load(cand_path)

    # Nothing to compare is not agreement: two empty traces would otherwise be
    # reported as identical, and a half that died before making a single call
    # would read as a clean run.
    if not ref or not cand:
        print(
            f"refusing to compare: {len(ref)} call(s) in the reference trace and "
            f"{len(cand)} in the candidate.\nAn empty trace matches everything.",
            file=sys.stderr,
        )
        return 2
    res = compare(ref, cand)
    covering = res["covering"]

    print(f"reference: {len(ref)} calls ({ref_path})")
    print(f"candidate: {len(cand)} calls ({cand_path})")
    print()

    if res["accepted_counts"] or res["accepted_status"]:
        print("ACCEPTED (registry) - a known property of the stand, not failed:")
        for (method, label), r, c, why in res["accepted_counts"]:
            print(f"  {method} {label}: reference {r}x, candidate {c}x")
            print(f"    accepted: {why}")
        for (method, label), r, c, ok, why in res["accepted_status"]:
            print(f"  {method} {label}: reference {r}, candidate {c}, declared success {ok}")
            print(f"    accepted: {why}")
        print()
    if res["unexpected_counts"]:
        print("UNEXPECTED - the shop called these a different number of times:")
        for (method, label), r, c in res["unexpected_counts"]:
            print(f"  {method} {label}: reference {r}x, candidate {c}x")
            if label in CACHED_BEHIND_TTL:
                # Including the 0-vs-N case, and BEFORE the "unsupported" line:
                # a cached call absent from one window is the ordinary shape of
                # this, and calling it a refused capability would be a finding
                # invented by the clock.
                print(f"    the shop caches this ({CACHED_BEHIND_TTL[label]}), so a count")
                print("    difference - 0 included - can be the gap between the two runs'")
                print("    steps rather than anything the panel did")
            elif c == 0:
                print("    the candidate never got this call: the shop decided it was unsupported")
        print()
    if res["unexpected_status"]:
        print("UNEXPECTED - STATUS OUTSIDE THE CONTRACT:")
        for (method, label), r, c, ok in res["unexpected_status"]:
            print(f"  {method} {label}: reference {r}, candidate {c}, declared success {ok}")
        print()
    if res["cosmetic"]:
        print("status differs, but inside the contract's declared success set:")
        for (method, label), r, c, ok in res["cosmetic"]:
            print(f"  {method} {label}: reference {r}, candidate {c}, declared success {ok}")
            ops = covering[(method, label)]
            if len(ops) > 1:
                print(f"    label covers {len(ops)} operations ({', '.join(ops)}),")
                print("    so the accepted set is their union - read the ordered trace to be sure")
        print()

    if res["unexpected_counts"] or res["unexpected_status"]:
        print("VERDICT: the shop behaved differently in a way outside the registry of accepted differences.")
        return 1
    if res["accepted_counts"] or res["accepted_status"]:
        print("VERDICT: every difference is a registered one (see ACCEPTED above); nothing unexpected.")
        return 0
    if res["cosmetic"]:
        print("VERDICT: same operations, same counts; only statuses the shop documents as")
        print("interchangeable differ. The facade is indistinguishable to the shop.")
        return 0
    print("VERDICT: identical.")
    return 0


def selftest() -> int:
    def rows(spec: str) -> list[tuple[str, str, int]]:
        out = []
        for part in spec.split(";"):
            m, e, s, n = part.split()
            out += [(m, e, int(s))] * int(n)
        return out

    base = "GET /system/metadata 200 1;POST /bandwidth-stats/nodes 200 1"
    cases = [
        ("identical", base, base, 0),
        ("registered extra calls and a 404 only",
         base + ";GET /users/by-username 404 1;POST /users 201 1",
         base + ";GET /users/by-username 404 3;POST /users 201 3;PATCH /users 200 3;GET /users/stream 200 9", 0),
        ("an unexpected extra call fails", base, base + ";DELETE /nodes 200 1", 1),
        ("a registered label with FEWER calls for the candidate fails",
         base + ";GET /users/stream 200 5", base + ";GET /users/stream 200 2", 1),
        ("a registered label missing on the candidate fails",
         base + ";PATCH /users 200 2", base, 1),
        ("a status outside the contract and the registry fails",
         base + ";GET /users/by-username 404 1", base + ";GET /users/by-username 500 1", 1),
        ("a cached call one more on the candidate is accepted", base, base + ";GET /internal-squads 200 1", 0),
        ("a cached call one fewer on the candidate is accepted", base + ";GET /internal-squads 200 1", base, 0),
        ("a cached call two more fails", base, base + ";GET /internal-squads 200 2", 1),
        ("registered and unexpected together fail",
         base + ";POST /users 201 1", base + ";POST /users 201 3;DELETE /nodes 200 1", 1),
    ]
    failed = 0
    for name, r, c, want in cases:
        res = compare(rows(r), rows(c))
        got = 1 if (res["unexpected_counts"] or res["unexpected_status"]) else 0
        ok = got == want
        failed += not ok
        print(f"{'ok  ' if ok else 'FAIL'} compare_traces: {name} (exit {got}, wanted {want})")
    # The refusal path: an empty trace is 2, whatever the other side holds.
    import subprocess, tempfile
    with tempfile.TemporaryDirectory() as d:
        empty, full = Path(d, "e"), Path(d, "f")
        empty.write_text("")
        full.write_text("GET /users 200\n")
        for a, b in ((empty, full), (full, empty), (empty, empty)):
            rc = subprocess.run([sys.executable, "-I", __file__, str(a), str(b)],
                                capture_output=True).returncode
            ok = rc == 2
            failed += not ok
            print(f"{'ok  ' if ok else 'FAIL'} compare_traces: an empty trace refuses (exit {rc}, wanted 2)")
    print("compare_traces selftest:", "FAILED" if failed else "passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
