#!/usr/bin/env python3
"""Check on the PANEL that the demotion happened, not just that it was logged.

Reads the native user on stdin. Exactly one of the stand's squads must remain -
the base one. Both remaining means the bulk call did nothing; none remaining
means the shop cleared the last squad, which it routes through per-user PATCHes
instead and which would mean this run never touched the bulk route at all.
"""
import json
import sys


def main() -> int:
    stand_squads = [s for s in sys.argv[1].split() if s]
    user = json.load(sys.stdin)
    user = user.get("user", user)
    have = [g for g in (user.get("groupIds") or []) if g in stand_squads]
    if len(have) != 1:
        print(
            f"expected exactly one of the stand's squads to remain, found {len(have)}: {have}",
            file=sys.stderr,
        )
        return 1
    print(f"panel shows {len(have)} of the stand's squads left on the user")
    return 0


if __name__ == "__main__":
    sys.exit(main())
