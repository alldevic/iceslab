import { prisma } from '../../prisma.js';
import { getLogger } from '../../lib/infra/logger.js';
import { notifyTelegramAsync, escapeMarkdown } from '../../lib/notify/telegram-notify.js';

/**
 * A-101: a node is in at most one ENABLED cascade.
 *
 * A node runs one chain process with one config, rendered for one role from
 * one topology (getChainForNode), and two cascades of one shape both want link
 * port 24000 + step and socks 26000 + tag on it. The second cascade on a node
 * was simply not drawn there: its users met a closed port while the panel
 * showed two enabled cascades. Which of the two got the node was a findFirst
 * without an order, so a vacuum could swap them.
 *
 * So the save refuses it (decisions.md, 23.10: carrying several cascades on one
 * node is a feature of its own, after v0.3.0). Pairs stored before this rule
 * stay as they are, nothing is switched off: the OLDEST cascade (createdAt,
 * then id) holds the node, everywhere the panel reads a node's cascade, and
 * the start-up check names every node whose other cascade is dead there.
 */

/** The order that decides which enabled cascade holds a shared node. */
export const CASCADE_OWNERSHIP_ORDER = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];

export class CascadeNodeInOtherCascadeError extends Error {
  readonly code = 'NODE_IN_OTHER_CASCADE';
  constructor(
    public nodeName: string,
    public cascadeId: string,
    public cascadeName: string,
  ) {
    super(
      `Node "${nodeName}" is already in the enabled cascade "${cascadeName}". A node carries one ` +
        `enabled cascade: take it out of that one, or switch that one off, then save again.`,
    );
    this.name = 'CascadeNodeInOtherCascadeError';
  }
}

const memberWhere = (nodeIds: string[]) => ({
  OR: [
    { hops: { some: { nodeId: { in: nodeIds } } } },
    { positions: { some: { nodes: { some: { nodeId: { in: nodeIds } } } } } },
    { directions: { some: { nodes: { some: { nodeId: { in: nodeIds } } } } } },
  ],
});

const memberSelect = {
  id: true,
  name: true,
  hops: { select: { nodeId: true } },
  positions: { select: { nodes: { select: { nodeId: true } } } },
  directions: { select: { nodes: { select: { nodeId: true } } } },
} as const;

function membersOf(c: {
  hops: { nodeId: string }[];
  positions: { nodes: { nodeId: string }[] }[];
  directions: { nodes: { nodeId: string }[] }[];
}): Set<string> {
  return new Set([
    ...c.hops.map((h) => h.nodeId),
    ...c.positions.flatMap((p) => p.nodes.map((n) => n.nodeId)),
    ...c.directions.flatMap((d) => d.nodes.map((n) => n.nodeId)),
  ]);
}

/**
 * Refuses a save that leaves an enabled cascade sharing a node with another
 * enabled one. `selfId` is the cascade being saved (null on a create), left
 * out of the question; a switched-off cascade is not asked about.
 */
export async function assertNodesInNoOtherCascade(selfId: string | null, nodeIds: string[]): Promise<void> {
  if (nodeIds.length === 0) return;
  const others = await prisma.cascade.findMany({
    where: { enabled: true, ...(selfId ? { id: { not: selfId } } : {}), ...memberWhere(nodeIds) },
    orderBy: CASCADE_OWNERSHIP_ORDER,
    select: memberSelect,
  });
  for (const other of others) {
    const shared = nodeIds.find((n) => membersOf(other).has(n));
    if (!shared) continue;
    const node = await prisma.node.findUnique({ where: { id: shared }, select: { name: true } });
    throw new CascadeNodeInOtherCascadeError(node?.name ?? shared, other.id, other.name);
  }
}

export interface CascadeNodeConflict {
  nodeName: string;
  /** The cascade that holds the node: the oldest enabled one. */
  ownerCascade: string;
  /** An enabled cascade that is not drawn on that node. */
  deadCascade: string;
}

/** Every node stored in more than one enabled cascade, by the ownership order. */
export async function findCascadeNodeConflicts(): Promise<CascadeNodeConflict[]> {
  const cascades = await prisma.cascade.findMany({
    where: { enabled: true },
    orderBy: CASCADE_OWNERSHIP_ORDER,
    select: memberSelect,
  });
  const owner = new Map<string, string>();
  const pairs: { nodeId: string; ownerCascade: string; deadCascade: string }[] = [];
  for (const c of cascades) {
    for (const nodeId of membersOf(c)) {
      const held = owner.get(nodeId);
      if (held === undefined) owner.set(nodeId, c.name);
      else pairs.push({ nodeId, ownerCascade: held, deadCascade: c.name });
    }
  }
  if (pairs.length === 0) return [];
  const nodes = await prisma.node.findMany({
    where: { id: { in: [...new Set(pairs.map((p) => p.nodeId))] } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(nodes.map((n) => [n.id, n.name]));
  return pairs.map((p) => ({ nodeName: nameOf.get(p.nodeId) ?? p.nodeId, ownerCascade: p.ownerCascade, deadCascade: p.deadCascade }));
}

/** At start: name the shared nodes, in the log and to the operator. Nothing is switched off. */
export async function reportCascadeNodeConflicts(): Promise<CascadeNodeConflict[]> {
  const conflicts = await findCascadeNodeConflicts();
  if (conflicts.length === 0) return conflicts;
  getLogger().warn(
    { conflicts },
    '[cascades] nodes in more than one enabled cascade: the oldest cascade holds each, the other is not drawn there',
  );
  notifyTelegramAsync(
    `⚠️ *Nodes in two enabled cascades*\n` +
      conflicts
        .map(
          (c) =>
            `\`${escapeMarkdown(c.nodeName)}\`: held by \`${escapeMarkdown(c.ownerCascade)}\`, ` +
            `\`${escapeMarkdown(c.deadCascade)}\` does not run there`,
        )
        .join('\n'),
  );
  return conflicts;
}
