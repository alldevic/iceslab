#!/usr/bin/env python3
"""Print the uuids of the facade's squads whose names are in the given set.

Reads `GET /internal-squads` on stdin. The names arrive as one `|`-separated
argument because they contain spaces, and they come from the tariff template
(via squad_names.py) so that this and the catalogue always mean the same squads.
"""
import json
import sys


def main() -> int:
    wanted = {n for n in sys.argv[1].split("|") if n}
    payload = json.load(sys.stdin)
    rows = (payload.get("response") or {}).get("internalSquads") or []
    found = [r["uuid"] for r in rows if r.get("name") in wanted and r.get("uuid")]
    if len(found) != len(wanted):
        print(
            f"expected {len(wanted)} squad(s) {sorted(wanted)}, the panel lists {len(found)}",
            file=sys.stderr,
        )
        return 1
    print("\n".join(found))
    return 0


if __name__ == "__main__":
    sys.exit(main())
