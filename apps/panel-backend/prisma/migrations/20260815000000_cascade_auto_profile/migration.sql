-- The "Auto" line in a subscription: one profile that picks no direction and
-- lets the entry choose the fastest exit by measured RTT.
--
-- Default false on purpose. Turning it on adds a row to every subscriber's
-- server list, and that is the operator's call to make, not an update's.
ALTER TABLE "cascades" ADD COLUMN "auto_profile" BOOLEAN NOT NULL DEFAULT false;
