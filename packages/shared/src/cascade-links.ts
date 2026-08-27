/**
 * How many node-to-node links a cascade shape needs, and the ceiling on them.
 *
 * Every pair of nodes on adjacent steps is one link with its own listener and
 * its own secret, so pools multiply: two entries in front of three transits is
 * six links before a single direction is counted.
 *
 * This lives in `shared` because BOTH sides need the number and they need the
 * same one. Until 2026-08-27 they had two:
 *
 *   - the API counted adjacent positions pairwise and then the last position
 *     against each direction's node count, and refused anything over the cap;
 *   - the cascade forms counted `entries × (number of directions)` — ignoring
 *     transits entirely, and counting a direction holding four nodes as one.
 *
 * The constant was mirrored (the form's copy even said "Mirrors the backend
 * ceiling"); the COUNT was not. So the form showed a number that was not the
 * number, and its gate passed shapes the API then refused: eight entries, eight
 * transits and two directions of eight is 16 by the form's arithmetic and 192
 * by the API's. Both of those shapes became ordinary saves in the v4 storage
 * rewrite, which is when the two formulas stopped agreeing about anything.
 *
 * One implementation, called by both, so there is nothing left to drift.
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
 * out to `directions`.
 *
 * Empty ids are ignored rather than counted, because a form draft carries a
 * blank row for the picker the operator has not filled yet, and counting it
 * would make the number jump the moment a row appears.
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
