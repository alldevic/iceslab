-- A-162: a node's config as a revision.
--
-- desired_revision grows on every event that asks for a push; the push job
-- writes the revision it read at the start of building the request into
-- applied_revision once the agent answered ok. "Applied" is applied >=
-- desired. config_changed_at is when desired last grew (the node card's
-- "changed at"). See nodes.prisma for why the flag and the time comparison
-- went.
--
-- Backfill: every node starts at 0/0, i.e. applied, EXCEPT a node whose last
-- push did not land (never acknowledged, or an error newer than the last
-- acknowledgement): that one starts at desired 1, so the poll cron's
-- reconciliation (online and applied < desired -> push) brings it to the
-- config without waiting for an operator edit. config_changed_at starts as
-- the last acknowledgement, so the card says something true on day one.
--
-- WRITTEN BY HAND (CLAUDE.local.md).
--
-- ROLLBACK (by hand):
--   ALTER TABLE "nodes" DROP COLUMN "desired_revision", DROP COLUMN "applied_revision", DROP COLUMN "config_changed_at";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261022103248_node_config_revision';

ALTER TABLE "nodes"
    ADD COLUMN "desired_revision" BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN "applied_revision" BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN "config_changed_at" TIMESTAMPTZ(6);

UPDATE "nodes" SET "config_changed_at" = "last_inbound_sync_at";

UPDATE "nodes"
SET "desired_revision" = 1
WHERE "deleted_at" IS NULL
  AND (
    "last_inbound_sync_at" IS NULL
    OR (
      "last_inbound_sync_error" IS NOT NULL
      AND ("last_inbound_sync_error"->>'at')::timestamptz > "last_inbound_sync_at"
    )
  );
