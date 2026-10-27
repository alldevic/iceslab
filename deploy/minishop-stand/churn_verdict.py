#!/usr/bin/env python3
"""Decide whether a churn probe run proved anything, and then what it proved.

Two separate questions, and the first one matters more. The probe deletes a user
partway through the shop's fleet sync and counts what the sync saw - but if the
walk fitted in ONE page, the deletion landed after it was over, no cursor was
ever used, and "nothing was lost" is a statement about nothing. That version of
this probe reported success against a panel with the defect still in it, which
is how this check came to exist.

stdin: the worker log for the run. argv: total users, users the shop reported,
seconds after the start at which the deletion was issued.
"""

import re
import sys
from datetime import datetime

STAMP = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),(\d{3})")


def stamps(lines: list[str], needle: str) -> list[datetime]:
    out = []
    for line in lines:
        if needle not in line:
            continue
        m = STAMP.match(line)
        if m:
            out.append(datetime.strptime(f"{m.group(1)}.{m.group(2)}", "%Y-%m-%d %H:%M:%S.%f"))
    return out


def main() -> int:
    total, checked, delete_after = int(sys.argv[1]), int(sys.argv[2]), float(sys.argv[3])
    lines = sys.stdin.read().splitlines()
    pages = stamps(lines, "endpoint=/users/stream")

    if len(pages) < 2:
        print(
            f"the walk took {len(pages)} page(s), so no cursor was ever followed and\n"
            "nothing about paging was exercised. Bring the stand up with CHURN_PAGING=1\n"
            "(or seed more users than PANEL_ALL_USERS_PAGE_SIZE).",
            file=sys.stderr,
        )
        return 2

    walked = (pages[-1] - pages[0]).total_seconds()
    if walked <= delete_after:
        print(
            f"the walk lasted {walked:.1f}s and the deletion was issued at {delete_after:.1f}s,\n"
            "so it landed after the walk had finished. Raise CHURN_PAGE_DELAY or lower\n"
            "CHURN_DELETE_AFTER.",
            file=sys.stderr,
        )
        return 2

    print(f"  walk: {len(pages)} pages over {walked:.1f}s; deletion at {delete_after:.1f}s - inside it")
    if checked == total:
        print(f"  the shop saw all {total} users; nothing was lost to the churn")
        return 0
    print(
        f"  the shop saw {checked} of {total}: {total - checked} user(s) alive throughout the\n"
        "  walk were never returned, and it reads each of them as deleted from the panel.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
