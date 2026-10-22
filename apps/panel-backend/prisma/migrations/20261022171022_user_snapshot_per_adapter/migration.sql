-- A-163: a user's cumulative snapshot is kept per ADAPTER, not per node.
--
-- Key (node_id, user_id, protocol, engine), the pair the agent dispatches on.
-- Before, the counters of every adapter a user reached on one node were summed
-- and compared with ONE snapshot. One adapter missing a poll lowered the sum,
-- the snapshot re-baselined down, and the poll it came back billed its whole
-- cumulative counter at once: a user on xray (40 GB) and sing-box (9 GB) got
-- 9 GB in one poll after a single silent poll of sing-box, and went limited.
--
-- Existing rows become protocol = '' and engine = '': the summed snapshot of
-- an agent that does not name its engine, which is exactly what the poller
-- keeps doing for such an agent. The day a node's agent starts naming
-- adapters, each adapter of a user is seen for the first time and baselines
-- at a zero delta (one poll, about 30 s of that user's traffic on that node,
-- goes unbilled), and the poller drops the user's '' row on that node. That
-- is the transition: no backfill, since no stored row says how its sum split.
--
-- WRITTEN BY HAND (CLAUDE.local.md).
--
-- ROLLBACK (by hand; keeps one row per (node, user): the summed counters, so
-- the old poller compares like with like):
--   CREATE TEMP TABLE s AS
--     SELECT node_id, user_id, SUM(cum_in) AS cum_in, SUM(cum_out) AS cum_out, MAX(updated_at) AS updated_at
--     FROM node_user_traffic_snapshot GROUP BY node_id, user_id;
--   DELETE FROM node_user_traffic_snapshot;
--   ALTER TABLE node_user_traffic_snapshot DROP CONSTRAINT node_user_traffic_snapshot_pkey;
--   ALTER TABLE node_user_traffic_snapshot DROP COLUMN protocol, DROP COLUMN engine;
--   ALTER TABLE node_user_traffic_snapshot ADD CONSTRAINT node_user_traffic_snapshot_pkey PRIMARY KEY (node_id, user_id);
--   INSERT INTO node_user_traffic_snapshot (node_id, user_id, cum_in, cum_out, updated_at) SELECT * FROM s;
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261022171022_user_snapshot_per_adapter';

ALTER TABLE "node_user_traffic_snapshot"
    ADD COLUMN "protocol" VARCHAR(32) NOT NULL DEFAULT '',
    ADD COLUMN "engine" VARCHAR(32) NOT NULL DEFAULT '';

ALTER TABLE "node_user_traffic_snapshot" DROP CONSTRAINT "node_user_traffic_snapshot_pkey";
ALTER TABLE "node_user_traffic_snapshot"
    ADD CONSTRAINT "node_user_traffic_snapshot_pkey" PRIMARY KEY ("node_id", "user_id", "protocol", "engine");
