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


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: compare_traces.py <reference-trace> <candidate-trace>", file=sys.stderr)
        return 2
    ref_path, cand_path = sys.argv[1], sys.argv[2]
    ref, cand = load(ref_path), load(cand_path)
    accepted, covering = contract_index()

    ref_ops = Counter((m, e) for m, e, _ in ref)
    cand_ops = Counter((m, e) for m, e, _ in cand)

    divergent = []
    for key in sorted(set(ref_ops) | set(cand_ops)):
        if ref_ops[key] != cand_ops[key]:
            divergent.append((key, ref_ops[key], cand_ops[key]))

    cosmetic, real = [], []
    for key in sorted(set(ref_ops) & set(cand_ops)):
        r = Counter(s for m, e, s in ref if (m, e) == key)
        c = Counter(s for m, e, s in cand if (m, e) == key)
        if r == c:
            continue
        ok = accepted.get(key, set())
        # Every status on both sides declared a success for this operation ⇒ the
        # shop accepts either, and the difference is not one to chase.
        if set(r) <= ok and set(c) <= ok:
            cosmetic.append((key, dict(r), dict(c), sorted(ok)))
        else:
            real.append((key, dict(r), dict(c), sorted(ok)))

    print(f"reference: {len(ref)} calls ({ref_path})")
    print(f"candidate: {len(cand)} calls ({cand_path})")
    print()

    if divergent:
        print("DIVERGENT - the shop called these a different number of times:")
        for (method, label), r, c in divergent:
            print(f"  {method} {label}: reference {r}x, candidate {c}x")
            if c == 0:
                print("    the candidate never got this call: the shop decided it was unsupported")
        print()
    if real:
        print("STATUS OUTSIDE THE CONTRACT:")
        for (method, label), r, c, ok in real:
            print(f"  {method} {label}: reference {r}, candidate {c}, declared success {ok}")
        print()
    if cosmetic:
        print("status differs, but inside the contract's declared success set:")
        for (method, label), r, c, ok in cosmetic:
            print(f"  {method} {label}: reference {r}, candidate {c}, declared success {ok}")
            ops = covering[(method, label)]
            if len(ops) > 1:
                print(f"    label covers {len(ops)} operations ({', '.join(ops)}),")
                print("    so the accepted set is their union - read the ordered trace to be sure")
        print()

    if divergent or real:
        print("VERDICT: the shop behaved differently in a way that matters.")
        return 1
    if cosmetic:
        print("VERDICT: same operations, same counts; only statuses the shop documents as")
        print("interchangeable differ. The facade is indistinguishable to the shop.")
        return 0
    print("VERDICT: identical.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
