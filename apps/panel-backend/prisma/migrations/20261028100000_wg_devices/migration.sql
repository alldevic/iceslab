-- WireGuard devices: a key per client device instead of one per user.
--
-- Every client of a user held the same AmneziaWG key, so a second client took
-- the endpoint over from the first without a word, and revoking one client
-- meant revoking them all. A device is a keypair (and a preshared key) the
-- panel issued; each gets its own address on every AmneziaWG profile, and the
-- user's peer on a node carries one entry per device.
--
-- wg_devices: one row per device. revoked_at keeps a revoked device (and its
-- traffic) on the list after its peers are gone. bytes_in/bytes_out are the
-- device's lifetime totals from the node's per-peer counters, never reset;
-- last_seen_at is the last poll in which it moved bytes.
--
-- Backfill: device #1 for every user, soft-deleted ones included, with the
-- user's own key, so every config already handed out keeps working; the
-- user's amneziawg_peers rows become that device's. The key stays on users
-- (nothing reads it any more) as the way back.
--
-- amneziawg_peers: one address per (profile, device) instead of per
-- (profile, user). The second unique index on (inbound_id, user_id) is a
-- leftover of the inbound->profile rename and would keep the old rule.
--
-- hwid_user_devices: what a client says about itself on /sub (platform, OS
-- version, model, user agent), for the device lists.
--
-- WRITTEN BY HAND.
-- Test: src/modules/wg-devices/wg-devices.migration.test.ts (forward, back,
-- forward).
--
-- Rollback (devices beyond #1 lose their addresses; #1 keeps the user's key):
--   DELETE FROM "amneziawg_peers" p USING "wg_devices" d
--     WHERE d."id" = p."device_id"
--       AND d."id" <> (SELECT d1."id" FROM "wg_devices" d1 WHERE d1."user_id" = d."user_id"
--                      ORDER BY d1."created_at", d1."id" LIMIT 1);
--   DROP INDEX "amneziawg_peers_profile_id_device_id_key";
--   DROP INDEX "amneziawg_peers_device_id_idx";
--   ALTER TABLE "amneziawg_peers" DROP CONSTRAINT "amneziawg_peers_device_id_fkey";
--   ALTER TABLE "amneziawg_peers" DROP COLUMN "device_id";
--   ALTER TABLE "amneziawg_peers" ADD CONSTRAINT "amneziawg_peers_profile_id_user_id_key" UNIQUE ("profile_id", "user_id");
--   DROP TABLE "wg_devices";
--   ALTER TABLE "hwid_user_devices" DROP COLUMN "platform", DROP COLUMN "os_version",
--     DROP COLUMN "device_model", DROP COLUMN "user_agent";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261028100000_wg_devices';

CREATE TABLE "wg_devices" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "label" VARCHAR(64),
    "private_key" VARCHAR(64) NOT NULL,
    "public_key" VARCHAR(64) NOT NULL,
    "preshared_key" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),
    "bytes_in" BIGINT NOT NULL DEFAULT 0,
    "bytes_out" BIGINT NOT NULL DEFAULT 0,
    "last_seen_at" TIMESTAMPTZ(6),

    CONSTRAINT "wg_devices_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "wg_devices_user_id_idx" ON "wg_devices"("user_id");
CREATE UNIQUE INDEX "wg_devices_public_key_key" ON "wg_devices"("public_key");
ALTER TABLE "wg_devices" ADD CONSTRAINT "wg_devices_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "wg_devices" ("id", "user_id", "private_key", "public_key", "created_at")
SELECT gen_random_uuid(), u."id", u."amneziawg_private_key", u."amneziawg_public_key", u."created_at"
FROM "users" u;

ALTER TABLE "amneziawg_peers" ADD COLUMN "device_id" UUID;
UPDATE "amneziawg_peers" p SET "device_id" = d."id" FROM "wg_devices" d WHERE d."user_id" = p."user_id";
ALTER TABLE "amneziawg_peers" ALTER COLUMN "device_id" SET NOT NULL;
ALTER TABLE "amneziawg_peers" ADD CONSTRAINT "amneziawg_peers_device_id_fkey"
    FOREIGN KEY ("device_id") REFERENCES "wg_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "amneziawg_peers" DROP CONSTRAINT IF EXISTS "amneziawg_peers_profile_id_user_id_key";
DROP INDEX IF EXISTS "amneziawg_peers_profile_id_user_id_key";
DROP INDEX IF EXISTS "amneziawg_peers_inbound_id_user_id_key";
CREATE UNIQUE INDEX "amneziawg_peers_profile_id_device_id_key" ON "amneziawg_peers"("profile_id", "device_id");
CREATE INDEX "amneziawg_peers_device_id_idx" ON "amneziawg_peers"("device_id");

ALTER TABLE "hwid_user_devices" ADD COLUMN "platform" VARCHAR(64);
ALTER TABLE "hwid_user_devices" ADD COLUMN "os_version" VARCHAR(64);
ALTER TABLE "hwid_user_devices" ADD COLUMN "device_model" VARCHAR(128);
ALTER TABLE "hwid_user_devices" ADD COLUMN "user_agent" TEXT;
