#!/usr/bin/env python3
"""Give both halves node traffic, so the walkthrough can compare a filled list.

`compare_admin.py` accepts a divergence on `panel.nodes_bandwidth.series`
because the shop reads it only as a fallback "when `topNodes` is empty - and we
always fill `topNodes`". The walkthrough never tested that: its window contains
no node traffic on either half, `topNodes` comes back empty everywhere, and the
claim the acceptance rides on is never exercised. §30 made the report SAY so
rather than quietly count it as verified; this makes it unnecessary.

Both halves get the same shape of data — one node, three hourly buckets ending
at the current hour — so `topNodes` is non-empty on each and the comparison is
between two filled lists instead of between two empty ones. The BYTES differ per
half on purpose: they are values, and `compare_admin.py` fails a run on status
and shape, never on values.

The reference panel starts with no nodes at all, so it gets one; ours has the
lab's nodes and needs only the usage rows.

    ./seed_node_traffic.py iceslab|ref
"""

from __future__ import annotations

import subprocess
import sys

ICESLAB_DB = ("iceslab-postgres-test", "iceslab", "iceslab_a2dev")
REF_DB = ("remnawave-dev-db", "postgres", "postgres")

# Three hourly buckets: enough for a sum, few enough to stay obviously synthetic.
#
# The byte expressions cast to bigint explicitly: `generate_series` yields int4,
# and gigabyte-scale products overflow it from the third bucket on ("integer out
# of range"), which is a seed that fails loudly rather than one that silently
# writes two rows.
HOURS = 3


def psql(db: tuple[str, str, str], sql: str) -> str:
    container, user, name = db
    out = subprocess.run(
        ["docker", "exec", container, "psql", "-U", user, "-d", name, "-tAc", sql],
        capture_output=True,
        text=True,
        check=False,
    )
    if out.returncode != 0:
        sys.exit(f"seed: psql on {container} failed: {out.stderr.strip()}")
    return out.stdout.strip()


def seed_iceslab() -> None:
    node = psql(ICESLAB_DB, "select id from nodes where deleted_at is null order by created_at limit 1;")
    if not node:
        sys.exit("seed: our panel has no node to attribute traffic to")
    # Give it the same country as the reference's node. Not decoration: without
    # it the comparison reports `topNodes[].countryCode` as string-vs-null, and
    # that is this fixture's asymmetry rather than anything the facade did — the
    # kind of finding that trains people to skim the report.
    psql(
        ICESLAB_DB,
        f"""
        INSERT INTO node_usage_history (node_id, hour, download_bytes, upload_bytes)
        SELECT '{node}'::uuid,
               date_trunc('hour', now()) - (g || ' hours')::interval,
               (g + 1)::bigint * 1000000000,
               (g + 1)::bigint * 250000000
        FROM generate_series(0, {HOURS - 1}) AS g
        ON CONFLICT (node_id, hour) DO UPDATE
          SET download_bytes = EXCLUDED.download_bytes,
              upload_bytes  = EXCLUDED.upload_bytes;
        """,
    )
    psql(ICESLAB_DB, f"UPDATE nodes SET country_code = 'NL' WHERE id = '{node}'::uuid AND (country_code IS NULL OR country_code = '');")
    rows = psql(ICESLAB_DB, "select count(*) from node_usage_history where hour >= now() - interval '1 day';")
    print(f"seed: iceslab half has {rows} node-usage row(s) in the last day")


def seed_ref() -> None:
    node = psql(REF_DB, "select uuid from nodes limit 1;")
    if not node:
        # -tAc prints the RETURNING row AND psql's "INSERT 0 1" tag, so the
        # uuid is the first line, not the whole output. Taking the lot fed a
        # two-line string into the next statement's ::uuid cast.
        node = psql(
            REF_DB,
            "INSERT INTO nodes (name, address, country_code) "
            "VALUES ('stand-node', '10.255.0.1', 'NL') RETURNING uuid;",
        ).splitlines()[0].strip()
        print(f"seed: reference panel had no node; created {node}")
    psql(
        REF_DB,
        f"""
        INSERT INTO nodes_usage_history (node_uuid, download_bytes, upload_bytes, total_bytes, created_at, updated_at)
        SELECT '{node}'::uuid,
               (g + 1)::bigint * 2000000000,
               (g + 1)::bigint * 500000000,
               (g + 1)::bigint * 2500000000,
               date_trunc('hour', now()) - (g || ' hours')::interval,
               now()
        FROM generate_series(0, {HOURS - 1}) AS g
        ON CONFLICT (node_uuid, created_at) DO UPDATE
          SET download_bytes = EXCLUDED.download_bytes,
              upload_bytes  = EXCLUDED.upload_bytes,
              total_bytes   = EXCLUDED.total_bytes;
        """,
    )
    rows = psql(REF_DB, "select count(*) from nodes_usage_history where created_at >= now() - interval '1 day';")
    print(f"seed: reference half has {rows} node-usage row(s) in the last day")


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"iceslab", "ref"}:
        sys.exit(__doc__)
    (seed_iceslab if sys.argv[1] == "iceslab" else seed_ref)()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
