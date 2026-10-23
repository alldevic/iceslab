-- A-143 (decisions.md 2026-10-22): a node's consumption multiplier is
-- fractional, 0 to 100 in steps of 0.1, and 0 means the node is free.
--
-- Storage: whole tenths in an INTEGER (10 = 1.0), not DECIMAL(4,1).
--   - Billing multiplies byte counts (BigInt) by it: bytes * tenths / 10 is
--     integer arithmetic end to end, with one rounding written in one place
--     (stats.compute.ts), where a decimal would go through a float or a
--     Decimal library on every poll.
--   - The step of 0.1 is the type itself: there is no 1.25 to round.
--   - The column is renamed so its unit is in its name: a raw query or a tool
--     reading the old column as "times" would bill ten times over.
-- Existing values move without loss: N becomes N * 10 (N.0). A row above 100
-- fails the CHECK below and stops the migration, rather than being clamped.
--
-- Written by hand: `prisma migrate dev --create-only` refuses on the
-- historical drift here (CLAUDE.local.md). `migrate status` before and after.
--
-- Rollback:
--   ALTER TABLE "nodes" DROP CONSTRAINT "nodes_consumption_multiplier_tenths_range";
--   ALTER TABLE "nodes" ALTER COLUMN "consumption_multiplier_tenths" DROP DEFAULT;
--   ALTER TABLE "nodes" ALTER COLUMN "consumption_multiplier_tenths" TYPE BIGINT
--     USING (CASE WHEN "consumption_multiplier_tenths" < 10 THEN 1
--                 ELSE ROUND("consumption_multiplier_tenths" / 10.0) END);
--   ALTER TABLE "nodes" ALTER COLUMN "consumption_multiplier_tenths" SET DEFAULT 1;
--   ALTER TABLE "nodes" RENAME COLUMN "consumption_multiplier_tenths" TO "consumption_multiplier";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261022234055_node_consumption_multiplier_tenths';
-- (the way back loses the tenths and the free nodes: 0 and 0.x become 1, the
-- old column could not hold them.)

ALTER TABLE "nodes" RENAME COLUMN "consumption_multiplier" TO "consumption_multiplier_tenths";
ALTER TABLE "nodes" ALTER COLUMN "consumption_multiplier_tenths" DROP DEFAULT;
ALTER TABLE "nodes" ALTER COLUMN "consumption_multiplier_tenths" TYPE INTEGER
  USING ("consumption_multiplier_tenths" * 10)::INTEGER;
ALTER TABLE "nodes" ALTER COLUMN "consumption_multiplier_tenths" SET DEFAULT 10;
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_consumption_multiplier_tenths_range"
  CHECK ("consumption_multiplier_tenths" BETWEEN 0 AND 1000);
