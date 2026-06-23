import type { BurnedNode, SpareNode } from './pool.types.js';

// F2 — pure spare-selection policy. Pick a replacement that is DIVERSE from the
// burned node (don't burn a neighbouring subnet — the same AS is likely under
// the same block), keeps geo continuity, and is cheap + lightly loaded.

/** Penalty weights — higher = stronger avoidance. Tuned so AS-diversity
 *  dominates (the anti-correlation goal), then provider, then cost/load. */
const SAME_ASN_PENALTY = 1000;
const SAME_PROVIDER_PENALTY = 100;
const SAME_COUNTRY_BONUS = 50;
const COST_WEIGHT = 10;

/**
 * Score a spare against the burned node. Higher = better. Pure.
 *
 * - Same AS as burned → heavy penalty (defeats the anti-correlation purpose:
 *   the replacement would likely be blocked by the same rule).
 * - Same provider → lighter penalty (correlated but less than AS).
 * - Same country → small bonus (keep users' expected geo / latency).
 * - Cost: cheaper (lower consumptionMultiplier) scores higher.
 * - Load: lighter scores higher.
 */
export function scoreSpare(spare: SpareNode, burned: BurnedNode): number {
  let score = 0;
  if (spare.asn !== null && burned.asn !== null && spare.asn === burned.asn) {
    score -= SAME_ASN_PENALTY;
  } else if (
    spare.provider !== null &&
    burned.provider !== null &&
    spare.provider === burned.provider
  ) {
    score -= SAME_PROVIDER_PENALTY;
  }
  if (
    spare.countryCode !== null &&
    burned.countryCode !== null &&
    spare.countryCode === burned.countryCode
  ) {
    score += SAME_COUNTRY_BONUS;
  }
  score -= (spare.consumptionMultiplier || 1) * COST_WEIGHT;
  score -= spare.load ?? 0;
  return score;
}

/**
 * Pick the best spare for the burned node, or null if the pool is empty.
 * Deterministic: ties (equal score) break by id so the choice is reproducible.
 * Pure — caller supplies the cold-pool list (DB query is deferred).
 */
export function pickSpare(spares: SpareNode[], burned: BurnedNode): SpareNode | null {
  let best: SpareNode | null = null;
  let bestScore = -Infinity;
  for (const spare of spares) {
    const s = scoreSpare(spare, burned);
    if (s > bestScore || (s === bestScore && best !== null && spare.id < best.id)) {
      best = spare;
      bestScore = s;
    }
  }
  return best;
}

/** Rank all spares best-first (stable, deterministic). Useful for diagnostics
 *  and for picking the next candidate if a promote fails. */
export function rankSpares(spares: SpareNode[], burned: BurnedNode): SpareNode[] {
  return [...spares].sort((a, b) => {
    const d = scoreSpare(b, burned) - scoreSpare(a, burned);
    return d !== 0 ? d : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
