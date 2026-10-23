-- A-229 part 1 (decisions.md 2026-10-23): the operator's own device routing
-- presets, next to the three built-in ones.
--
-- routing_presets holds only the operator's presets. The built-ins stay code
-- (ROUTING_PRESET_IDS in @iceslab/shared) and are never rows: a row could be
-- edited or deleted, and the server refuses both for a built-in.
--   rules   the ordered rule list [{ match, action, note }], validated by the
--           API schema (part 2), not by the database.
--
-- users and groups get custom_routing_preset_id next to the routing_preset key
-- they already have. At most one of the two is set: the CHECK says it, the API
-- schema refuses both at once, and writing one clears the other. Both NULL is
-- "inherit", as before.
--
-- The foreign keys are ON DELETE RESTRICT: a preset in use is not deleted from
-- under its users and squads. The API answers 409 ROUTING_PRESET_IN_USE with
-- who uses it before the database has to; RESTRICT is the floor under that.
-- Indexed, because that same in-use question reads them on every delete.
--
-- No database default on id: Prisma generates it (@default(uuid())), and a
-- raw-SQL default is exactly the drift every generated draft has been trying
-- to drop (CLAUDE.local.md).
--
-- WRITTEN BY HAND: `migrate dev --create-only` exits on "Drift detected"
-- before drafting. `migrate status` clean before (83 migrations) and after.
--
-- ROLLBACK (by hand):
--   ALTER TABLE "users" DROP CONSTRAINT "users_one_routing_preset";
--   ALTER TABLE "groups" DROP CONSTRAINT "groups_one_routing_preset";
--   ALTER TABLE "users" DROP COLUMN "custom_routing_preset_id";
--   ALTER TABLE "groups" DROP COLUMN "custom_routing_preset_id";
--   DROP TABLE "routing_presets";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261023000942_routing_presets';
-- (the way back loses every own preset and every assignment of one: those
-- users and squads fall back to inherit.)

CREATE TABLE "routing_presets" (
    "id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "rules" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "routing_presets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "routing_presets_name_key" ON "routing_presets"("name");

ALTER TABLE "users" ADD COLUMN "custom_routing_preset_id" UUID;
ALTER TABLE "groups" ADD COLUMN "custom_routing_preset_id" UUID;

CREATE INDEX "users_custom_routing_preset_id_idx" ON "users"("custom_routing_preset_id");
CREATE INDEX "groups_custom_routing_preset_id_idx" ON "groups"("custom_routing_preset_id");

ALTER TABLE "users" ADD CONSTRAINT "users_custom_routing_preset_id_fkey"
  FOREIGN KEY ("custom_routing_preset_id") REFERENCES "routing_presets"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "groups" ADD CONSTRAINT "groups_custom_routing_preset_id_fkey"
  FOREIGN KEY ("custom_routing_preset_id") REFERENCES "routing_presets"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "users" ADD CONSTRAINT "users_one_routing_preset"
  CHECK ("routing_preset" IS NULL OR "custom_routing_preset_id" IS NULL);
ALTER TABLE "groups" ADD CONSTRAINT "groups_one_routing_preset"
  CHECK ("routing_preset" IS NULL OR "custom_routing_preset_id" IS NULL);
