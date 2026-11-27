import { readIpv6Mode, type Ipv6Mode, type NodeCores } from '@iceslab/shared';
import { prisma } from '../../prisma.js';
import { awgInterfacesInChain } from '../cascades/cascade.service.js';

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
 *   - the interface is not handed to a cascade chain. TEMPORARY, milestone
 *     18.12 lifts it: the chain's TPROXY takes IPv4 only, so a client's IPv6
 *     would leave this node directly, around the cascade.
 *
 * Plain WireGuard is never a cascade entry (CHAIN_ENTRY_PROTOCOLS), so its
 * interface is only held to the first three.
 */
export type TunnelInterface = 'one' | 'three' | 'wg';

export type TunnelIpv6 = Record<TunnelInterface, boolean>;

export const NO_TUNNEL_IPV6: TunnelIpv6 = { one: false, three: false, wg: false };

/** What a node reports and was told, the inputs of the first three conditions. */
export interface TunnelIpv6Facts {
  cores: NodeCores | null | undefined;
  ipv6Mode: Ipv6Mode;
}

export function nodeAgentCarriesTunnelIpv6({ cores, ipv6Mode }: TunnelIpv6Facts): boolean {
  if (ipv6Mode === 'off' || cores?.ipv6?.global !== true) return false;
  return cores.cores.some(
    (c) => c.name === 'amneziawg' && (c.engine === undefined || c.engine === 'amneziawg') && c.awgIpv6 === true,
  );
}

/** Whether `iface` of a node carries IPv6 in the tunnel; `inChain` is what awgInterfacesInChain says. */
export function interfaceCarriesIpv6(
  facts: TunnelIpv6Facts,
  iface: TunnelInterface,
  inChain: { one: boolean; three: boolean },
): boolean {
  if (!nodeAgentCarriesTunnelIpv6(facts)) return false;
  return iface === 'wg' ? true : !inChain[iface];
}

/**
 * The answer for each node, read fresh (the poll writes the facts without any
 * event that busts a cache, and a mode change must show at once). The chain is
 * asked only of a node that passes the facts, so a fleet with no IPv6 agents
 * costs one node read. A node the read does not find: no IPv6.
 */
export async function tunnelIpv6OfNodes(nodeIds: string[]): Promise<Map<string, TunnelIpv6>> {
  const out = new Map<string, TunnelIpv6>();
  if (nodeIds.length === 0) return out;
  const rows = await prisma.node.findMany({
    where: { id: { in: [...new Set(nodeIds)] } },
    select: { id: true, cores: true, ipv6Mode: true },
  });
  for (const n of rows) {
    const facts: TunnelIpv6Facts = { cores: n.cores as NodeCores | null, ipv6Mode: readIpv6Mode(n.ipv6Mode) };
    if (!nodeAgentCarriesTunnelIpv6(facts)) {
      out.set(n.id, NO_TUNNEL_IPV6);
      continue;
    }
    const inChain = await awgInterfacesInChain(n.id);
    out.set(n.id, {
      one: interfaceCarriesIpv6(facts, 'one', inChain),
      three: interfaceCarriesIpv6(facts, 'three', inChain),
      wg: interfaceCarriesIpv6(facts, 'wg', inChain),
    });
  }
  return out;
}

export async function tunnelIpv6OfNode(nodeId: string): Promise<TunnelIpv6> {
  return (await tunnelIpv6OfNodes([nodeId])).get(nodeId) ?? NO_TUNNEL_IPV6;
}
