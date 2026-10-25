-- A-268 tombstone (ARCH 26.10): when the retention cron erases a deleted user
-- that came from an import (source_id set), the sha256 of that source id is
-- kept here, so a later import run of the same source is refused with
-- SOURCE_ID_ERASED instead of bringing the user back with their old link.
-- Neither the source id itself nor anything about the person is stored. Kept
-- forever: a row is 64 characters and a timestamp.
--
-- WRITTEN BY HAND: `migrate dev --create-only` exits on "Drift detected"
-- before drafting. `migrate status` clean before and after, on both databases.
--
-- Rollback:
--   DROP TABLE "erased_user_sources";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261025225015_erased_user_sources';
--
-- The test that holds this file: src/modules/maintenance/erased-sources-migration.test.ts
-- (forward, back, forward).

CREATE TABLE "erased_user_sources" (
    "source_id_sha256" CHAR(64) NOT NULL,
    "erased_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "erased_user_sources_pkey" PRIMARY KEY ("source_id_sha256")
);
