import { prisma } from '../../prisma.js';
import { getLogger } from '../../lib/infra/logger.js';
import { notifyTelegramAsync, escapeMarkdown } from '../../lib/notify/telegram-notify.js';
import { blindTransitSteps } from './cascade.validation.js';

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

interface OwnershipPair {
  nodeId: string;
  ownerId: string;
  ownerName: string;
  deadId: string;
  deadName: string;
}

/**
 * ONE reading of who holds which node, by the ownership order. The start-up
 * report and deadCascadeIds are two projections of it, so they cannot name
 * different cascades (A-223: AUDT checks that they are one set).
 */
async function ownershipPairs(): Promise<OwnershipPair[]> {
  const cascades = await prisma.cascade.findMany({
    where: { enabled: true },
    orderBy: CASCADE_OWNERSHIP_ORDER,
    select: memberSelect,
  });
  const owner = new Map<string, { id: string; name: string }>();
  const pairs: OwnershipPair[] = [];
  for (const c of cascades) {
    for (const nodeId of membersOf(c)) {
      const held = owner.get(nodeId);
      if (held === undefined) owner.set(nodeId, { id: c.id, name: c.name });
      else pairs.push({ nodeId, ownerId: held.id, ownerName: held.name, deadId: c.id, deadName: c.name });
    }
  }
  return pairs;
}

/**
 * A-223: the enabled cascades that are DEAD, whole: at least one of their nodes
 * is held by an older enabled cascade. Such a cascade is not drawn on that
 * node, and a cascade is a path: its legs end in a node that takes only the
 * owner's legs, so every entry of it leads nowhere. The panel therefore treats
 * it as switched off everywhere it reads cascades: the node's chain
 * (readTopologyForNode), the subscription's lines (getRouteProfilesByEntryNode,
 * getHysteriaEntryLabels), the hidden hops, the entry gate and the users' reach.
 *
 * Cached for a minute and dropped on every cascade change, as the hidden-node
 * set is: the subscription asks on every request.
 */
let deadCache: { ids: Set<string>; expiresAt: number } | null = null;
const DEAD_TTL_MS = 60_000;

export function invalidateDeadCascadeCache(): void {
  deadCache = null;
}

export async function deadCascadeIds(): Promise<Set<string>> {
  if (deadCache && Date.now() < deadCache.expiresAt) return deadCache.ids;
  const ids = new Set((await ownershipPairs()).map((p) => p.deadId));
  deadCache = { ids, expiresAt: Date.now() + DEAD_TTL_MS };
  return ids;
}

/** Uncached, for a save that has to compare before and after its own write. */
export async function deadCascadeIdsNow(): Promise<Set<string>> {
  return new Set((await ownershipPairs()).map((p) => p.deadId));
}

/** The member nodes of the given cascades, for a push to them. */
export async function nodesOfCascades(ids: Iterable<string>): Promise<string[]> {
  const list = [...ids];
  if (list.length === 0) return [];
  const rows = await prisma.cascade.findMany({ where: { id: { in: list } }, select: memberSelect });
  return [...new Set(rows.flatMap((r) => [...membersOf(r)]))];
}

/** Every node stored in more than one enabled cascade, by the ownership order. */
export async function findCascadeNodeConflicts(): Promise<CascadeNodeConflict[]> {
  const pairs = await ownershipPairs();
  if (pairs.length === 0) return [];
  const nodes = await prisma.node.findMany({
    where: { id: { in: [...new Set(pairs.map((p) => p.nodeId))] } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(nodes.map((n) => [n.id, n.name]));
  return pairs.map((p) => ({ nodeName: nameOf.get(p.nodeId) ?? p.nodeId, ownerCascade: p.ownerName, deadCascade: p.deadName }));
}

export interface BlindTransitCascade {
  cascadeName: string;
  transitPosition: number;
  fromPosition: number;
  cell: string;
}

/**
 * A-102: enabled cascades stored before the save refused a step that cannot
 * tell directions apart. Their transit now DROPS what it cannot route; before,
 * it sent every direction out through the first. Same rule as the save
 * (blindTransitSteps), read off the stored positions.
 */
export async function findBlindTransitCascades(): Promise<BlindTransitCascade[]> {
  const rows = await prisma.cascade.findMany({
    where: { enabled: true },
    orderBy: CASCADE_OWNERSHIP_ORDER,
    select: {
      name: true,
      positions: { select: { position: true, linkProtocol: true } },
      _count: { select: { directions: true } },
    },
  });
  return rows.flatMap((c) =>
    blindTransitSteps(c.positions, c._count.directions).map((s) => ({ cascadeName: c.name, ...s })),
  );
}

/** At start, A-102: name those cascades. Nothing is switched off. */
export async function reportBlindTransitCascades(): Promise<BlindTransitCascade[]> {
  const blind = await findBlindTransitCascades();
  if (blind.length === 0) return blind;
  getLogger().warn(
    { blind },
    '[cascades] enabled cascades whose transit cannot tell their directions apart: it now drops their ' +
      'traffic instead of sending every direction out through the first; switch that step to vless',
  );
  notifyTelegramAsync(
    `⚠️ *Cascade transits that drop traffic*\n` +
      blind
        .map(
          (b) =>
            `\`${escapeMarkdown(b.cascadeName)}\`: position ${b.transitPosition} takes a ${escapeMarkdown(b.cell)} ` +
            `leg from position ${b.fromPosition}`,
        )
        .join('\n') +
      `\nThese transits cannot tell the directions apart and drop the traffic. Switch that step to vless.`,
  );
  return blind;
}

/** Everything the start-up check says about stored cascades (A-101, A-223, A-102). */
export async function reportStoredCascadeProblems(): Promise<void> {
  await reportCascadeNodeConflicts();
  await reportBlindTransitCascades();
}

/** At start: name the shared nodes, in the log and to the operator. Nothing is switched off. */
export async function reportCascadeNodeConflicts(): Promise<CascadeNodeConflict[]> {
  const conflicts = await findCascadeNodeConflicts();
  if (conflicts.length === 0) return conflicts;
  getLogger().warn(
    { conflicts },
    '[cascades] nodes in more than one enabled cascade: the oldest cascade holds each; the other is dead ' +
      'as a whole, it runs on none of its nodes and its users get none of its lines in their subscription',
  );
  notifyTelegramAsync(
    `⚠️ *Nodes in two enabled cascades*\n` +
      conflicts
        .map(
          (c) =>
            `\`${escapeMarkdown(c.nodeName)}\`: held by \`${escapeMarkdown(c.ownerCascade)}\`, ` +
            `\`${escapeMarkdown(c.deadCascade)}\` does not run`,
        )
        .join('\n') +
      `\nA dead cascade runs on none of its nodes, and its users get none of its lines in their subscription.`,
  );
  return conflicts;
}
