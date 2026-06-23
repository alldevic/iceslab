/**
 * U7 — node traffic-anomaly sensor (pure decision core).
 *
 * A node going dark (blocked by a censor, crashed, or network-cut) shows up in
 * the stats poll as a sharp drop in transferred bytes AND in the number of
 * users still moving traffic, sustained across several polls. 20-30 independent
 * clients do not all stop within the same 30s window by coincidence, so a
 * correlated, sustained drop is a strong "node is down/blocked" signal —
 * distinct from one user disconnecting (normal churn) or quiet-hour lulls.
 *
 * This module is the pure, side-effect-free decision. The cron (stats.cron.ts)
 * owns the per-node state (the smoothed expected-user level + the debounce
 * counter) and emits the `node.anomaly` domain event; the hotswap policy /
 * webhooks react to that. Keeping the decision pure makes the threshold logic
 * unit-testable without a DB or a clock.
 *
 * Why "expected users" and not "previous poll": the cron only fires after the
 * drop persists for `debounce` consecutive polls. If breadth were measured
 * against the immediately previous poll, it would be non-zero only on the single
 * transition poll (10→1 users); the next poll sees 1→1 = no drop and the
 * debounce resets, so the sensor would never fire. Measuring the shortfall
 * against a slowly-decaying recent peak keeps the signal asserted across the
 * whole outage, then re-arms when users return.
 */

export interface AnomalyConfig {
  /** Anomalous when thisPollBytes / baselinePerPoll < dropRatio. */
  dropRatio: number;
  /** Severity escalates to 'critical' below this ratio (else 'warning'). */
  criticalRatio: number;
  /** Require the active-user shortfall (expected − current) to be at least this,
   *  so a single disconnect (normal churn) never trips the sensor. */
  minUsersDrop: number;
  /** Consecutive anomalous polls required before the cron fires the event. */
  debounce: number;
  /** Noise floor: nodes whose baseline is below this (new / near-idle) are
   *  never flagged — there is nothing meaningful to drop from. */
  minBaselineBytes: number;
  /** Per-poll decay of the expected-user high-water mark. <1; closer to 1 keeps
   *  the "expected" level asserted longer through an outage. */
  expectedDecay: number;
}

/** Production defaults. ~30s poll interval → debounce 3 ≈ 90s sustained. */
export const ANOMALY_CONFIG: AnomalyConfig = {
  dropRatio: 0.2,
  criticalRatio: 0.05,
  minUsersDrop: 5,
  debounce: 3,
  minBaselineBytes: 1_000_000,
  expectedDecay: 0.95,
};

export interface NodeDropInput {
  /** Bytes transferred on this node in the current poll (down + up). */
  thisPollBytes: number;
  /** Distinct users moving traffic on this node this poll. */
  activeUsers: number;
  /** Smoothed recent peak active-user count (see updateExpectedActiveUsers).
   *  0 on the first poll → no shortfall can be computed → never anomalous. */
  expectedActiveUsers: number;
  /** Average bytes-per-poll over the recent baseline window (e.g. last 24h). */
  baselinePerPoll: number;
}

export interface NodeDropVerdict {
  /** True when this poll looks anomalous (sustained-ness is the cron's job). */
  belowThreshold: boolean;
  /** thisPollBytes / baselinePerPoll (1 when no usable baseline). */
  dropRatio: number;
  /** Active-user shortfall vs the expected level (0 when expected unknown). */
  usersDropped: number;
}

/**
 * Roll the expected active-user level forward: it snaps up to the current count
 * and decays slowly otherwise, so a sustained drop stays "below expected" for
 * many polls while a brief dip is quickly forgiven. Pure.
 */
export function updateExpectedActiveUsers(
  prevExpected: number,
  activeUsers: number,
  decay: number,
): number {
  return Math.max(activeUsers, prevExpected * decay);
}

/**
 * Decide whether one node's current poll is anomalous: a deep byte drop that is
 * corroborated by many users being absent vs. the expected level. Pure — no
 * I/O, no clock.
 */
export function evaluateNodeDrop(input: NodeDropInput, cfg: AnomalyConfig): NodeDropVerdict {
  const { thisPollBytes, activeUsers, expectedActiveUsers, baselinePerPoll } = input;

  // No usable baseline (new or near-idle node): nothing to drop from, and
  // dividing by ~0 would false-fire. Treat as healthy.
  if (baselinePerPoll < cfg.minBaselineBytes) {
    return { belowThreshold: false, dropRatio: 1, usersDropped: 0 };
  }

  const dropRatio = thisPollBytes / baselinePerPoll;
  const usersDropped = Math.max(0, Math.round(expectedActiveUsers - activeUsers));
  const correlated = usersDropped >= cfg.minUsersDrop;
  const belowThreshold = dropRatio < cfg.dropRatio && correlated;

  return { belowThreshold, dropRatio, usersDropped };
}

/** Severity for a confirmed anomaly, from how deep the byte drop is. */
export function anomalySeverity(dropRatio: number, cfg: AnomalyConfig): 'warning' | 'critical' {
  return dropRatio < cfg.criticalRatio ? 'critical' : 'warning';
}
