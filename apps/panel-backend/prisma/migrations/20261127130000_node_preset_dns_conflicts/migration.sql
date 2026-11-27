-- Stage 19.11: what a recompute of the carried DNS rules left out of a node.
--
--   preset_dns_conflicts  [{ kind, presetId, ... }] per node: a rule of a preset that was
--                         not carried because an earlier preset on the node gave the same
--                         name another server, or a preset left out by the 16-server
--                         limit. Written only when the change came from a squad or a
--                         binding (nothing to refuse). NULL = nothing left out, which is
--                         every node before this. The preset screen (19.12) shows it.
--
-- WRITTEN BY HAND: `migrate dev --create-only` stops on drift before drafting
-- (see 20260911133724_node_dns_resolver).
--
-- ROLLBACK (by hand):
--   ALTER TABLE "nodes" DROP COLUMN "preset_dns_conflicts";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261127130000_node_preset_dns_conflicts';
-- (the way back loses the record only; the next recompute writes it again.)

ALTER TABLE "nodes" ADD COLUMN "preset_dns_conflicts" JSONB;
