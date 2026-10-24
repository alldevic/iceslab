-- A-236 step 4 (docs/plan/subscription-templates.md 4.3): the User-Agent rules
-- answer by the client's CORE, not by its name, and a rule may name the
-- operator template its clients get.
--
-- 1. template_name: the template the matched client is framed by, by name,
--    of the type its format is framed by (clash and mihomo: mihomo, stash:
--    stash, clash-legacy: clash, singbox, xrayjson, xrayjson-array). NULL is
--    the Default. Not a foreign key: a template is named, not owned, and a
--    rule naming a template that was deleted falls back to the Default
--    rather than taking the rule down with it.
--
-- 2. The seeded rules move to the families (packages/shared/src/clients.ts,
--    CLIENT_RULES):
--      Clash            clash -> mihomo   (Clash Verge, FlClash, Clash Meta
--                                          for Android: all mihomo cores);
--      NekoBox/NekoRay  clash -> mihomo   (asks for "ClashMeta Format");
--      Stash            clash -> stash    (its own dialect).
--    The format `clash` itself stays, an alias of mihomo, byte for byte as it
--    always answered; an explicit ?format=clash is never rewritten. No rule is
--    added for legacy Clash: no client in the catalog runs the legacy core,
--    and no User-Agent sample is invented; ?format=clash-legacy serves it.
--
-- WHICH ROWS ARE OURS, as in 20260923131631: a row is seeded exactly when its
-- name, pattern AND format are still what the seed wrote. Only such a row is
-- rewritten; a row an operator edited, and every rule an operator added, is
-- left as it is. The priority is not touched.
--
-- The test that holds this file: src/modules/srr/srr.families-migration.test.ts
-- (forward, back, forward, and the seeds both ways).
--
-- WRITTEN BY HAND: `migrate dev --create-only` exits on "Drift detected" before
-- drafting. `migrate status` clean before (86 migrations) and after.
--
-- Rollback:
--   UPDATE "subscription_response_rules" SET "format" = 'clash', "updated_at" = CURRENT_TIMESTAMP
--     WHERE "name" IN ('Clash', 'NekoBox/NekoRay') AND "format" = 'mihomo'
--       AND "ua_pattern" IN ('(?i)clash|mihomo', 'NekoBox|NekoRay');
--   UPDATE "subscription_response_rules" SET "format" = 'clash', "updated_at" = CURRENT_TIMESTAMP
--     WHERE "name" = 'Stash' AND "ua_pattern" = '(?i)stash' AND "format" = 'stash';
--   ALTER TABLE "subscription_response_rules" DROP COLUMN "template_name";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261024183834_srr_core_families';
-- (the way back loses every template a rule named: those clients get the
-- Default again.)

ALTER TABLE "subscription_response_rules" ADD COLUMN "template_name" VARCHAR(64);

UPDATE "subscription_response_rules" AS r
SET "format" = v.new_format,
    "updated_at" = CURRENT_TIMESTAMP
FROM (VALUES
  ('Clash',           '(?i)clash|mihomo', 'clash', 'mihomo'),
  ('NekoBox/NekoRay', 'NekoBox|NekoRay',  'clash', 'mihomo'),
  ('Stash',           '(?i)stash',        'clash', 'stash')
) AS v(name, pattern, old_format, new_format)
WHERE r."name" = v.name
  AND r."ua_pattern" = v.pattern
  AND r."format" = v.old_format;
