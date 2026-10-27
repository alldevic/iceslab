-- A-221: where cert_not_after came from.
--
-- An agent older than rotation (before cef9f1e7) reports no certNotAfter, so
-- the status poll reads the end off the leaf the node presents on a handshake
-- and marks it here. Such a node cannot be renewed in place (/rotateCert 404):
-- the renewal cron skips it, and the node card says to update the agent
-- before that date.
--
-- WRITTEN BY HAND (CLAUDE.local.md).
--
-- ROLLBACK (by hand):
--   ALTER TABLE "nodes" DROP COLUMN "cert_from_handshake";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261022212307_node_cert_from_handshake';

ALTER TABLE "nodes" ADD COLUMN "cert_from_handshake" BOOLEAN NOT NULL DEFAULT false;
