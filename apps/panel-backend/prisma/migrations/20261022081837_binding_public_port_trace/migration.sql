-- A-150 tail: clear the public port the node wizard left behind.
--
-- The wizard created bindings with publicPort = port (useNodeCreateForm.ts:265),
-- and the subscription reads publicPort ?? port (subscription.service.ts:942).
-- Moving the listen port from the host screen then moved `port` and left the
-- copy, so clients stayed on the old port. A public port equal to the listen
-- port says nothing a NULL does not, so it is cleared here, by the same move
-- as 20261022060001 for host overrides. A real public port (NAT) differs from
-- the listen port and is left alone.
--
-- The touched rows are saved first in binding_public_port_a150_backup, so
-- the rollback puts back exactly what this cleared. Kept until v0.3.0 and a
-- stable week on the stand, then dropped by a migration of its own.
--
-- WRITTEN BY HAND (CLAUDE.local.md). Data only, no schema change.
--
-- ROLLBACK (by hand):
--   UPDATE "profile_node_bindings" pb SET "public_port" = b."public_port"
--     FROM "binding_public_port_a150_backup" b WHERE pb."id" = b."binding_id";
--   DROP TABLE "binding_public_port_a150_backup";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261022081837_binding_public_port_trace';

CREATE TABLE "binding_public_port_a150_backup" (
    "binding_id" UUID PRIMARY KEY,
    "public_port" INTEGER NOT NULL,
    "saved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "binding_public_port_a150_backup" ("binding_id", "public_port")
SELECT pb."id", pb."public_port"
FROM "profile_node_bindings" pb
WHERE pb."public_port" IS NOT NULL AND pb."public_port" = pb."port";

UPDATE "profile_node_bindings" pb
SET "public_port" = NULL
FROM "binding_public_port_a150_backup" b
WHERE pb."id" = b."binding_id";
