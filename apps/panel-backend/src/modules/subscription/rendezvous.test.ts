import { describe, expect, it } from 'vitest';
import { rendezvousEpoch, rendezvousOrder, type NodeForRanking } from './node-selection.js';

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

/**
 * F1 — the keyed, rotating variant. What it must add over the plain ordering,
 * and what it must NOT change when it is off.
 *
 * These matter only in combination with the entry-pool cap: the cap turns the
 * order into a per-user SLICE of the fleet, and a slice that anyone can
 * recompute — or that never moves — is not the containment the cap is sold as.
 */
describe('rendezvousOrder keying (F1)', () => {
  const pool: NodeForRanking[] = Array.from({ length: 12 }, (_, i) => ({
    id: `n${i}`,
    name: `n${i}`,
    regionCode: null,
    maxUsers: null,
  }));
  const ids = (ns: NodeForRanking[]) => ns.map((n) => n.id);

  it('changes the order only when keying is actually supplied', () => {
    // The order decides which entry most clients dial by default, so upgrading
    // must not move anyone: with the flag off this file's upstream tests above
    // still pin the unkeyed ordering. What this asserts is the other half —
    // that keying is genuinely applied rather than silently ignored, which a
    // wiring mistake would otherwise leave looking exactly like "off".
    let moved = 0;
    for (const u of ['u1', 'u2', 'user-abc', 'u4', 'u5']) {
      const plain = ids(rendezvousOrder(pool, u));
      const keyed = ids(rendezvousOrder(pool, u, { salt: 'server-secret', epoch: 1 }));
      expect(keyed.slice().sort()).toEqual(plain.slice().sort()); // same nodes…
      if (keyed.join() !== plain.join()) moved += 1; // …different order
    }
    expect(moved).toBe(5);
  });

  it('rotates the order between windows, and holds it inside one', () => {
    const salt = 'server-secret';
    const w1 = ids(rendezvousOrder(pool, 'u1', { salt, epoch: 100 }));
    const w1again = ids(rendezvousOrder(pool, 'u1', { salt, epoch: 100 }));
    const w2 = ids(rendezvousOrder(pool, 'u1', { salt, epoch: 101 }));
    expect(w1again).toEqual(w1); // stable inside a window: no churn per refresh
    expect(w2).not.toEqual(w1); // and it moves to the next one
  });

  it('a different secret gives a different order for the same user', () => {
    // The whole point: userId is disclosed to the client, so without the secret
    // being the thing that decides, a leaked config plus the node list would
    // reproduce every other subscriber's slice.
    const a = ids(rendezvousOrder(pool, 'u1', { salt: 'secret-A', epoch: 7 }));
    const b = ids(rendezvousOrder(pool, 'u1', { salt: 'secret-B', epoch: 7 }));
    expect(b).not.toEqual(a);
  });

  it('rotation actually reaches the whole pool, not a stuck handful', () => {
    // A weak mix makes adjacent epochs land in the same place, so the "rotating"
    // slice keeps serving the same few nodes and the property is cosmetic. Take
    // the top 3 (a realistic entryPoolSize) across 40 windows.
    const seen = new Set<string>();
    for (let epoch = 0; epoch < 40; epoch++) {
      for (const n of rendezvousOrder(pool, 'u1', { salt: 'k', epoch }).slice(0, 3)) {
        seen.add(n.id);
      }
    }
    expect(seen.size).toBe(pool.length);
  });

  it('keyed ordering still spreads users across the pool', () => {
    // Keying must not collapse everyone onto one node: the ordering is still
    // load-spreading, secrecy is added on top of it, not instead.
    const heads = new Map<string, number>();
    for (let i = 0; i < 600; i++) {
      const top = rendezvousOrder(pool, `user-${i}`, { salt: 'k', epoch: 1 })[0]!.id;
      heads.set(top, (heads.get(top) ?? 0) + 1);
    }
    expect(heads.size).toBe(pool.length);
    for (const count of heads.values()) expect(count).toBeGreaterThan(600 / pool.length / 3);
  });
});

describe('rendezvousEpoch', () => {
  it('advances once per window and is stable within it', () => {
    expect(rendezvousEpoch(0, 86400)).toBe(0);
    expect(rendezvousEpoch(86_399_999, 86400)).toBe(0);
    expect(rendezvousEpoch(86_400_000, 86400)).toBe(1);
  });
});
