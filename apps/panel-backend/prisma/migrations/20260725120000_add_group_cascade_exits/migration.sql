-- A4 increment 2: per-squad cascade-exit allow-list. A row = "group allows its
-- members to use this exit node of this balancer cascade". Opt-in restriction:
-- no rows for a cascade across a user's groups => all exits (back-compat); >=1
-- row => union of allowed exits. Keyed on (cascade, exit_node), not hop id
-- (hops are recreated on every cascade edit; node ids are stable).
CREATE TABLE "group_cascade_exits" (
    "group_id" UUID NOT NULL,
    "cascade_id" UUID NOT NULL,
    "exit_node_id" UUID NOT NULL,
    CONSTRAINT "group_cascade_exits_pkey" PRIMARY KEY ("group_id", "cascade_id", "exit_node_id")
);

CREATE INDEX "group_cascade_exits_cascade_id_idx" ON "group_cascade_exits"("cascade_id");
CREATE INDEX "group_cascade_exits_exit_node_id_idx" ON "group_cascade_exits"("exit_node_id");

ALTER TABLE "group_cascade_exits"
    ADD CONSTRAINT "group_cascade_exits_group_id_fkey"
    FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "group_cascade_exits"
    ADD CONSTRAINT "group_cascade_exits_cascade_id_fkey"
    FOREIGN KEY ("cascade_id") REFERENCES "cascades"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "group_cascade_exits"
    ADD CONSTRAINT "group_cascade_exits_exit_node_id_fkey"
    FOREIGN KEY ("exit_node_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
