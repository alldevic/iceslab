-- Stage 19.2: the operator's own device routing preset gets a list of
-- "names -> DNS server" rules next to its routing rules.
--
--   dns_rules  [{ match, server, note }], validated by the API schema, not by
--              the database. Empty by default: a preset saved before this has
--              none and the subscription is unchanged.
--
-- Nothing else moves: the built-in presets are code and have no row.
--
-- WRITTEN BY HAND: `migrate dev --create-only` stops on drift before drafting
-- (see 20260911133724_node_dns_resolver).
--
-- ROLLBACK (by hand):
--   ALTER TABLE "routing_presets" DROP COLUMN "dns_rules";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261127100000_routing_preset_dns_rules';
-- (the way back loses every DNS rule written.)

ALTER TABLE "routing_presets" ADD COLUMN "dns_rules" JSONB NOT NULL DEFAULT '[]';
