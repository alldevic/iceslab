-- A-232: what the node's xray did with the node policy, from its /healthz.
--
-- { drawing, notDrawn: [{ exit, direction }], renderedAt, observedAt }, written
-- by the status poll like chain_status; a poll without the field keeps what is
-- stored. /api/nodes/:id/policy-drawing shows it beside the drawing the panel
-- sent. Null until an agent that reports it is polled.
--
-- WRITTEN BY HAND (CLAUDE.local.md).
--
-- ROLLBACK (by hand):
--   ALTER TABLE "nodes" DROP COLUMN "policy_drawn";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261024175834_node_policy_drawn';

ALTER TABLE "nodes" ADD COLUMN "policy_drawn" JSONB;
