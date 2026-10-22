-- A-150: clear the port override the create screen left behind.
--
-- The host form sent the binding's own listen port as portOverride on create
-- (HostEditPage.tsx:471), so most hosts carry an override equal to what
-- clients would get without one. Harmless until the listen port moves: then
-- the stale copy wins in the subscription (subscription.service.ts:947) and
-- clients are handed the old port. Not an operator's edit, a trace, so it is
-- cleared here: override := NULL where it equals the binding's public port,
-- or its listen port when there is no public port. A real override (NAT, CDN)
-- differs from both and is left alone.
--
-- The touched rows are saved first, in host_port_override_a150_backup, so the
-- rollback puts back exactly what this cleared and nothing else. The table is
-- dropped by the rollback; keep it until the next release is out.
--
-- WRITTEN BY HAND (CLAUDE.local.md: `migrate dev --create-only` exits on
-- "Drift detected"). Data only, no schema change.
--
-- ROLLBACK (by hand):
--   UPDATE "hosts" h SET "port_override" = b."port_override"
--     FROM "host_port_override_a150_backup" b WHERE h."id" = b."host_id";
--   DROP TABLE "host_port_override_a150_backup";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261022060001_host_port_override_trace';

CREATE TABLE "host_port_override_a150_backup" (
    "host_id" UUID PRIMARY KEY,
    "port_override" INTEGER NOT NULL,
    "saved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "host_port_override_a150_backup" ("host_id", "port_override")
SELECT h."id", h."port_override"
FROM "hosts" h
JOIN "profile_node_bindings" pb ON pb."id" = h."binding_id"
WHERE h."port_override" IS NOT NULL
  AND h."port_override" = COALESCE(pb."public_port", pb."port");

UPDATE "hosts" h
SET "port_override" = NULL
FROM "host_port_override_a150_backup" b
WHERE h."id" = b."host_id";
