-- A-124: notAfter of the node's mTLS server certificate.
--
-- Written from the agent's /healthz (certNotAfter) by the status poll; the
-- renewal cron hands a node a new pair through /rotateCert when this falls
-- within 30 days. Null until an agent that reports it is polled.
--
-- WRITTEN BY HAND (CLAUDE.local.md).
--
-- ROLLBACK (by hand):
--   ALTER TABLE "nodes" DROP COLUMN "cert_not_after";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261022205621_node_cert_not_after';

ALTER TABLE "nodes" ADD COLUMN "cert_not_after" TIMESTAMPTZ(6);
