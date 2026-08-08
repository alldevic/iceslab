-- Cascades v4: hop -> position (a pool of interchangeable nodes) and exit ->
-- direction (a stable tag with a pool behind it).
--
-- Why both at once: `position` carried two meanings at the same time. For a
-- chain the LAST position was the exit; for a balancer EVERY non-zero position
-- was one. A pool cannot be introduced under that ambiguity without breaking
-- one of the two readings, so the split and the pool are a single migration.
--
-- Why tags must be preserved byte for byte: a tag is written into the client's
-- UUID (bytes 7-8, read by xray as vlessRoute) and squad ACL cuts access by it.
-- Today it is the exit's ORDINAL POSITION in a list sorted by `position`
-- (cascade.service.ts:218-220 -> routeTag(ordinal, index) = ordinal*256 +
-- index + 1). The backfill below reproduces exactly that order, so every link
-- already in a user's client keeps resolving to the same country.
--
-- cascade_hops and cascades.mode are deliberately NOT dropped here. They stay
-- as the rollback path for one release; no code reads them after this.

ALTER TABLE "cascades"
    ADD COLUMN "next_direction_tag" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "cascade_positions" (
    "id" UUID NOT NULL,
    "cascade_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "entry_protocol" VARCHAR(32),
    "link_protocol" VARCHAR(32),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "cascade_positions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cascade_positions_cascade_id_position_key"
    ON "cascade_positions"("cascade_id", "position");

ALTER TABLE "cascade_positions"
    ADD CONSTRAINT "cascade_positions_cascade_id_fkey"
    FOREIGN KEY ("cascade_id") REFERENCES "cascades"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "cascade_position_nodes" (
    "position_id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    CONSTRAINT "cascade_position_nodes_pkey" PRIMARY KEY ("position_id", "node_id")
);

CREATE INDEX "cascade_position_nodes_node_id_idx" ON "cascade_position_nodes"("node_id");

ALTER TABLE "cascade_position_nodes"
    ADD CONSTRAINT "cascade_position_nodes_position_id_fkey"
    FOREIGN KEY ("position_id") REFERENCES "cascade_positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT, not CASCADE: deleting a node that a live cascade routes through
-- must be a deliberate act, not something the operator learns about from a
-- user complaint.
ALTER TABLE "cascade_position_nodes"
    ADD CONSTRAINT "cascade_position_nodes_node_id_fkey"
    FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "cascade_directions" (
    "id" UUID NOT NULL,
    "cascade_id" UUID NOT NULL,
    "tag" INTEGER NOT NULL,
    "country_code" CHAR(2),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "cascade_directions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cascade_directions_cascade_id_tag_key"
    ON "cascade_directions"("cascade_id", "tag");

ALTER TABLE "cascade_directions"
    ADD CONSTRAINT "cascade_directions_cascade_id_fkey"
    FOREIGN KEY ("cascade_id") REFERENCES "cascades"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "cascade_direction_nodes" (
    "direction_id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    CONSTRAINT "cascade_direction_nodes_pkey" PRIMARY KEY ("direction_id", "node_id")
);

CREATE INDEX "cascade_direction_nodes_node_id_idx" ON "cascade_direction_nodes"("node_id");

ALTER TABLE "cascade_direction_nodes"
    ADD CONSTRAINT "cascade_direction_nodes_direction_id_fkey"
    FOREIGN KEY ("direction_id") REFERENCES "cascade_directions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cascade_direction_nodes"
    ADD CONSTRAINT "cascade_direction_nodes_node_id_fkey"
    FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One row per node-to-node leg, PER DIRECTION. The direction has to be part of
-- the key because only the entry can read which direction a client picked (it
-- rides in the UUID); a transit further down sees an internal link, not a user.
-- Separate credentials per direction on every leg are what let a transit tell
-- them apart and fan them back out, which is the shape the old model could not
-- express at all.
--
-- The listen port is shared per receiving step: both xray and SS2022 accept
-- several clients on one inbound, so N directions cost N secrets but one port.
CREATE TABLE "cascade_links" (
    "id" UUID NOT NULL,
    "cascade_id" UUID NOT NULL,
    "from_node_id" UUID NOT NULL,
    "to_node_id" UUID NOT NULL,
    "direction_tag" INTEGER NOT NULL,
    "protocol" VARCHAR(32) NOT NULL,
    "config" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "cascade_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cascade_links_cascade_id_from_to_direction_key"
    ON "cascade_links"("cascade_id", "from_node_id", "to_node_id", "direction_tag");
CREATE INDEX "cascade_links_from_node_id_idx" ON "cascade_links"("from_node_id");
CREATE INDEX "cascade_links_to_node_id_idx" ON "cascade_links"("to_node_id");

ALTER TABLE "cascade_links"
    ADD CONSTRAINT "cascade_links_cascade_id_fkey"
    FOREIGN KEY ("cascade_id") REFERENCES "cascades"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cascade_links"
    ADD CONSTRAINT "cascade_links_from_node_id_fkey"
    FOREIGN KEY ("from_node_id") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cascade_links"
    ADD CONSTRAINT "cascade_links_to_node_id_fkey"
    FOREIGN KEY ("to_node_id") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───── Backfill ─────

-- Every hop, annotated with what it becomes. A chain's exit is its highest
-- position; a balancer's exits are all of its non-zero positions.
CREATE TEMPORARY VIEW v4_hop AS
SELECT
    h."id"             AS hop_id,
    h."cascade_id",
    h."node_id",
    h."position",
    h."entry_protocol",
    h."link_protocol",
    h."link_config",
    c."mode",
    MAX(h."position") OVER (PARTITION BY h."cascade_id") AS max_position,
    CASE
        WHEN c."mode" = 'balancer' THEN h."position" <> 0
        ELSE h."position" = MAX(h."position") OVER (PARTITION BY h."cascade_id")
             AND MAX(h."position") OVER (PARTITION BY h."cascade_id") > 0
    END AS is_exit
FROM "cascade_hops" h
JOIN "cascades" c ON c."id" = h."cascade_id";

-- Positions: entry plus transits. A degenerate single-hop cascade (which the
-- validator does not allow, but old rows might carry) keeps its hop here rather
-- than losing it: better an incomplete cascade the operator can see and fix
-- than a silently dropped node.
INSERT INTO "cascade_positions" ("id", "cascade_id", "position", "entry_protocol", "link_protocol")
SELECT gen_random_uuid(), "cascade_id", "position", "entry_protocol", "link_protocol"
FROM v4_hop
WHERE NOT is_exit;

INSERT INTO "cascade_position_nodes" ("position_id", "node_id")
SELECT p."id", h."node_id"
FROM v4_hop h
JOIN "cascade_positions" p
  ON p."cascade_id" = h."cascade_id" AND p."position" = h."position"
WHERE NOT h.is_exit;

-- Directions, numbered in the SAME order the old tag generator walked them:
-- position ascending, 1-based. That is what makes tags survive.
INSERT INTO "cascade_directions" ("id", "cascade_id", "tag", "country_code")
SELECT
    gen_random_uuid(),
    e."cascade_id",
    ROW_NUMBER() OVER (PARTITION BY e."cascade_id" ORDER BY e."position"),
    n."country_code"
FROM v4_hop e
JOIN "nodes" n ON n."id" = e."node_id"
WHERE e.is_exit;

INSERT INTO "cascade_direction_nodes" ("direction_id", "node_id")
SELECT d."id", e."node_id"
FROM v4_hop e
JOIN LATERAL (
    SELECT ROW_NUMBER() OVER (PARTITION BY e2."cascade_id" ORDER BY e2."position") AS tag,
           e2."node_id",
           e2."cascade_id"
    FROM v4_hop e2
    WHERE e2."cascade_id" = e."cascade_id" AND e2.is_exit
) ranked ON ranked."node_id" = e."node_id" AND ranked."cascade_id" = e."cascade_id"
JOIN "cascade_directions" d
  ON d."cascade_id" = e."cascade_id" AND d."tag" = ranked.tag
WHERE e.is_exit;

-- The counter starts past every tag handed out, so a direction deleted later
-- never passes its tag to a new one.
UPDATE "cascades" c
SET "next_direction_tag" = COALESCE(
    (SELECT MAX(d."tag") + 1 FROM "cascade_directions" d WHERE d."cascade_id" = c."id"),
    1
);

-- Links, chain: the cred sits on the ORIGINATING hop and points at the next
-- position up (cascade.service.ts:341, credIdx for the non-balancer branch).
-- A chain has exactly one direction, so every leg carries that one tag.
INSERT INTO "cascade_links" ("id", "cascade_id", "from_node_id", "to_node_id", "direction_tag", "protocol", "config")
SELECT
    gen_random_uuid(),
    src."cascade_id",
    src."node_id",
    dst."node_id",
    d."tag",
    COALESCE(src."link_protocol", 'vless'),
    src."link_config"
FROM v4_hop src
JOIN v4_hop dst
  ON dst."cascade_id" = src."cascade_id" AND dst."position" = src."position" + 1
JOIN "cascade_directions" d ON d."cascade_id" = src."cascade_id"
WHERE src."mode" <> 'balancer'
  AND src."link_config" IS NOT NULL;

-- Links, balancer: the cred sits on the EXIT hop and the link runs from the
-- single entry, using the ENTRY's protocol for every leg (uniform DC-to-DC,
-- cascade.service.ts:336). Each leg carries the tag of the direction that exit
-- became, so the credentials stay paired with the same country as before.
INSERT INTO "cascade_links" ("id", "cascade_id", "from_node_id", "to_node_id", "direction_tag", "protocol", "config")
SELECT
    gen_random_uuid(),
    ex."cascade_id",
    entry."node_id",
    ex."node_id",
    d."tag",
    COALESCE(entry."link_protocol", 'vless'),
    ex."link_config"
FROM v4_hop ex
JOIN v4_hop entry
  ON entry."cascade_id" = ex."cascade_id" AND entry."position" = 0
JOIN "cascade_direction_nodes" dn ON dn."node_id" = ex."node_id"
JOIN "cascade_directions" d
  ON d."id" = dn."direction_id" AND d."cascade_id" = ex."cascade_id"
WHERE ex."mode" = 'balancer'
  AND ex."position" <> 0
  AND ex."link_config" IS NOT NULL;

DROP VIEW v4_hop;
