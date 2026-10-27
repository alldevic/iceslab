#!/usr/bin/env python3
"""Decide how much premium usage to write, and onto which node.

Prints "<bytes> <node-uuid>". The amount is 20% over the tariff's premium
allowance - enough to be unambiguously over, close enough that a wrong unit
(GB vs GiB) would not accidentally hide a bug by overshooting by orders of
magnitude. The node must be one the PREMIUM squad grants: usage anywhere else is
not premium usage, and a worker that ignored it would be right to.
"""
import json
import sys


def main() -> int:
    template = json.load(open(sys.argv[1], encoding="utf-8"))
    nodes = (json.loads(sys.argv[2]) or {}).get("response") or []
    allowances = [
        t["premium_monthly_gb"]
        for t in template["tariffs"]
        if t.get("premium_monthly_gb")
    ]
    if not allowances:
        print("no tariff in the template has a premium allowance", file=sys.stderr)
        return 1
    if not nodes:
        print("the premium squad grants no node to put usage on", file=sys.stderr)
        return 1
    over = int(float(min(allowances)) * (1024**3) * 1.2)
    print(over, nodes[0]["uuid"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
