-- Per-device traffic counters.
--
-- The node already reports rx/tx per PEER (`awg show <iface> dump`, keyed by
-- public key). Once a key belongs to a device rather than to a person, those
-- numbers are per-device for free - nothing on the client is asked and nothing
-- on the client can lie. This is where they land.
--
-- Lifetime totals on purpose, never reset: the user's quota lives on
-- user_traffic and is reset by its own strategy, while these answer "which
-- device is this and is it still in use" - a question a reset would erase.
ALTER TABLE "wg_devices" ADD COLUMN "bytes_in"  BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "wg_devices" ADD COLUMN "bytes_out" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "wg_devices" ADD COLUMN "last_seen_at" TIMESTAMPTZ(6);
