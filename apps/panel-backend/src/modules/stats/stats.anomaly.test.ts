import { describe, it, expect } from 'vitest';
import {
  evaluateNodeDrop,
  anomalySeverity,
  updateExpectedActiveUsers,
  type AnomalyConfig,
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
