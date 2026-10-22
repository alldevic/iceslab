import type { Cascade } from '@/lib/domain/cascades';

/**
 * Which other cascade already holds a node, by node id (A-139).
 *
 * The config generator takes the first enabled cascade a node belongs to, so a
 * second one on the same node is written and then silently ignored: worth
 * saying at pick time. The map used to be built from `hops` alone, and a v4
 * cascade (a pooled entry, a transit with several directions, a direction on
 * a named outbound) has `hops: []`, so the warning said nothing for exactly
 * the cascades that need it. Positions and directions first, hops for the
 * cascades stored the old way. `exceptId` leaves out the cascade being edited:
 * its own nodes are not a clash.
 */
export function cascadeClaims(
  cascades: Pick<Cascade, 'id' | 'name' | 'hops' | 'positions' | 'directions'>[],
  exceptId?: string,
): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of cascades) {
    if (c.id === exceptId) continue;
    const claim = (nodeId: string) => {
      if (nodeId && !m.has(nodeId)) m.set(nodeId, c.name);
    };
    for (const p of c.positions) p.nodeIds.forEach(claim);
    for (const d of c.directions) d.nodeIds.forEach(claim);
    for (const h of c.hops) claim(h.nodeId);
  }
  return m;
}
