-- Remnawave-compat: two columns the facade needs on users. Unused while
-- REMNAWAVE_COMPAT_ENABLED is off.
--
-- numeric_id: Remnawave 3.0 dropped `uuid` from its user object; an integer
-- `id` is the only reference its user routes take. BIGSERIAL backfills every
-- row in one pass and sets NOT NULL. The sequence is never reset: a user
-- erased by retention (A-268) takes the number away, and nobody gets it
-- again, because a shop keeps it as the subscriber's key.
--
-- external_squad_uuid: the shop's external squad id, echoed back verbatim.
-- The shop compares it after an activation and rolls the payment back on a
-- mismatch. Not a foreign key, no index.
--
-- WRITTEN BY HAND.
-- Test: src/modules/remnawave-compat/remnawave.user-ids-migration.test.ts
-- (forward, back, forward).
--
-- Rollback:
--   ALTER TABLE "users" DROP COLUMN "external_squad_uuid";
--   ALTER TABLE "users" DROP COLUMN "numeric_id";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261027120000_remnawave_user_ids';

ALTER TABLE "users" ADD COLUMN "numeric_id" BIGSERIAL NOT NULL;
CREATE UNIQUE INDEX "users_numeric_id_key" ON "users"("numeric_id");
ALTER TABLE "users" ADD COLUMN "external_squad_uuid" VARCHAR(64);
