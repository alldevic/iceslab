-- 18.6: the operator's IPv6 setting of a node: 'auto' (the agent's own check),
-- 'on', 'off'. Every existing node stays on 'auto', which goes to the agent as
-- no field at all, so nothing changes until someone chooses.
ALTER TABLE "nodes" ADD COLUMN "ipv6_mode" VARCHAR(8) NOT NULL DEFAULT 'auto';
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_ipv6_mode_check" CHECK ("ipv6_mode" IN ('auto', 'on', 'off'));
