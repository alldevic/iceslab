-- A4 ad-split: route-policies. A named policy = direct/block domain lists layered
-- onto a cascade exit at the ENTRY node. Route-profile = (exit) x (plain OR policy).
-- `ordinal` is the vlessRoute tag band (tag = ordinal*256 + exitIndex + 1); ordinal 0
-- is the IMPLICIT plain profile (not stored), so this table holds only extra policies.
CREATE TABLE "route_policies" (
    "id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "direct_domains" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "block_domains" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "route_policies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "route_policies_name_key" ON "route_policies"("name");
CREATE UNIQUE INDEX "route_policies_ordinal_key" ON "route_policies"("ordinal");

-- Per-squad GRANT of an extra route-policy (opt-in). Plain is always available.
CREATE TABLE "group_route_policies" (
    "group_id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    CONSTRAINT "group_route_policies_pkey" PRIMARY KEY ("group_id", "policy_id")
);
CREATE INDEX "group_route_policies_policy_id_idx" ON "group_route_policies"("policy_id");

ALTER TABLE "group_route_policies"
    ADD CONSTRAINT "group_route_policies_group_id_fkey"
    FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "group_route_policies"
    ADD CONSTRAINT "group_route_policies_policy_id_fkey"
    FOREIGN KEY ("policy_id") REFERENCES "route_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the one built-in ad-split policy (ordinal 1). "No ads": block ad/tracker
-- geosites, send Google direct (closes the Э1 "CH без рекламы" criterion). Operators
-- rename / add their own once the policy editor lands (fast-follow).
INSERT INTO "route_policies" ("id", "name", "ordinal", "direct_domains", "block_domains", "updated_at")
VALUES (
    gen_random_uuid(),
    'Без рекламы',
    1,
    ARRAY['geosite:google']::TEXT[],
    ARRAY['geosite:category-ads-all']::TEXT[],
    CURRENT_TIMESTAMP
);
