#!/usr/bin/env python3
"""Decide whether a churn probe run proved anything, and then what it proved.

Two separate questions, and the first one matters more. The probe deletes a user
partway through the shop's fleet sync and counts what the sync saw - but if the
walk fitted in ONE page, or the deletion landed after it was over, no cursor was
followed across the deletion and "nothing was lost" is a statement about
nothing. That version of this probe reported success against a panel with the
defect still in it, which is how this check came to exist.

The pages are counted where every one of them passes: the request log of the
nginx in front of the facade (the panel's frontend image, or panel-shim), read
with `docker logs --timestamps`. The shop's own metric lines are not enough: the
worker does not write one for every page it fetches.

stdin: that request log for the probe's window. argv: total users, users the
shop reported, the moment the deletion was issued (unix seconds).

    churn_verdict.py <total> <checked> <deleted-at>
    churn_verdict.py --selftest
"""

from __future__ import annotations

import re
import sys
from datetime import datetime, timezone

# `docker logs --timestamps` prefix (RFC 3339, nanoseconds), then nginx's line.
LINE = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z\s.*\"GET (\S*/users/stream(?:\?(\S*))?) HTTP/")


def pages(lines: list[str]) -> list[tuple[float, bool]]:
    """(unix time, followed a cursor) for each page of the walk, in order."""
    out = []
    for line in lines:
        m = LINE.match(line)
        if not m:
            continue
        stamp = datetime.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp()
        stamp += float(f"0.{m.group(2)}") if m.group(2) else 0.0
        query = m.group(4) or ""
        out.append((stamp, any(p.startswith("cursor=") for p in query.split("&"))))
    return out


def verdict(lines: list[str], total: int, checked: int, deleted_at: float) -> tuple[int, str]:
    walk = pages(lines)
    if len(walk) < 2 or not any(cursor for _, cursor in walk):
        return 2, (
            f"the walk took {len(walk)} page(s) and followed no cursor, so nothing about\n"
            "paging was exercised. Bring the stand up with CHURN_PAGING=1 (or seed more\n"
            "users than PANEL_ALL_USERS_PAGE_SIZE)."
        )
    first, last = walk[0][0], walk[-1][0]
    if not first < deleted_at < last:
        when = "before" if deleted_at <= first else "after"
        return 2, (
            f"the deletion was issued {when} the walk ({len(walk)} pages over {last - first:.1f}s),\n"
            "not inside it. Raise CHURN_PAGE_DELAY or change CHURN_DELETE_AFTER."
        )
    head = (
        f"  walk: {len(walk)} pages over {last - first:.1f}s; "
        f"deletion at +{deleted_at - first:.1f}s - inside it\n"
    )
    if checked == total:
        return 0, head + f"  the shop saw all {total} users; nothing was lost to the churn"
    return 1, head + (
        f"  the shop saw {checked} of {total}: {total - checked} user(s) alive throughout the\n"
        "  walk were never returned, and it reads each of them as deleted from the panel."
    )


def selftest() -> int:
    def page(sec: float, cursor: str | None) -> str:
        whole, frac = divmod(sec, 1)
        q = "size=5" + (f"&cursor={cursor}" if cursor else "")
        return (
            f"2026-01-01T00:00:{int(whole):02d}.{int(frac * 1e9):09d}Z 172.18.0.5 - - "
            f'[01/Jan/2026:00:00:{int(whole):02d} +0000] "GET /rw/api/users/stream?{q} HTTP/1.1" 200 812 "-" "python" "-"'
        )

    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp()
    walk = [page(0.5, None)] + [page(1.5 + i, f"k1.{5 * (i + 1)}") for i in range(8)]
    noise = ['2026-01-01T00:00:03.000000000Z 172.18.0.5 - - [..] "GET /rw/api/users?size=1 HTTP/1.1" 200 1 "-" "-" "-"']
    cases = [
        ("keyset, deletion inside, all seen", walk + noise, 42, 42, t0 + 4, 0),
        ("deletion inside, one lost", walk, 42, 41, t0 + 4, 1),
        ("one page only", walk[:1], 5, 5, t0 + 4, 2),
        ("pages but no cursor", [page(0.5, None), page(1.5, None)], 10, 10, t0 + 1, 2),
        ("deletion after the walk", walk, 42, 42, t0 + 30, 2),
        ("deletion before the walk", walk, 42, 42, t0 + 0.1, 2),
        ("worker metric lines are not pages", ["2026-01-01 00:00:01,000 endpoint=/users/stream status=200"] * 5, 5, 5, t0 + 1, 2),
    ]
    failed = 0
    for name, lines, total, checked, deleted_at, want in cases:
        got, _ = verdict(lines, total, checked, deleted_at)
        ok = got == want
        failed += not ok
        print(f"  {'ok  ' if ok else 'FAIL'} churn_verdict: {name} -> {got}" + ("" if ok else f" (want {want})"))
    return 1 if failed else 0


def main() -> int:
    if sys.argv[1:] == ["--selftest"]:
        return selftest()
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2
    total, checked, deleted_at = int(sys.argv[1]), int(sys.argv[2]), float(sys.argv[3])
    code, text = verdict(sys.stdin.read().splitlines(), total, checked, deleted_at)
    print(text, file=sys.stderr if code else sys.stdout)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
