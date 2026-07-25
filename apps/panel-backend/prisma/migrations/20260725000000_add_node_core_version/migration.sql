-- T7: per-node proxy-core version (e.g. xray "26.3.27"), reported by the agent
-- in /healthz and refreshed by the status poller. NULL until a versioned agent
-- checks in. The panel gates cascade exit selection (vlessRoute) on
-- xray >= 25.9.5 using this. Non-breaking: existing rows stay NULL.
ALTER TABLE "nodes" ADD COLUMN "core_version" VARCHAR(32);
