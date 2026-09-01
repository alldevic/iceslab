-- One WireGuard keypair per DEVICE instead of per user.
--
-- WireGuard identifies a peer by its public key and by nothing else, so a
-- keypair shared by all of a person's devices IS one peer. Three consequences,
-- the first two wanted by the operator and the third one measured live on
-- 2026-08-31: devices cannot be counted, cannot be limited, and the server
-- retargets its return path to whichever device handshaked last - a client
-- that came up second silently took the first one's traffic.
--
-- This migration only moves the MODEL. Every user ends up with exactly one
-- device carrying the key they already hold, so every config already handed
-- out keeps working and nothing has to be re-issued. Handing out more than one
-- device per user is a separate change on top.

CREATE TABLE "wg_devices" (
    "id"          UUID         NOT NULL,
    "user_id"     UUID         NOT NULL,
    "label"       VARCHAR(64),
    "private_key" VARCHAR(64)  NOT NULL,
    "public_key"  VARCHAR(64)  NOT NULL,
    "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at"  TIMESTAMPTZ(6),

    CONSTRAINT "wg_devices_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "wg_devices_user_id_idx" ON "wg_devices"("user_id");

ALTER TABLE "wg_devices"
    ADD CONSTRAINT "wg_devices_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Device #1 for everyone, seeded with the key the user already holds. Includes
-- soft-deleted users on purpose: their peers still reference them until the row
-- is really gone, and a missing device would break the NOT NULL below.
INSERT INTO "wg_devices" ("id", "user_id", "private_key", "public_key", "created_at")
SELECT gen_random_uuid(), u."id", u."amneziawg_private_key", u."amneziawg_public_key", u."created_at"
FROM "users" u;

ALTER TABLE "amneziawg_peers" ADD COLUMN "device_id" UUID;

-- Each existing allocation belongs to that user's only device, so the join
-- cannot be ambiguous at this point in time.
UPDATE "amneziawg_peers" p
SET "device_id" = d."id"
FROM "wg_devices" d
WHERE d."user_id" = p."user_id";

-- Defensive, not expected to match: a peer whose user row is already gone
-- would have no device to point at, and it is dead weight either way.
DELETE FROM "amneziawg_peers" WHERE "device_id" IS NULL;

ALTER TABLE "amneziawg_peers" ALTER COLUMN "device_id" SET NOT NULL;

ALTER TABLE "amneziawg_peers"
    ADD CONSTRAINT "amneziawg_peers_device_id_fkey"
    FOREIGN KEY ("device_id") REFERENCES "wg_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The allocation is per device now. Dropping the old uniqueness is the whole
-- point: (profile, user) is exactly the constraint that made a second device
-- impossible.
-- DROP CONSTRAINT, not DROP INDEX: the old uniqueness was created as a table
-- constraint, and Postgres refuses to drop the index out from under it.
ALTER TABLE "amneziawg_peers" DROP CONSTRAINT IF EXISTS "amneziawg_peers_profile_id_user_id_key";

-- And the same uniqueness AGAIN, under the name it carried before slice 27
-- renamed inbound_id to profile_id. That rename moved the column but left this
-- index standing, so (profile_id, user_id) was enforced TWICE by two objects
-- with different names - and dropping only the constraint above leaves the
-- second one enforcing exactly the rule this migration exists to remove. It
-- costs nothing to find now and would surface as a unique violation on the
-- first buyer who added a second device.
DROP INDEX IF EXISTS "amneziawg_peers_inbound_id_user_id_key";
CREATE UNIQUE INDEX "amneziawg_peers_profile_id_device_id_key" ON "amneziawg_peers"("profile_id", "device_id");
CREATE INDEX "amneziawg_peers_device_id_idx" ON "amneziawg_peers"("device_id");
