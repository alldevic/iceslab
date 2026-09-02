-- A User-Agent rule can now say WHICH wg flavour `wgconf` should render.
--
-- The format alone never decided it. Both flavours come out of `wgconf`, and
-- the two files are incompatible: an AmneziaWG config carries the Jc/S/H
-- obfuscation directives, and stock wireguard-tools answers
-- `Line unrecognized: 'Jc = 4'` and then deletes the device. With no flavour to
-- go on, the builder took the FIRST wg endpoint the subscription held.
--
-- So the rule that exists to serve wg clients served one of them wrongly.
-- Measured on the live panel 2026-09-03, against the seeded rule below:
--
--   UA "WireGuard/1.0.16 (Android)"  -> Jc = 4, S1 = 32, H1 = 100, port 1234
--                                      (AmneziaWG; the client refuses the file)
--   ?format=wgconf&proto=wireguard   -> port 51820, no obfuscation
--
-- `?proto=` in the query could always say which. A rule could not — and a real
-- client sends a User-Agent, not a query string, so the query was reachable
-- only by whoever was testing.
ALTER TABLE "subscription_response_rules" ADD COLUMN "proto" VARCHAR(16);

-- Split the one wg rule in two, because one rule cannot name two flavours.
--
-- Amnezia first (priority 55) and narrowed to its own two names: `amneziawg`
-- does not contain `wireguard`, so the order is belt-and-braces rather than
-- load-bearing, and it stays right if either pattern is widened later.
--
-- Guarded on the pattern still being the seeded one, like the case-insensitivity
-- migration before it: an operator who has edited this rule keeps their version,
-- and gets a NULL flavour, which is exactly the behaviour they have today.
UPDATE "subscription_response_rules"
  SET "ua_pattern" = '(?i)amneziavpn|amneziawg',
      "proto" = 'amneziawg',
      "priority" = 55,
      "updated_at" = CURRENT_TIMESTAMP
  WHERE "name" = 'AmneziaWG-app'
    AND "ua_pattern" = '(?i)amneziavpn|amneziawg|wireguard';

-- The stock-WireGuard half. Named clients: the official WireGuard apps
-- (`WireGuard/1.0.16 (Android)`), WireSock, and WG Tunnel — whose UA is
-- `wgtunnel/…` and which matched NO seeded rule at all, so it fell through to
-- the `.*` catch-all and got a base64 URI list. Its own complaint about that is
-- "no PrivateKey", which reads as a broken config rather than a wrong format.
--
-- Inserted only where the split above ran, i.e. where the seeded Amnezia rule
-- is the seeded one. An operator whose rule is hand-written already decides
-- these clients' fate themselves, and a second rule appearing underneath it
-- would change what they configured.
INSERT INTO "subscription_response_rules"
  ("id", "name", "ua_pattern", "format", "proto", "priority", "updated_at")
SELECT gen_random_uuid(), 'WireGuard', '(?i)wireguard|wg-?tunnel|wiresock', 'wgconf', 'wireguard', 60, CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1 FROM "subscription_response_rules"
   WHERE "name" = 'AmneziaWG-app' AND "ua_pattern" = '(?i)amneziavpn|amneziawg'
)
ON CONFLICT ("name") DO NOTHING;
