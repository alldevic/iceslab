-- A-149: a squad's allowed exits are keyed by DIRECTION, not by exit node.
--
-- Keyed by node, the list followed machines instead of the ways out the
-- operator sold: replacing the node under DE silently took DE away from every
-- squad narrowed to it (its row pointed at a node no longer in the cascade),
-- and adding a node to the DE pool silently widened access to whatever else
-- that node served (old A-003). A direction row survives every cascade save
-- (writeTopologyV4 deletes only directions that left), so its id is the key.
--
-- What changes in the table:
--   - a surrogate `id` key, since `direction_id` is nullable (see below);
--   - `direction_id`, FK to cascade_directions ON DELETE SET NULL;
--   - `exit_node_id` becomes nullable and is kept only for the legacy shape:
--     a cascade with hops and no directions has no direction to name.
--
-- Data, by the current node -> direction mapping:
--   - every node row of a cascade WITH directions becomes one row per
--     direction whose pool holds that node. ONE NODE UNDER TWO DIRECTIONS
--     GIVES TWO ROWS: the squad saw both before (the old check was "any node
--     of the pool allowed"), so it keeps both. Duplicates collapse (DISTINCT);
--   - a node row that maps to no direction (the node left the cascade; the
--     victims of A-149 itself) STAYS as it is, direction_id NULL. The service
--     reads any row of a (squad, cascade) as "restricted", so such a squad
--     keeps seeing what it sees today, nothing of that cascade, and is not
--     widened to every exit. The operator re-picks on the squad screen;
--   - a cascade without directions keeps its node rows unchanged.
--
-- ON DELETE SET NULL, not CASCADE, for the same reason: a deleted direction
-- must not turn "restricted to it" into "unrestricted".
--
-- WRITTEN BY HAND: `migrate dev --create-only` exits on "Drift detected"
-- before drafting anything (CLAUDE.local.md). `migrate status` was clean
-- before this was written.
--
-- ROLLBACK (by hand; restores the node keying from the CURRENT pools, so a
-- direction whose pool changed since rolls back to its new nodes; marker rows
-- with neither key are dropped, which un-restricts those squads):
--   ALTER TABLE "group_cascade_exits" DROP CONSTRAINT "group_cascade_exits_direction_id_fkey";
--   INSERT INTO "group_cascade_exits" ("id", "group_id", "cascade_id", "exit_node_id")
--     SELECT DISTINCT ON (e."group_id", e."cascade_id", dn."node_id")
--            gen_random_uuid(), e."group_id", e."cascade_id", dn."node_id"
--     FROM "group_cascade_exits" e
--     JOIN "cascade_direction_nodes" dn ON dn."direction_id" = e."direction_id"
--     WHERE NOT EXISTS (SELECT 1 FROM "group_cascade_exits" x
--                       WHERE x."group_id" = e."group_id" AND x."cascade_id" = e."cascade_id"
--                         AND x."exit_node_id" = dn."node_id");
--   DELETE FROM "group_cascade_exits" WHERE "exit_node_id" IS NULL;
--   DROP INDEX "group_cascade_exits_group_id_direction_id_key";
--   DROP INDEX "group_cascade_exits_group_id_cascade_id_exit_node_id_key";
--   DROP INDEX "group_cascade_exits_direction_id_idx";
--   ALTER TABLE "group_cascade_exits" DROP CONSTRAINT "group_cascade_exits_pkey";
--   ALTER TABLE "group_cascade_exits" DROP COLUMN "direction_id", DROP COLUMN "id";
--   ALTER TABLE "group_cascade_exits" ALTER COLUMN "exit_node_id" SET NOT NULL;
--   ALTER TABLE "group_cascade_exits"
--     ADD CONSTRAINT "group_cascade_exits_pkey" PRIMARY KEY ("group_id", "cascade_id", "exit_node_id");
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261022054807_group_cascade_exits_by_direction';

ALTER TABLE "group_cascade_exits" DROP CONSTRAINT "group_cascade_exits_pkey";
ALTER TABLE "group_cascade_exits" ADD COLUMN "id" UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE "group_cascade_exits" ADD COLUMN "direction_id" UUID;
ALTER TABLE "group_cascade_exits" ALTER COLUMN "exit_node_id" DROP NOT NULL;
ALTER TABLE "group_cascade_exits" ADD CONSTRAINT "group_cascade_exits_pkey" PRIMARY KEY ("id");

-- One row per (squad, direction) whose pool holds an allowed node.
INSERT INTO "group_cascade_exits" ("id", "group_id", "cascade_id", "direction_id")
SELECT gen_random_uuid(), m."group_id", m."cascade_id", m."direction_id"
FROM (
    SELECT DISTINCT e."group_id", e."cascade_id", d."id" AS "direction_id"
    FROM "group_cascade_exits" e
    JOIN "cascade_directions" d ON d."cascade_id" = e."cascade_id"
    JOIN "cascade_direction_nodes" dn ON dn."direction_id" = d."id" AND dn."node_id" = e."exit_node_id"
    WHERE e."direction_id" IS NULL
) m;

-- The node rows those came from: carried by their directions now. Node rows
-- that mapped to nothing, and every row of a cascade without directions, stay.
DELETE FROM "group_cascade_exits" e
WHERE e."direction_id" IS NULL
  AND e."exit_node_id" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "cascade_directions" d
    JOIN "cascade_direction_nodes" dn ON dn."direction_id" = d."id"
    WHERE d."cascade_id" = e."cascade_id" AND dn."node_id" = e."exit_node_id"
  );

CREATE UNIQUE INDEX "group_cascade_exits_group_id_direction_id_key" ON "group_cascade_exits"("group_id", "direction_id");
CREATE UNIQUE INDEX "group_cascade_exits_group_id_cascade_id_exit_node_id_key" ON "group_cascade_exits"("group_id", "cascade_id", "exit_node_id");
CREATE INDEX "group_cascade_exits_direction_id_idx" ON "group_cascade_exits"("direction_id");

ALTER TABLE "group_cascade_exits"
    ADD CONSTRAINT "group_cascade_exits_direction_id_fkey"
    FOREIGN KEY ("direction_id") REFERENCES "cascade_directions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
