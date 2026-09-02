-- Happ is seeded onto the format that was built for it.
--
-- The seed put it on `plain`, a base64 list of URIs that carries no routing
-- section at all. `xrayjson-array` is the format this project ADDED for Happ and
-- V2RayTun — "Happ reads the single-config buildXrayJson as ONE server; this
-- array is N standalone configs it reads as N servers" — and a User-Agent rule
-- is the only mechanism that puts a client on a format, because no client sends
-- `?format=`. So the format built for a named client could not reach it.
--
-- Measured on the live panel 2026-09-01 against `Happ/4.3.0/Android`: 768 bytes,
-- zero geo rules, while Hiddify, v2rayNG and Clash all got theirs. The routing
-- preset an operator sets silently did not apply to Happ users.
--
-- The rule could not be seeded correctly when it was written: `xrayjson-array`
-- was missing from the format enum a rule may select. That was fixed
-- (srr.schemas.ts) and our own database was corrected by hand — a fresh
-- install still starts wrong, which is the half this closes.
--
-- Guarded on the seeded pair, so an operator who has re-pointed this rule keeps
-- their version; `name` is unique, so it touches at most one row.
UPDATE "subscription_response_rules"
   SET "format" = 'xrayjson-array', "updated_at" = CURRENT_TIMESTAMP
 WHERE "name" = 'Happ' AND "format" = 'plain' AND "ua_pattern" = '(?i)happ';
