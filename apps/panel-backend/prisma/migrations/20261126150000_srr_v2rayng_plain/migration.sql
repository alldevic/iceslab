-- v2rayNG gets plain links, v2rayN keeps xray-json (13.4).
--
-- The seeded rule `v2rayN` (`v2rayN|v2rayNG`, xrayjson) served both clients.
-- The fork measured v2rayNG 2.2.6 (2026-09-07): a whole xray config from a
-- subscription imports as ONE nameless "custom config" entry. Plain links give
-- a list of named servers, at the price of the client-side routing (direct
-- rules do not reach the client; the node still does the RU split and ad
-- blocking). v2rayN (Windows) was not part of that finding and stays as is.
--
-- A rule of its own ahead of v2rayN (priority 49 < 50): the v2rayNG User-Agent
-- contains `v2rayN`. Added only while the v2rayN rule is still exactly as
-- seeded: an operator who edited it (the fork's production was fixed by hand)
-- keeps their rule, and no second one appears beside it.
INSERT INTO "subscription_response_rules"
  ("id", "name", "ua_pattern", "format", "priority", "updated_at")
SELECT gen_random_uuid(), 'v2rayNG', 'v2rayNG', 'plain', 49, CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1 FROM "subscription_response_rules"
   WHERE "name" = 'v2rayN' AND "ua_pattern" = 'v2rayN|v2rayNG' AND "format" = 'xrayjson'
)
ON CONFLICT ("name") DO NOTHING;

-- ROLLBACK (by hand):
--   DELETE FROM "subscription_response_rules" WHERE "name" = 'v2rayNG' AND "format" = 'plain' AND "priority" = 49;
