-- Stage 19.10: the DNS rules of routing presets, carried to the nodes that serve
-- the users of those presets.
--
--   preset_dns_rules  [{ presetId, rules: [{ match, server }] }] per node; presetId
--                     null = the panel-wide rules. Kept apart from the manual
--                     nodes.dns, which is never touched; the push merges the two.
--                     NULL = nothing carried, which is every node before this and
--                     keeps the request exactly as it was.
--
-- WRITTEN BY HAND: `migrate dev --create-only` stops on drift before drafting
-- (see 20260911133724_node_dns_resolver).
--
-- ROLLBACK (by hand):
--   ALTER TABLE "nodes" DROP COLUMN "preset_dns_rules";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261127120000_node_preset_dns_rules';
-- (the way back loses the carried rules; saving the presets again rebuilds them.)

ALTER TABLE "nodes" ADD COLUMN "preset_dns_rules" JSONB;
