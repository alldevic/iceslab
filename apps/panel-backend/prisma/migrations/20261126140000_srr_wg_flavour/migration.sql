-- A User-Agent rule can now say WHICH wg flavour `wgconf` renders (12.4).
--
-- Both flavours come out of `wgconf` and the files are incompatible: an
-- AmneziaWG config carries the Jc/S/H obfuscation directives, and stock
-- wireguard-tools answers `Line unrecognized: 'Jc = 4'`. The seeded rule
-- `(?i)amneziavpn|amneziawg|wireguard` sent a stock client to either.
ALTER TABLE "subscription_response_rules" ADD COLUMN "proto" VARCHAR(16);

-- Split the one wg rule in two, because one rule cannot name two flavours.
-- Guarded on the pattern still being the seeded one: an operator who edited
-- this rule keeps their version, with a NULL flavour (the behaviour they have).
UPDATE "subscription_response_rules"
  SET "ua_pattern" = '(?i)amneziavpn|amneziawg',
      "proto" = 'amneziawg',
      "updated_at" = CURRENT_TIMESTAMP
  WHERE "name" = 'AmneziaWG-app'
    AND "ua_pattern" = '(?i)amneziavpn|amneziawg|wireguard'
    AND "format" = 'wgconf';

-- The stock-WireGuard half: the official apps, WG Tunnel and WireSock. Added
-- only where the split above ran; an operator whose rule is their own decides
-- these clients' fate themselves, and a second rule would change that.
INSERT INTO "subscription_response_rules"
  ("id", "name", "ua_pattern", "format", "proto", "priority", "updated_at")
SELECT gen_random_uuid(), 'WireGuard', '(?i)wireguard|wg-?tunnel|wiresock', 'wgconf', 'wireguard', 65, CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1 FROM "subscription_response_rules"
   WHERE "name" = 'AmneziaWG-app' AND "ua_pattern" = '(?i)amneziavpn|amneziawg' AND "proto" = 'amneziawg'
)
ON CONFLICT ("name") DO NOTHING;

-- ROLLBACK (by hand):
--   DELETE FROM "subscription_response_rules" WHERE "name" = 'WireGuard' AND "proto" = 'wireguard';
--   UPDATE "subscription_response_rules" SET "ua_pattern" = '(?i)amneziavpn|amneziawg|wireguard'
--     WHERE "name" = 'AmneziaWG-app' AND "proto" = 'amneziawg';
--   ALTER TABLE "subscription_response_rules" DROP COLUMN "proto";
