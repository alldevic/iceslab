-- E: server-side geo split on the cascade entry hop. Additive nullable JSONB
-- column holding an EgressPolicy (validated by EgressPolicySchema); NULL = no
-- split, so existing cascades stay byte-identical.
ALTER TABLE "cascades" ADD COLUMN "egress_policy" JSONB;
