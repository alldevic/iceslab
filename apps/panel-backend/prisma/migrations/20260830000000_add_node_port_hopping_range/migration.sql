-- The Hysteria 2 port-hopping range a node actually REDIRECTS, as its agent
-- reads it out of its own nat table.
--
-- Chosen at install time (--hysteria-port-range, default 20000-50000), so the
-- panel could not know it and accepted any range on a profile - including one
-- the node does not catch, which is a client honestly rotating its destination
-- port across ports nobody is listening on, with nothing anywhere saying so.
--
-- Two columns rather than a json blob because the panel COMPARES them: a
-- profile whose range is not a subset of a bound node's is refused at save
-- time, naming the node. NULL means not reported (no rule, no iptables, or an
-- agent older than the field) - three states none of which is a promise to
-- gate an operator's save on.
ALTER TABLE "nodes" ADD COLUMN "port_hopping_start" INTEGER;
ALTER TABLE "nodes" ADD COLUMN "port_hopping_end" INTEGER;
