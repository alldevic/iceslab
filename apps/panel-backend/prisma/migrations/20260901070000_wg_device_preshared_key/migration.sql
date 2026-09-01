-- Preshared key per wg device.
--
-- Nullable and left NULL for existing rows on purpose: the value is only
-- pushed when a profile turns preshared keys on, and filling it here would
-- change nothing while making the migration non-deterministic. The service
-- generates one the first time a device needs it.
ALTER TABLE "wg_devices" ADD COLUMN "preshared_key" VARCHAR(64);
