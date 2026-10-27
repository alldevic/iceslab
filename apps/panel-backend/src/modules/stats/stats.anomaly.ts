/**
 * Node traffic-anomaly sensor.
 *
 * A node going dark (blocked by a censor, crashed, or network-cut) while its
 * agent still answers shows up in the stats poll as a sharp drop in transferred
 * bytes AND in the number of users still moving traffic, sustained across
 * several polls. 20-30 independent clients do not all stop within the same 30s
 * window by coincidence, so a correlated, sustained drop is a strong "node is
 * down/blocked" signal, distinct from one user disconnecting (normal churn) or
 * quiet-hour lulls. A node the panel cannot reach at all is not this sensor's:
 * the status poller already says `unreachable` about it.
 *
 * The decision (evaluateNodeDrop) is pure. NodeAnomalySensor holds the per-node
 * state the decision needs (the smoothed expected-user level and the debounce
 * streak) and says when an incident starts and when it ends; the cron feeds it
 * one observation per node per poll and turns its answer into domain events.
 *
 * Why "expected users" and not "previous poll": an incident is only declared
 * after the drop persists for `debounce` consecutive polls. If breadth were
 * measured against the immediately previous poll, it would be non-zero only on
 * the single transition poll (10→1 users); the next poll sees 1→1 = no drop and
 * the streak resets, so the sensor would never fire. Measuring the shortfall
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
  /** Consecutive anomalous polls required before an incident is declared. */
  debounce: number;
  /** Noise floor: nodes whose baseline is below this (new / near-idle) are
   *  never flagged, there is nothing meaningful to drop from. */
  minBaselineBytes: number;
  /** Per-poll decay of the expected-user high-water mark. <1; closer to 1 keeps
   *  the "expected" level asserted longer through an outage. */
  expectedDecay: number;
}

/** Production defaults. 30s poll interval → debounce 3 ≈ 90s sustained. */
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
  /** Average bytes-per-poll over the recent baseline window (the last 24h). */
  baselinePerPoll: number;
}

export interface NodeDropVerdict {
  /** True when this poll looks anomalous (sustained-ness is the sensor's job). */
  belowThreshold: boolean;
  /** thisPollBytes / baselinePerPoll (1 when no usable baseline). */
  dropRatio: number;
  /** Active-user shortfall vs the expected level (0 when expected unknown). */
  usersDropped: number;
}

/**
 * The expectation to measure THIS poll against.
 *
 * `confirming` means a drop is already being counted towards the debounce. The
 * bar must not move while that count runs: the decay takes 5% off every poll,
 * the debounce wants N polls in a row above `minUsersDrop`, and on a node whose
 * peak is exactly that minimum the two cancel out - round(5*0.95)=5,
 * round(5*0.95^2)=5, round(5*0.95^3)=4, so the streak dies one poll short every
 * time and the sensor cannot fire at all below six concurrent users. Observed
 * on a live node with five.
 *
 * Outside a streak it decays exactly as before, which is what the decay is for:
 * a node that legitimately sheds users should stop being judged against its old
 * peak. A poll that still moves bytes is never below-threshold, so it is never
 * "confirming" and never holds.
 */
export function expectationForPoll(
  prevExpected: number,
  activeUsers: number,
  decay: number,
  confirming: boolean,
): number {
  return confirming
    ? Math.max(prevExpected, activeUsers)
    : updateExpectedActiveUsers(prevExpected, activeUsers, decay);
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
 * corroborated by many users being absent vs. the expected level. Pure - no
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

export type AnomalySeverity = 'warning' | 'critical';

/** Severity for a confirmed anomaly, from how deep the byte drop is. */
export function anomalySeverity(dropRatio: number, cfg: AnomalyConfig): AnomalySeverity {
  return dropRatio < cfg.criticalRatio ? 'critical' : 'warning';
}

/**
 * Why a poll could not be judged. The sensor reads a missing number as "not
 * reported", never as zero: zero is exactly what a dark node looks like.
 *
 *   agent    the agent does not report per-core totals (`cores` in GET /stats
 *            is absent, an agent older than A-152). It cannot say that a core
 *            failed to read its counters, so a missed read and a blackout look
 *            the same in what it sends.
 *   no-data  a core said it could not read its counters this poll (`noData`):
 *            its users are missing from the list for that reason, not because
 *            they left.
 */
export type UnjudgedReason = 'agent' | 'no-data';

export type SensorObservation =
  | { kind: 'unjudged'; reason: UnjudgedReason }
  | {
      kind: 'judged';
      thisPollBytes: number;
      activeUsers: number;
      baselinePerPoll: number;
    };

export interface AnomalyIncident {
  severity: AnomalySeverity;
  bytesThisPoll: number;
  expectedBaseline: number;
  activeUsers: number;
  droppedUsers: number;
}

/**
 * What one observation changed, for the caller to act on:
 *   fired      an incident starts (once per incident)
 *   cleared    the first judged healthy poll after an incident
 *   unjudged   the node moved into "cannot judge" (once per change of reason)
 */
export type SensorOutcome =
  | { kind: 'fired'; incident: AnomalyIncident }
  | { kind: 'cleared' }
  | { kind: 'unjudged'; reason: UnjudgedReason }
  | null;

interface NodeSensorState {
  expected: number;
  streak: number;
  inIncident: boolean;
  unjudged: UnjudgedReason | null;
}

/**
 * Per-node sensor state, in memory. A restart starts every node over: the first
 * polls afterwards only re-learn the expected level and never fire. Each node
 * touches only its own entry, so the parallel poll needs no locking.
 */
export class NodeAnomalySensor {
  private readonly nodes = new Map<string, NodeSensorState>();

  constructor(private readonly cfg: AnomalyConfig = ANOMALY_CONFIG) {}

  observe(nodeId: string, obs: SensorObservation): SensorOutcome {
    const st = this.nodes.get(nodeId) ?? { expected: 0, streak: 0, inIncident: false, unjudged: null };
    this.nodes.set(nodeId, st);

    // Not judged: nothing moves. The streak neither grows (the poll is no
    // evidence of a drop) nor resets (nor of a recovery), and the expected
    // level does not decay on a poll that did not measure anything.
    if (obs.kind === 'unjudged') {
      const changed = st.unjudged !== obs.reason;
      st.unjudged = obs.reason;
      return changed ? { kind: 'unjudged', reason: obs.reason } : null;
    }
    st.unjudged = null;

    // The bar must not move while a drop is being confirmed; see
    // expectationForPoll for what happens when it does.
    st.expected = expectationForPoll(st.expected, obs.activeUsers, this.cfg.expectedDecay, st.streak > 0);
    const verdict = evaluateNodeDrop(
      {
        thisPollBytes: obs.thisPollBytes,
        activeUsers: obs.activeUsers,
        expectedActiveUsers: st.expected,
        baselinePerPoll: obs.baselinePerPoll,
      },
      this.cfg,
    );

    if (!verdict.belowThreshold) {
      st.streak = 0;
      if (st.inIncident) {
        st.inIncident = false;
        return { kind: 'cleared' };
      }
      return null;
    }

    st.streak++;
    if (!st.inIncident && st.streak >= this.cfg.debounce) {
      st.inIncident = true;
      return {
        kind: 'fired',
        incident: {
          severity: anomalySeverity(verdict.dropRatio, this.cfg),
          bytesThisPoll: obs.thisPollBytes,
          expectedBaseline: Math.round(obs.baselinePerPoll),
          activeUsers: obs.activeUsers,
          droppedUsers: verdict.usersDropped,
        },
      };
    }
    return null;
  }

  /** A node that was deleted, or is no longer polled. */
  forget(nodeId: string): void {
    this.nodes.delete(nodeId);
  }
}
