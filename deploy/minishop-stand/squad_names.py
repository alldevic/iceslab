#!/usr/bin/env python3
"""Print the squad names a tariff template refers to, one per line.

The template writes squads as `@<name>` so that seed_tariffs.py can resolve them
against the panel each half is pointed at. stand.sh creates the same names on
our panel, and reads them from HERE rather than keeping a second copy: a name
that exists in only one of the two lists is either a catalogue that cannot be
stored or a squad nothing uses.
"""
import json
import sys


def walk(node, found):
    if isinstance(node, dict):
        # `_`-prefixed keys are the template's own prose, and the prose talks
        # ABOUT the @-syntax. Found that by running this and getting a sentence
        # back as a squad name.
        for key, value in node.items():
            if not key.startswith("_"):
                walk(value, found)
    elif isinstance(node, list):
        for value in node:
            walk(value, found)
    elif isinstance(node, str) and node.startswith("@"):
        found.add(node[1:])


def main() -> int:
    with open(sys.argv[1], encoding="utf-8") as handle:
        template = json.load(handle)
    found: set[str] = set()
    walk(template, found)
    print("\n".join(sorted(found)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
