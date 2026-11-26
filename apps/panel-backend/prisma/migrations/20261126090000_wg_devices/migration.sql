-- WireGuard devices (milestone 9.4): a key per client device instead of one per
-- user.
--
-- Every client of a user held the same AmneziaWG key, so a second client took
-- the endpoint over from the first without a word. A device is a keypair the
-- panel issued; each gets its own address on every WireGuard-family profile
-- (AmneziaWG 1.x and 3.1, plain WireGuard), and the user's peer on a node
-- carries one entry per device.
--
-- wg_devices: one row per device. revoked_at keeps a revoked device on the list
-- after its peers are gone. preshared_key (9.5), bytes_in/bytes_out and
-- last_seen_at (9.6) are added here and filled by those milestones, so the
-- three of them need no migration of their own.
--
-- Backfill, safe for the users that exist: device #1 for EVERY user, soft-deleted
-- ones included, is their CURRENT keypair (users.amneziawg_private_key /
-- amneziawg_public_key), so every config already handed out keeps working with
-- the same key and the same address; the user's amneziawg_peers rows become
-- that device's. Devices #2 and #3 do not exist yet: the panel issues them at
-- the user's next push or subscription render. The key stays on users (nothing
-- reads it afterwards but the way back, and the seed of device 1 for a user
-- created later).
--
-- amneziawg_peers: one address per (profile, device) instead of per (profile,
-- user). The unique constraint (profile_id, user_id) is replaced by
-- (profile_id, device_id); (profile_id, ip) stays. A leftover of the
-- inbound->profile rename, (inbound_id, user_id), is dropped if a database
-- still has it (the history of this repository already drops it).
--
-- WRITTEN BY HAND.
-- Test: src/modules/wg-devices/wg-devices.migration.test.ts (a database with
-- data: device 1 = the old key and address).
--
-- Rollback (devices beyond #1 lose their addresses; #1 keeps the user's key on users):
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
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261126090000_wg_devices';

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

-- Device #1: the user's own key. A public key two users share (never issued by
-- the panel, but the column was not unique) would break the new unique index:
-- only the first of them seeds a device, and the rest get theirs from
-- ensureDevices with a fresh pair when the panel first needs it.
INSERT INTO "wg_devices" ("id", "user_id", "private_key", "public_key", "created_at")
SELECT gen_random_uuid(), s."id", s."amneziawg_private_key", s."amneziawg_public_key", s."created_at"
FROM (
    SELECT u.*, row_number() OVER (PARTITION BY u."amneziawg_public_key" ORDER BY u."created_at", u."id") AS rn
    FROM "users" u
) s
WHERE s.rn = 1;

ALTER TABLE "amneziawg_peers" ADD COLUMN "device_id" UUID;
UPDATE "amneziawg_peers" p SET "device_id" = d."id" FROM "wg_devices" d WHERE d."user_id" = p."user_id";
-- A peer of a user with no device (the shared-key case above) has no key to
-- stand for: its address is freed and issued again with the user's device.
DELETE FROM "amneziawg_peers" WHERE "device_id" IS NULL;
ALTER TABLE "amneziawg_peers" ALTER COLUMN "device_id" SET NOT NULL;
ALTER TABLE "amneziawg_peers" ADD CONSTRAINT "amneziawg_peers_device_id_fkey"
    FOREIGN KEY ("device_id") REFERENCES "wg_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "amneziawg_peers" DROP CONSTRAINT IF EXISTS "amneziawg_peers_profile_id_user_id_key";
DROP INDEX IF EXISTS "amneziawg_peers_profile_id_user_id_key";
DROP INDEX IF EXISTS "amneziawg_peers_inbound_id_user_id_key";
CREATE UNIQUE INDEX "amneziawg_peers_profile_id_device_id_key" ON "amneziawg_peers"("profile_id", "device_id");
CREATE INDEX "amneziawg_peers_device_id_idx" ON "amneziawg_peers"("device_id");
