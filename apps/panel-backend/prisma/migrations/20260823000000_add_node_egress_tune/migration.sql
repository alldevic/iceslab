-- F3: the self-tuned DPI-bypass strategy a node reports for itself.
-- Reported state, alongside core_restarts, not configuration: nullable and
-- additive, so existing rows need no backfill.
ALTER TABLE "nodes" ADD COLUMN "egress_tune" JSONB;
