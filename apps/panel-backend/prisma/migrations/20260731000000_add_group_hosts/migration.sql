-- Which hosts of a squad's profiles that squad actually hands out.
--
-- A squad grants PROFILES, and every host of a granted profile came with it, so
-- "this tier sees two countries, that one sees all" could not be expressed at
-- all. The only workaround was duplicating the profile, which means different
-- REALITY keys and a second inbound on the nodes: solving an access problem by
-- duplicating infrastructure.
--
-- OPT-IN RESTRICTION, the same rule the cascade exit allow-list already uses:
--   no rows for a squad -> it hands out EVERY host of its profiles
--   one or more rows    -> exactly those
--
-- That shape is why this migration needs no backfill: every existing squad has
-- zero rows and keeps behaving exactly as before.
CREATE TABLE "group_hosts" (
    "group_id" UUID NOT NULL,
    "host_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "group_hosts_pkey" PRIMARY KEY ("group_id", "host_id")
);

CREATE INDEX "group_hosts_host_id_idx" ON "group_hosts"("host_id");

ALTER TABLE "group_hosts"
    ADD CONSTRAINT "group_hosts_group_id_fkey"
    FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CASCADE on the host: a deleted host is not a restriction any more, it is
-- gone. Leaving the row would quietly shrink a squad to nothing the day its
-- last selected host is removed.
ALTER TABLE "group_hosts"
    ADD CONSTRAINT "group_hosts_host_id_fkey"
    FOREIGN KEY ("host_id") REFERENCES "hosts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
