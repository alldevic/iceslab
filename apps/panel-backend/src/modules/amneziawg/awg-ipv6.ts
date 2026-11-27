import { readIpv6Mode, type Ipv6Mode, type NodeCores } from '@iceslab/shared';
import { prisma } from '../../prisma.js';
import { awgInterfacesInChain, getExitNodeIdsByEntryNode } from '../cascades/cascade.service.js';
import { nodeExitsViaIpv6 } from '../nodes/node-core-gate.js';
import { interfaceSubnet64 } from './tunnel-prefix.js';

/**
 * Milestone 18.9: which WireGuard-family interfaces of a node carry IPv6 inside
 * the tunnel. THE one place that decides it, read by the push (the pushed
 * `subnet6` and the peers' IPv6) and by the subscription (the clients' second
 * `Address`), so the node and the client configs cannot disagree.
 *
 * An interface does when ALL hold:
 *   - the agent says it can: the amneziawg core's `awgIpv6` fact (milestone
 *     18.10 makes agents report it; none does before, so nothing changes yet);
 *   - the host has a global IPv6 address (`ipv6.global`);
 *   - the node's IPv6 mode is not `off`;
 *   - the interface is not handed to a cascade chain, OR the chain can carry
 *     it (milestone 18.12): the agent steers IPv6 into the chain too
 *     (`awgTproxy6`) and the cascade's exits have IPv6 (nodeExitsViaIpv6, the
 *     function of 18.7). Without either, a client's IPv6 would leave this node
 *     directly, around the cascade, or lead nowhere, so the interface has none,
 *     and the client has IPv4 alone, as the IPv4 side of the cascade is.
 *
 * Plain WireGuard is never a cascade entry (CHAIN_ENTRY_PROTOCOLS), so its
 * interface is only held to the first three.
 *
 * Milestone 18.11: WHERE the addresses come from. A node may carry a real prefix
 * the provider routes to it (`tunnelIpv6Prefix`). Then an interface that carries
 * IPv6 and whose profile has a `subnet6` (the profile's word that it wants IPv6)
 * is given a /64 of the prefix instead, and its clients leave with their own
 * addresses, no NAT66 (`TunnelIpv6.real`). The /64s go by interface in the fixed
 * order 1.x, 3.1, plain WireGuard, to the ones that qualify; the ones the prefix
 * has no /64 left for (a /64 holds one) stay on the profile's private subnet and
 * NAT66. An agent that does not say `awgNoNat6` (18.10) would NAT a real prefix,
 * so such a node is not given one at all.
 */
export type TunnelInterface = 'one' | 'three' | 'wg';

export interface TunnelIpv6 extends Record<TunnelInterface, boolean> {
  /** 18.11: the /64 of the node's real prefix an interface runs on; absent = the profile's `subnet6`, NAT66. */
  real?: Partial<Record<TunnelInterface, string>>;
}

export const NO_TUNNEL_IPV6: TunnelIpv6 = { one: false, three: false, wg: false };

/** What a node reports and was told, the inputs of the first three conditions. */
export interface TunnelIpv6Facts {
  cores: NodeCores | null | undefined;
  ipv6Mode: Ipv6Mode;
}

/** Whether the agent serves a real prefix with no NAT66 (the `awgNoNat6` fact, 18.11). */
export function nodeAgentServesRealPrefix(cores: NodeCores | null | undefined): boolean {
  return (cores?.cores ?? []).some(
    (c) => c.name === 'amneziawg' && (c.engine === undefined || c.engine === 'amneziawg') && c.awgNoNat6 === true,
  );
}

/**
 * The address plan of one interface, for the three places that use it (the push,
 * the peers' credentials, the client configs): which `subnet6` the addresses are
 * derived in, and whether the interface runs without NAT. Undefined when the
 * interface carries no IPv6 or its profile has no `subnet6`.
 */
export function tunnelAddressing(
  tunnel: TunnelIpv6 | null | undefined,
  iface: TunnelInterface,
  profileSubnet6: string | undefined,
): { subnet6: string; noNat: boolean } | undefined {
  if (!tunnel?.[iface] || !profileSubnet6) return undefined;
  const real = tunnel.real?.[iface];
  return real ? { subnet6: real, noNat: true } : { subnet6: profileSubnet6, noNat: false };
}

/** Whether the agent can steer a client's IPv6 into a chain (the `awgTproxy6` fact, 18.12). */
export function nodeAgentSteersIpv6(cores: NodeCores | null | undefined): boolean {
  return (cores?.cores ?? []).some(
    (c) => c.name === 'amneziawg' && (c.engine === undefined || c.engine === 'amneziawg') && c.awgTproxy6 === true,
  );
}

export function nodeAgentCarriesTunnelIpv6({ cores, ipv6Mode }: TunnelIpv6Facts): boolean {
  if (ipv6Mode === 'off' || cores?.ipv6?.global !== true) return false;
  return cores.cores.some(
    (c) => c.name === 'amneziawg' && (c.engine === undefined || c.engine === 'amneziawg') && c.awgIpv6 === true,
  );
}

/**
 * Whether `iface` of a node carries IPv6 in the tunnel; `inChain` is what
 * awgInterfacesInChain says, `chainCarries` (18.12) that the chain it hands to
 * can carry IPv6: the agent steers it and the exits have it. An interface in a
 * chain that cannot, has none.
 */
export function interfaceCarriesIpv6(
  facts: TunnelIpv6Facts,
  iface: TunnelInterface,
  inChain: { one: boolean; three: boolean },
  chainCarries = false,
): boolean {
  if (!nodeAgentCarriesTunnelIpv6(facts)) return false;
  return iface === 'wg' ? true : !inChain[iface] || chainCarries;
}

/**
 * The answer for each node, read fresh (the poll writes the facts without any
 * event that busts a cache, and a mode change must show at once). The chain is
 * asked only of a node that passes the facts, so a fleet with no IPv6 agents
 * costs one node read. A node the read does not find: no IPv6.
 */
const INTERFACE_ORDER: TunnelInterface[] = ['one', 'three', 'wg'];

/**
 * 18.11: the /64 each interface of a node runs on in its real prefix. The
 * interfaces are the ones the push serves (the last binding by port of each kind,
 * as awgBindingsOfNode and wireguardBindingOfNode pick them) that carry IPv6 and
 * whose profile has a `subnet6`.
 */
async function realSubnets(
  nodeId: string,
  prefix: string,
  carries: Record<TunnelInterface, boolean>,
): Promise<Partial<Record<TunnelInterface, string>>> {
  const rows = await prisma.profileNodeBinding.findMany({
    where: { nodeId, enabled: true, profile: { enabled: true, protocol: { in: ['amneziawg', 'wireguard'] } } },
    orderBy: { port: 'asc' },
    select: { overrides: true, profile: { select: { protocol: true, awgProtocol: true, config: true } } },
  });
  const wants = (r: (typeof rows)[number]) =>
    !!({ ...((r.profile.config ?? {}) as object), ...((r.overrides ?? {}) as object) } as { subnet6?: string }).subnet6;
  const last = (pred: (r: (typeof rows)[number]) => boolean) => rows.filter(pred).at(-1);
  const served: Record<TunnelInterface, (typeof rows)[number] | undefined> = {
    one: last((r) => r.profile.protocol === 'amneziawg' && r.profile.awgProtocol !== 3),
    three: last((r) => r.profile.protocol === 'amneziawg' && r.profile.awgProtocol === 3),
    wg: last((r) => r.profile.protocol === 'wireguard'),
  };
  const out: Partial<Record<TunnelInterface, string>> = {};
  let index = 0;
  for (const iface of INTERFACE_ORDER) {
    const row = served[iface];
    if (!carries[iface] || !row || !wants(row)) continue;
    const subnet = interfaceSubnet64(prefix, index++);
    if (subnet) out[iface] = subnet;
  }
  return out;
}

/**
 * 18.12: whether the chain an entry hands its interface to can carry the
 * clients' IPv6: the node's agent steers it, and at least one exit of its
 * cascades leaves by IPv6 (the rule of 18.7, "at least one exit", read fresh
 * from the exits' rows). An exit that is a named outbound has no node: without.
 */
async function chainCarriesIpv6(entryId: string, cores: NodeCores | null | undefined): Promise<boolean> {
  if (!nodeAgentSteersIpv6(cores)) return false;
  const exits = [...((await getExitNodeIdsByEntryNode([entryId])).get(entryId) ?? [])];
  if (exits.length === 0) return false;
  const rows = await prisma.node.findMany({ where: { id: { in: exits } }, select: { cores: true, ipv6Mode: true } });
  return rows.some((x) => nodeExitsViaIpv6(x.cores as NodeCores | null, readIpv6Mode(x.ipv6Mode)));
}

export async function tunnelIpv6OfNodes(nodeIds: string[]): Promise<Map<string, TunnelIpv6>> {
  const out = new Map<string, TunnelIpv6>();
  if (nodeIds.length === 0) return out;
  const rows = await prisma.node.findMany({
    where: { id: { in: [...new Set(nodeIds)] } },
    select: { id: true, cores: true, ipv6Mode: true, tunnelIpv6Prefix: true },
  });
  for (const n of rows) {
    const facts: TunnelIpv6Facts = { cores: n.cores as NodeCores | null, ipv6Mode: readIpv6Mode(n.ipv6Mode) };
    if (!nodeAgentCarriesTunnelIpv6(facts)) {
      out.set(n.id, NO_TUNNEL_IPV6);
      continue;
    }
    const inChain = await awgInterfacesInChain(n.id);
    const chainCarries = (inChain.one || inChain.three) && (await chainCarriesIpv6(n.id, facts.cores));
    const carries = {
      one: interfaceCarriesIpv6(facts, 'one', inChain, chainCarries),
      three: interfaceCarriesIpv6(facts, 'three', inChain, chainCarries),
      wg: interfaceCarriesIpv6(facts, 'wg', inChain, chainCarries),
    };
    const real =
      n.tunnelIpv6Prefix && nodeAgentServesRealPrefix(facts.cores)
        ? await realSubnets(n.id, n.tunnelIpv6Prefix, carries)
        : {};
    out.set(n.id, Object.keys(real).length > 0 ? { ...carries, real } : carries);
  }
  return out;
}

export async function tunnelIpv6OfNode(nodeId: string): Promise<TunnelIpv6> {
  return (await tunnelIpv6OfNodes([nodeId])).get(nodeId) ?? NO_TUNNEL_IPV6;
}
