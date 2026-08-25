-- Give the first batch of seeded User-Agent rules the case-insensitive flag
-- that the second batch has.
--
-- The `Clash` rule proves the defect out of its own contents: it lists `stash`
-- in lower case, plainly in order to catch the Stash client, while `Clash` is
-- capitalised. A case-SENSITIVE regex cannot honour both, and `Stash/2.9.0`
-- does not match it. The rest of that batch (20260505152655) has the same
-- omission; the later batch (20260617020000) wrote every rule with `(?i)` and
-- named the cost of a miss: the client "fell through to the `.*` -> plain
-- catch-all and got a base64 list they can't import".
--
-- Adding the flag only WIDENS what matches, so no client that resolved to its
-- format before can stop doing so. Each statement is guarded on the pattern
-- still being the seeded one, so an operator who has edited a rule keeps their
-- version; `name` is unique, so each touches at most one row.
UPDATE "subscription_response_rules" SET "ua_pattern" = '(?i)hiddify', "updated_at" = CURRENT_TIMESTAMP
  WHERE "name" = 'Hiddify' AND "ua_pattern" = 'Hiddify';

UPDATE "subscription_response_rules" SET "ua_pattern" = '(?i)nekobox|nekoray', "updated_at" = CURRENT_TIMESTAMP
  WHERE "name" = 'NekoBox/NekoRay' AND "ua_pattern" = 'NekoBox|NekoRay';

UPDATE "subscription_response_rules" SET "ua_pattern" = '(?i)sing-box|sfi|sfa|sfm|sft', "updated_at" = CURRENT_TIMESTAMP
  WHERE "name" = 'sing-box' AND "ua_pattern" = 'sing-box|SFI|SFA|SFM|SFT';

UPDATE "subscription_response_rules" SET "ua_pattern" = '(?i)clash|clashx|flclash|stash|mihomo', "updated_at" = CURRENT_TIMESTAMP
  WHERE "name" = 'Clash' AND "ua_pattern" = 'Clash|ClashX|FlClash|stash|mihomo';

UPDATE "subscription_response_rules" SET "ua_pattern" = '(?i)v2rayn|v2rayng', "updated_at" = CURRENT_TIMESTAMP
  WHERE "name" = 'v2rayN' AND "ua_pattern" = 'v2rayN|v2rayNG';
