import { readIpv6Mode, type NodeCores } from '@iceslab/shared';
import { prisma } from '../../prisma.js';
import { getExitNodeIdsByEntryNode } from '../cascades/cascade.service.js';
import { nodeExitsViaIpv6 } from '../nodes/node-core-gate.js';
import type { SubscriptionEndpoint } from './subscription.formats.js';

/**
 * 18.7: sets `exitHasIpv6` on the points of a document, the source of
 * exitsHaveIpv6 (subscription.address-family.ts).
 *
 * A point that is the entry of a cascade (`chained`: it hands its users to the
 * chain, so they leave by the cascade's exits) takes the fact of those exits,
 * not of its own node; any other point takes its own node's. The facts are read
 * here, fresh, AFTER the cached binding set: the poll writes a node's IPv6 block
 * without any event that busts that cache, and a mode change must show at once.
 * A node the read does not find, a named outbound, an unknown fact: no IPv6.
 */
export async function markExitsIpv6(
  endpoints: SubscriptionEndpoint[],
  chained: (e: SubscriptionEndpoint) => boolean,
): Promise<void> {
  if (endpoints.length === 0) return;
  const chainedEntries = [...new Set(endpoints.filter(chained).map((e) => e.nodeId))];
  const exitsOf = await getExitNodeIdsByEntryNode(chainedEntries);
  const ids = new Set(endpoints.map((e) => e.nodeId));
  for (const set of exitsOf.values()) for (const id of set) ids.add(id);
  const rows = await prisma.node.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, cores: true, ipv6Mode: true },
  });
  const has = new Map(
    rows.map((n) => [n.id, nodeExitsViaIpv6(n.cores as NodeCores | null, readIpv6Mode(n.ipv6Mode))]),
  );
  for (const e of endpoints) {
    const ids = chained(e) ? [...(exitsOf.get(e.nodeId) ?? [])] : [e.nodeId];
    if (ids.some((id) => has.get(id) === true)) e.exitHasIpv6 = true;
  }
}
