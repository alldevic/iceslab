import { describe, expect, it } from 'vitest';
import { rendezvousOrder, type NodeForRanking } from './node-selection.js';

const node = (id: string, maxUsers = 500): NodeForRanking => ({
  id,
  name: id,
  regionCode: null,
  maxUsers,
});

const users = (n: number): string[] => Array.from({ length: n }, (_, i) => `user-${i}`);

describe('rendezvousOrder', () => {
  // The property the operator was promised: a subscription refresh must not
  // move anyone. On their product (routers) a move drops live connections.
  it('gives a user the same node on every call while the pool is unchanged', () => {
    const pool = [node('a'), node('b'), node('c')];
    for (const u of users(50)) {
      const first = rendezvousOrder(pool, u)[0]!.id;
      expect(rendezvousOrder(pool, u)[0]!.id).toBe(first);
      // Order of the pool itself must not matter either: the panel does not
      // guarantee a stable query order.
      expect(rendezvousOrder([...pool].reverse(), u)[0]!.id).toBe(first);
    }
  });

  // Plain "sort by score" handed everyone the same node, which is what made a
  // pool decorative. Spread is the reason to have one at all.
  it('spreads users across an equal-weight pool', () => {
    const pool = [node('a'), node('b'), node('c')];
    const counts = new Map<string, number>();
    for (const u of users(300)) {
      const top = rendezvousOrder(pool, u)[0]!.id;
      counts.set(top, (counts.get(top) ?? 0) + 1);
    }
    expect(counts.size).toBe(3);
    // Hashing is not a perfect divider; assert every node carries a real share
    // rather than an exact third.
    for (const c of counts.values()) expect(c).toBeGreaterThan(300 / 3 / 2);
  });

  // maxUsers is the capacity hint we already have; a second "weight" column
  // would only create ambiguity about which one wins.
  it('gives a node with twice the capacity roughly twice the share', () => {
    const pool = [node('small', 500), node('big', 1000)];
    let big = 0;
    const total = 600;
    for (const u of users(total)) {
      if (rendezvousOrder(pool, u)[0]!.id === 'big') big++;
    }
    // Expected 2/3. Wide band: this asserts the weighting works at all, not
    // that the hash is perfectly uniform.
    expect(big / total).toBeGreaterThan(0.55);
    expect(big / total).toBeLessThan(0.8);
  });

  // The reason to use HRW rather than random-with-a-seed: losing a node must
  // not reshuffle everyone else. That is what keeps a node failure from
  // becoming a fleet-wide reconnect storm.
  it('moves only the users of a node that disappears', () => {
    const full = [node('a'), node('b'), node('c')];
    const reduced = [node('a'), node('b')];
    let movedAwayFromSurvivors = 0;
    for (const u of users(300)) {
      const before = rendezvousOrder(full, u)[0]!.id;
      const after = rendezvousOrder(reduced, u)[0]!.id;
      if (before !== 'c' && before !== after) movedAwayFromSurvivors++;
    }
    expect(movedAwayFromSurvivors).toBe(0);
  });

  it('returns every node, so callers can take a live prefix', () => {
    const pool = [node('a'), node('b'), node('c'), node('d')];
    expect(rendezvousOrder(pool, 'user-1')).toHaveLength(4);
  });
});
