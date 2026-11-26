-- What a client says about its device on the request that first brings its
-- HWID to /sub: platform (x-device-os), OS version (x-ver-os), model
-- (x-device-model) and User-Agent. Read by the Remnawave facade's device list.
-- All four are nullable: rows from before this, and clients that send none,
-- read back NULL. Additive, no rewrite.
--
-- WRITTEN BY HAND.
--
-- Rollback:
--   ALTER TABLE "hwid_user_devices" DROP COLUMN "user_agent";
--   ALTER TABLE "hwid_user_devices" DROP COLUMN "device_model";
--   ALTER TABLE "hwid_user_devices" DROP COLUMN "os_version";
--   ALTER TABLE "hwid_user_devices" DROP COLUMN "platform";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261126120000_add_hwid_device_metadata';
ALTER TABLE "hwid_user_devices" ADD COLUMN "platform" VARCHAR(64);
ALTER TABLE "hwid_user_devices" ADD COLUMN "os_version" VARCHAR(64);
ALTER TABLE "hwid_user_devices" ADD COLUMN "device_model" VARCHAR(128);
ALTER TABLE "hwid_user_devices" ADD COLUMN "user_agent" VARCHAR(512);
