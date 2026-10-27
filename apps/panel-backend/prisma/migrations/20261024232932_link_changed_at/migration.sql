-- A-122: when what goes into a client's link last changed, per row of the
-- four tables a link is made of (host, binding, profile, node).
--
-- The host card "who still holds the old link" compared the subscribers'
-- last fetch with the latest updated_at of the host, its binding and its
-- profile. updated_at moves on ANY write: dragging hosts rewrites every
-- host's priority, renaming a profile or editing its description changes
-- nothing a client holds, and after either the card said every subscriber was
-- on the old link. link_changed_at moves only when a value that goes into the
-- link really changes (the services decide which, see hosts.freshness.ts).
-- The node's: address, domain (the self-steal SNI), the hysteria pin and the
-- AmneziaWG 3.1 geometry, the last two written at push time.
--
-- Filled with updated_at, so the card answers today what it answered
-- yesterday until the next real change.
--
-- WRITTEN BY HAND. `migrate status` clean before (89 migrations) and after.
-- Test: src/modules/hosts/hosts.link-changed-migration.test.ts
-- (forward, back, forward).
--
-- Rollback:
--   ALTER TABLE "hosts" DROP COLUMN "link_changed_at";
--   ALTER TABLE "profile_node_bindings" DROP COLUMN "link_changed_at";
--   ALTER TABLE "profiles" DROP COLUMN "link_changed_at";
--   ALTER TABLE "nodes" DROP COLUMN "link_changed_at";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261024232932_link_changed_at';
-- After a rollback the card reads updated_at again, false alarms included.

ALTER TABLE "hosts" ADD COLUMN "link_changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now();
UPDATE "hosts" SET "link_changed_at" = "updated_at";

ALTER TABLE "profile_node_bindings" ADD COLUMN "link_changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now();
UPDATE "profile_node_bindings" SET "link_changed_at" = "updated_at";

ALTER TABLE "profiles" ADD COLUMN "link_changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now();
UPDATE "profiles" SET "link_changed_at" = "updated_at";

ALTER TABLE "nodes" ADD COLUMN "link_changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now();
UPDATE "nodes" SET "link_changed_at" = "updated_at";
