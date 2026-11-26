-- Two columns on users that the Remnawave facade rests on. Unused while
-- REMNAWAVE_COMPAT_ENABLED is off.
--
-- numeric_id: Remnawave 3.x dropped `uuid` from its user object; an integer
-- `id` is the only reference its user routes take. BIGSERIAL backfills every
-- row in one pass and sets NOT NULL, which REWRITES the table (a lock for the
-- time of the rewrite on a large one). The sequence is never reset: a user
-- erased by retention (A-268) takes the number away, and nobody gets it
-- again, because a storefront keeps it as the subscriber's key.
--
-- external_squad_uuid: the storefront's external squad id, returned as
-- written. Not a foreign key, no index.
--
-- WRITTEN BY HAND.
--
-- Rollback:
--   ALTER TABLE "users" DROP COLUMN "external_squad_uuid";
--   ALTER TABLE "users" DROP COLUMN "numeric_id";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261126100000_user_numeric_id_external_squad';

ALTER TABLE "users" ADD COLUMN "numeric_id" BIGSERIAL NOT NULL;
CREATE UNIQUE INDEX "users_numeric_id_key" ON "users"("numeric_id");
ALTER TABLE "users" ADD COLUMN "external_squad_uuid" VARCHAR(64);
