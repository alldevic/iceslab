-- v2rayN/v2rayNG is seeded onto the format its subscription mechanism can read.
--
-- The seed put it on `xrayjson`, a whole xray config. v2rayNG does not import
-- that from a subscription in any usable way: it lands as a "custom config" —
-- one nameless row showing an address and a port, protocol invisible.
-- Reproduced 2026-09-07 on v2rayNG/2.2.6. Upstream knows: 2dust/v2rayNG#3863
-- (JSON subscription import regressed in 1.9.10–1.9.11, worked to 1.9.9) and
-- #2008 (a subscription may carry ONE json config, never several).
--
-- Our own database was corrected by hand the same day; a fresh install still
-- starts wrong, which is the half this closes — the same shape as the Happ
-- migration of 2026-09-03.
--
-- The cost is recorded rather than hidden: `plain` carries no client-side
-- routing, so the direct-list rules (banks; game services since 2026-09-07) do
-- not reach this client. The RU split and the ad blocking survive, because the
-- node does those.
--
-- Guarded on the seeded pair, so an operator who has re-pointed this rule keeps
-- their version; `name` is unique, so it touches at most one row.
UPDATE "subscription_response_rules"
   SET "format" = 'plain', "updated_at" = CURRENT_TIMESTAMP
 WHERE "name" = 'v2rayN' AND "format" = 'xrayjson' AND "ua_pattern" = '(?i)v2rayn|v2rayng';
