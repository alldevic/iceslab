import { describe, it, expect } from 'vitest';
import {
  evaluateNodeDrop,
  anomalySeverity,
  updateExpectedActiveUsers,
  expectationForPoll,
  NodeAnomalySensor,
  type AnomalyConfig,
  type SensorObservation,
} from './stats.anomaly.js';

const cfg: AnomalyConfig = {
  dropRatio: 0.2,
  criticalRatio: 0.05,
  minUsersDrop: 5,
  debounce: 3,
  minBaselineBytes: 1_000_000,
  expectedDecay: 0.95,
};

describe('evaluateNodeDrop', () => {
  it('flags a deep byte drop corroborated by many users absent vs expected', () => {
    const v = evaluateNodeDrop(
      { thisPollBytes: 10_000, activeUsers: 2, expectedActiveUsers: 30, baselinePerPoll: 5_000_000 },
      cfg,
    );
    expect(v.belowThreshold).toBe(true);
    expect(v.usersDropped).toBe(28);
    expect(v.dropRatio).toBeCloseTo(0.002, 3);
  });

  it('does NOT flag a single user gone (normal churn)', () => {
    const v = evaluateNodeDrop(
      { thisPollBytes: 10_000, activeUsers: 29, expectedActiveUsers: 30, baselinePerPoll: 5_000_000 },
      cfg,
    );
    expect(v.belowThreshold).toBe(false); // shortfall 1 < minUsersDrop
    expect(v.usersDropped).toBe(1);
  });

  it('does NOT flag when bytes are healthy, even with a big user shortfall', () => {
    const v = evaluateNodeDrop(
      { thisPollBytes: 4_000_000, activeUsers: 10, expectedActiveUsers: 30, baselinePerPoll: 5_000_000 },
      cfg,
    );
    expect(v.dropRatio).toBeCloseTo(0.8, 3); // >= dropRatio 0.2
    expect(v.belowThreshold).toBe(false);
  });

  it('ignores nodes with no meaningful baseline (new / near-idle)', () => {
    const v = evaluateNodeDrop(
      { thisPollBytes: 0, activeUsers: 0, expectedActiveUsers: 30, baselinePerPoll: 500_000 },
      cfg,
    );
    expect(v.belowThreshold).toBe(false);
    expect(v.dropRatio).toBe(1);
  });

  it('never fires on the first poll (expected level still 0)', () => {
    const v = evaluateNodeDrop(
      { thisPollBytes: 0, activeUsers: 0, expectedActiveUsers: 0, baselinePerPoll: 5_000_000 },
      cfg,
    );
    expect(v.usersDropped).toBe(0);
    expect(v.belowThreshold).toBe(false);
  });

  it('treats users above expected as zero shortfall (never negative)', () => {
    const v = evaluateNodeDrop(
      { thisPollBytes: 5_000_000, activeUsers: 40, expectedActiveUsers: 30, baselinePerPoll: 5_000_000 },
      cfg,
    );
    expect(v.usersDropped).toBe(0);
  });
});

describe('updateExpectedActiveUsers', () => {
  it('snaps up to the current count immediately', () => {
    expect(updateExpectedActiveUsers(0, 10, 0.95)).toBe(10);
    expect(updateExpectedActiveUsers(5, 12, 0.95)).toBe(12);
  });

  it('decays slowly when the current count drops, keeping the shortfall asserted', () => {
    // 10 users, then a sustained drop to 1: expected stays well above 1 for many
    // polls, so the shortfall keeps tripping the sensor across the debounce window.
    let expected = updateExpectedActiveUsers(0, 10, 0.95); // 10
    const trail: number[] = [];
    for (let i = 0; i < 3; i++) {
      expected = updateExpectedActiveUsers(expected, 1, 0.95);
      trail.push(Math.round(expected - 1)); // shortfall vs the 1 still-active user
    }
    expect(trail.every((s) => s >= 5)).toBe(true); // ≥ minUsersDrop across the window
  });
});

describe('anomalySeverity', () => {
  it('is critical below the critical ratio, warning otherwise', () => {
    expect(anomalySeverity(0.01, cfg)).toBe('critical');
    expect(anomalySeverity(0.15, cfg)).toBe('warning');
  });
});

/**
 * The debounce and the decay used to cancel each other out. This walks the exact
 * sequence a node produces when it goes dark: `debounce` polls in a row have to
 * clear `minUsersDrop`, while the expectation loses 5% every poll. On a node
 * whose peak is exactly the minimum, that is two hits and never three - the
 * sensor cannot fire at all under six concurrent users, at a configured minimum
 * of five. Watched happen on a live node.
 */
describe('the debounce window must be reachable', () => {
  /** Replay N dark polls the way the cron does, and count the streak. */
  function darkPolls(peak: number, polls: number, hold: boolean): number {
    let expected = peak;
    let streak = 0;
    for (let i = 0; i < polls; i++) {
      expected = hold
        ? expectationForPoll(expected, 0, cfg.expectedDecay, streak > 0)
        : updateExpectedActiveUsers(expected, 0, cfg.expectedDecay);
      const verdict = evaluateNodeDrop(
        { thisPollBytes: 0, activeUsers: 0, expectedActiveUsers: expected, baselinePerPoll: 10_000_000 },
        cfg,
      );
      streak = verdict.belowThreshold ? streak + 1 : 0;
    }
    return streak;
  }

  it('reaches the debounce on a node whose peak is exactly minUsersDrop', () => {
    expect(darkPolls(cfg.minUsersDrop, cfg.debounce, true)).toBe(cfg.debounce);
  });

  it('shows the old behaviour it replaces: two hits, then the streak resets', () => {
    expect(darkPolls(cfg.minUsersDrop, cfg.debounce, false)).toBe(0);
  });

  it('still decays outside a streak, so a node that sheds users stops being judged on its peak', () => {
    // Not confirming: the bar drops, which is what lets a genuinely smaller
    // node settle at its new size instead of looking permanently anomalous.
    const once = expectationForPoll(10, 3, cfg.expectedDecay, false);
    expect(once).toBeCloseTo(9.5, 5);
    // Confirming: the bar holds where it was.
    expect(expectationForPoll(10, 0, cfg.expectedDecay, true)).toBe(10);
  });

  it('a recovering poll takes the bar back up even mid-confirmation', () => {
    expect(expectationForPoll(4.75, 7, cfg.expectedDecay, true)).toBe(7);
  });
});

describe('NodeAnomalySensor', () => {
  const healthy: SensorObservation = { kind: 'judged', thisPollBytes: 5_000_000, activeUsers: 10, baselinePerPoll: 5_000_000 };
  const dark: SensorObservation = { kind: 'judged', thisPollBytes: 0, activeUsers: 0, baselinePerPoll: 5_000_000 };

  it('fires once per incident after the debounce, and clears on the first healthy poll', () => {
    const s = new NodeAnomalySensor(cfg);
    expect(s.observe('n', healthy)).toBeNull();
    expect(s.observe('n', dark)).toBeNull();
    expect(s.observe('n', dark)).toBeNull();
    const fired = s.observe('n', dark);
    expect(fired?.kind).toBe('fired');
    expect(fired?.kind === 'fired' && fired.incident).toMatchObject({ severity: 'critical', droppedUsers: 10, activeUsers: 0 });
    expect(s.observe('n', dark)).toBeNull();
    expect(s.observe('n', healthy)).toEqual({ kind: 'cleared' });
    expect(s.observe('n', healthy)).toBeNull();
  });

  // An agent that does not say whether its cores answered must not be read as
  // "all is well", and neither as a blackout: a missed read looks exactly like
  // a node gone dark in what it sends.
  it('a poll it cannot judge neither counts towards an incident nor clears one', () => {
    const s = new NodeAnomalySensor(cfg);
    s.observe('n', healthy);
    s.observe('n', dark);
    s.observe('n', dark);
    expect(s.observe('n', { kind: 'unjudged', reason: 'no-data' })).toEqual({ kind: 'unjudged', reason: 'no-data' });
    expect(s.observe('n', { kind: 'unjudged', reason: 'no-data' })).toBeNull();
    // The streak held at two: the third dark poll is the one that fires.
    expect(s.observe('n', dark)?.kind).toBe('fired');
    s.observe('n', { kind: 'unjudged', reason: 'agent' });
    // Still in the incident: an unjudged poll is no recovery.
    expect(s.observe('n', healthy)).toEqual({ kind: 'cleared' });
  });

  it('an agent that never reports per-core totals never fires', () => {
    const s = new NodeAnomalySensor(cfg);
    const outcomes = Array.from({ length: 10 }, () => s.observe('old', { kind: 'unjudged', reason: 'agent' }));
    expect(outcomes.filter(Boolean)).toEqual([{ kind: 'unjudged', reason: 'agent' }]);
  });

  it('keeps nodes apart', () => {
    const s = new NodeAnomalySensor(cfg);
    s.observe('a', healthy);
    s.observe('b', healthy);
    s.observe('a', dark);
    s.observe('a', dark);
    expect(s.observe('b', dark)).toBeNull();
    expect(s.observe('a', dark)?.kind).toBe('fired');
  });
});
