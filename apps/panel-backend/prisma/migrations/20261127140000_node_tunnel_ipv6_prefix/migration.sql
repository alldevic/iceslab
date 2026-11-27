-- 18.11: the real IPv6 prefix routed to a node, for the WireGuard-family tunnel. NULL
-- (every existing node) keeps the private subnet and NAT66 of 18.10.
ALTER TABLE "nodes" ADD COLUMN "tunnel_ipv6_prefix" VARCHAR(43);
