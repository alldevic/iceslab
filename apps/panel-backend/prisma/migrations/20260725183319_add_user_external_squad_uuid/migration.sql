-- Remnawave-compat: opaque external-squad id, passed through from the shop and
-- echoed back verbatim on the user object. The minishop round-trip-verifies it
-- and rolls back paid activations on mismatch, so the facade must persist +
-- echo it. Not a FK, not validated, not queried — VARCHAR(64), nullable, no
-- index. Additive; existing rows read back NULL. Hand-written per repo convention.
ALTER TABLE "users" ADD COLUMN "external_squad_uuid" VARCHAR(64);
