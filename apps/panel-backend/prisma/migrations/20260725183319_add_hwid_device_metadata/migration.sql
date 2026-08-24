-- Remnawave-compat: client-reported device metadata on HWID rows, captured from
-- the Remnawave subscription-client headers on /sub (x-device-os / x-ver-os /
-- x-device-model / user-agent). All nullable + additive — existing rows read
-- back NULL; non-Remnawave clients simply omit them. Hand-written (additive
-- ADD COLUMN only), matching the repo convention.
ALTER TABLE "hwid_user_devices" ADD COLUMN "platform"     VARCHAR(64);
ALTER TABLE "hwid_user_devices" ADD COLUMN "os_version"   VARCHAR(64);
ALTER TABLE "hwid_user_devices" ADD COLUMN "device_model" VARCHAR(128);
ALTER TABLE "hwid_user_devices" ADD COLUMN "user_agent"   TEXT;
