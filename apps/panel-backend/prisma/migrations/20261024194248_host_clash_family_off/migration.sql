-- A-249: a host switched off for `clash` stays off for the whole Clash
-- family.
--
-- Step 4 of A-236 split the Clash answer by core (mihomo, stash,
-- clash-legacy) and moved the seeded User-Agent rules to mihomo and stash. A
-- host's disable_for_formats is matched by the exact format name, so a host
-- an operator had switched off for `clash` started going to every Clash
-- (now mihomo) and Stash client without a word. Here every host whose list
-- has 'clash' gets 'mihomo', 'stash' and 'clash-legacy' too, each once, in
-- that order after what it had. The serving side reads `clash` and `mihomo`
-- as one format from now on (formatDisabledForHost), so a list with either
-- closes both.
--
-- Data only. WRITTEN BY HAND. `migrate status` clean before (87 migrations)
-- and after. Test: src/modules/hosts/hosts.clash-family-migration.test.ts
-- (forward, back, forward; a host without 'clash' untouched).
--
-- Rollback:
--   UPDATE "hosts" SET "disable_for_formats" = ARRAY(SELECT f FROM unnest("disable_for_formats") WITH ORDINALITY AS t(f, i) WHERE f NOT IN ('mihomo', 'stash', 'clash-legacy') ORDER BY i) WHERE 'clash' = ANY("disable_for_formats");
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261024194248_host_clash_family_off';
-- The rollback takes these three names off every host with 'clash',
-- including ones an operator set by hand after this migration (or in the
-- hours between step 4 and it): the database cannot tell ours from theirs.
-- An accepted loss; those hosts keep 'clash', so they stay off for the alias.

UPDATE "hosts"
SET "disable_for_formats" = "disable_for_formats" || ARRAY(
  SELECT f FROM unnest(ARRAY['mihomo', 'stash', 'clash-legacy']::text[]) WITH ORDINALITY AS t(f, i)
  WHERE NOT (f = ANY("disable_for_formats"))
  ORDER BY i
)
WHERE 'clash' = ANY("disable_for_formats");
