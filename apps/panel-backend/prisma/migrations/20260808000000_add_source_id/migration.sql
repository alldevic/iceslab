-- Provenance for imported rows: where a record came from in the SOURCE panel.
--
-- ⚠ This is the blocker that makes a migration repeatable. Without it a second
-- import run cannot tell "this user is already here" from "this is a new user",
-- so it either duplicates the whole set or forces matching on username, which
-- the source panel lets people change. With it, a run is a delta: match on
-- source_id, insert what is missing, update what moved.
--
-- Nullable on purpose: rows created in this panel have no origin, and that is
-- the normal case. UNIQUE is partial (NULLs excluded by Postgres), so any
-- number of native rows coexist while an imported id can appear only once.
--
-- Text, not uuid: the source's identifier format is theirs, not ours. Storing
-- it verbatim keeps the mapping auditable after the fact.

ALTER TABLE "users"    ADD COLUMN "source_id" VARCHAR(128);
ALTER TABLE "nodes"    ADD COLUMN "source_id" VARCHAR(128);
ALTER TABLE "groups"   ADD COLUMN "source_id" VARCHAR(128);
ALTER TABLE "hosts"    ADD COLUMN "source_id" VARCHAR(128);
ALTER TABLE "profiles" ADD COLUMN "source_id" VARCHAR(128);

-- Unique per entity so a repeated import cannot create a second copy, and fast
-- to look up because the importer hits it once per record (6804 users on the
-- deal in progress, so a sequential scan per row is not an option).
CREATE UNIQUE INDEX "users_source_id_key"    ON "users"("source_id")    WHERE "source_id" IS NOT NULL;
CREATE UNIQUE INDEX "nodes_source_id_key"    ON "nodes"("source_id")    WHERE "source_id" IS NOT NULL;
CREATE UNIQUE INDEX "groups_source_id_key"   ON "groups"("source_id")   WHERE "source_id" IS NOT NULL;
CREATE UNIQUE INDEX "hosts_source_id_key"    ON "hosts"("source_id")    WHERE "source_id" IS NOT NULL;
CREATE UNIQUE INDEX "profiles_source_id_key" ON "profiles"("source_id") WHERE "source_id" IS NOT NULL;
