/**
 * How many node-to-node links a cascade shape needs, and the ceiling on them.
 *
 * Every pair of nodes on adjacent steps is one link with its own listener and
 * its own secret, so pools multiply: two entries in front of three transits is
 * six links before a single direction is counted.
 *
 * It lives here because the server and the cascade editor both need the same
 * number. The editor used to count `entries x directions`, which ignores
 * transits and counts a direction holding four nodes as one: eight entries,
 * eight transits and two directions of eight is 16 by that arithmetic and 192
 * by the server's, so the editor passed shapes the save refused.
 */

/**
 * Ceiling on the total. Not a storage limit: each link is a listener and a
 * credential on a real node, and the fleet has to stay operable.
 */
export const MAX_CASCADE_LINKS = 64;

/** The only part of a step this counter reads. */
export interface CascadeStepNodes {
  nodeIds: readonly (string | null | undefined)[];
}

/**
 * Links needed by `positions` (entry first, then transits, in order) fanning
 * out to `directions`. A direction without nodes costs nothing.
 *
 * Empty ids are not counted: a form draft carries a blank row for the picker
 * the operator has not filled yet, and counting it would make the number jump
 * the moment a row appears.
 */
export function countCascadeLinks(
  positions: readonly CascadeStepNodes[],
  directions: readonly CascadeStepNodes[],
): number {
  const size = (s: CascadeStepNodes): number => s.nodeIds.filter(Boolean).length;

  let total = 0;
  for (let i = 0; i < positions.length - 1; i += 1) {
    total += size(positions[i]!) * size(positions[i + 1]!);
  }
  const last = positions[positions.length - 1];
  if (last) {
    for (const d of directions) total += size(last) * size(d);
  }
  return total;
}
