import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../prisma.js';
import type { NodeEgressTune } from '@iceslab/shared';

/**
 * B2b - what has actually worked, grouped by the network it worked on.
 *
 * Self-tune (F3) makes each node answer "which DPI bypass gets through from
 * here" for itself, and reports the answer. On its own that answer dies with
 * the node: a replacement, or a second box on the same uplink, starts from the
 * generic preset and rediscovers it hours later. Grouping the reports by AS is
 * what turns per-node measurement into something the fleet knows, and it is the
 * thing an operator adopts from when they bring up a new box.
 *
 * Grouped by AS rather than by country or provider because the DPI that has to
 * be got past belongs to the network operator: two boxes in the same country on
 * different carriers can need different strategies, while two in the same AS
 * usually do not.
 *
 * The AS label is the F2 pool label (hardening.pool.asn), which is where the
 * fork already records that fact; a node without one groups under "unlabelled",
 * because a strategy that worked somewhere is still worth seeing even when
 * nobody has said where that was.
 */

export const UNLABELLED_AS = 'unlabelled';

export interface CatalogueEntry {
  nodeId: string;
  nodeName: string;
  /** What that node is running, as it reported it. */
  tune: NodeEgressTune;
}

export interface CatalogueGroup {
  /** The AS these nodes are on, or UNLABELLED_AS. */
  asn: string;
  /** Distinct strategies seen on this AS, most recently observed first. */
  strategies: {
    args: string;
    /** Which nodes are on it, so an operator can tell one box's fluke from a
     *  strategy the whole AS agrees on. */
    nodes: CatalogueEntry[];
    /** The most recent observation among those nodes. */
    lastSeen: string;
  }[];
}

export async function egressCatalogue(): Promise<CatalogueGroup[]> {
  const nodes = await prisma.node.findMany({
    // Prisma spells "this jsonb column is not SQL NULL" as DbNull; a plain
    // `not: null` is a different question (JSON null) it refuses to be asked.
    where: { deletedAt: null, NOT: { egressTune: { equals: Prisma.DbNull } } },
    select: { id: true, name: true, hardening: true, egressTune: true },
  });

  const byAsn = new Map<string, Map<string, { nodes: CatalogueEntry[]; lastSeen: string }>>();
  for (const node of nodes) {
    const tune = node.egressTune as NodeEgressTune | null;
    // A report with no strategy is a node saying "nothing here needed one",
    // which is worth knowing but is not a catalogue entry.
    if (!tune?.args) continue;
    const asn =
      (node.hardening as { pool?: { asn?: string } } | null)?.pool?.asn?.trim() || UNLABELLED_AS;

    const strategies = byAsn.get(asn) ?? new Map();
    byAsn.set(asn, strategies);
    const entry = strategies.get(tune.args) ?? { nodes: [], lastSeen: tune.observedAt };
    entry.nodes.push({ nodeId: node.id, nodeName: node.name, tune });
    if (tune.observedAt > entry.lastSeen) entry.lastSeen = tune.observedAt;
    strategies.set(tune.args, entry);
  }

  return [...byAsn.entries()]
    .map(([asn, strategies]) => ({
      asn,
      strategies: [...strategies.entries()]
        .map(([args, e]) => ({ args, nodes: e.nodes, lastSeen: e.lastSeen }))
        // Most recently observed first: on a network whose DPI just changed,
        // the strategy from this morning is the one worth copying, not the one
        // that worked in June.
        .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)),
    }))
    .sort((a, b) => a.asn.localeCompare(b.asn));
}
