import { describe, expect, it } from 'vitest';
import { computeNodeStatsWrites } from './stats.compute.js';

/**
 * MTProto has two engines and they report opposite shapes, so "presence-only"
 * stopped being a property of the protocol.
 *
 *   mtg           one secret for everybody -> every user reported with ZERO
 *                 bytes, and their presence in the response is the only online
 *                 signal there is.
 *   mtprotoproxy  a secret per user -> real per-user counters.
 *
 * The stats response carries no engine, so the cron decides from the shape of
 * the data (see the comment at its call site). These tests pin what that
 * decision buys, on the helper it feeds.
 *
 * What is NOT at stake here is billing: the flag only reaches users whose delta
 * is zero, and a user with real bytes is billed and dropped from the presence
 * set under either setting. What is at stake is whether somebody who moved
 * nothing is recorded as online.
 */

const base = { multiplier: 1, totalBytesIn: 0, totalBytesOut: 0 };

describe('presence-only is about who is online, not who is billed', () => {
  it('mtg: a zero-byte user is touched as online, because that is all mtg knows', () => {
    const w = computeNodeStatsWrites({
      ...base,
      users: [{ userId: 'u1', bytesIn: 0, bytesOut: 0 }],
      isPresenceOnlyProtocol: true,
    });
    const row = w.userTrafficRows.find((r) => r.userId === 'u1');
    expect(row, 'the only online signal mtg gives was dropped').toBeDefined();
    expect(row!.scaled, 'a presence touch must not bill anything').toBe(0n);
    expect(w.historyRows.find((r) => r.userId === 'u1')).toBeUndefined();
  });

  it('mtprotoproxy: a zero-byte user is NOT touched — the engine can tell', () => {
    // The whole difference. On an engine with real per-user counters, "zero
    // bytes this poll" means they were not active, and recording them online
    // would be inventing a fact the data does not carry.
    const w = computeNodeStatsWrites({
      ...base,
      users: [{ userId: 'u1', bytesIn: 0, bytesOut: 0 }],
      isPresenceOnlyProtocol: false,
    });
    expect(w.userTrafficRows.find((r) => r.userId === 'u1')).toBeUndefined();
  });

  it('a user with real bytes is billed identically under either setting', () => {
    // Stated because it is what makes the flag safe to get wrong in one
    // direction: this change cannot move anybody's bill.
    const users = [{ userId: 'u1', bytesIn: 1000, bytesOut: 2000 }];
    const on = computeNodeStatsWrites({ ...base, users, isPresenceOnlyProtocol: true });
    const off = computeNodeStatsWrites({ ...base, users, isPresenceOnlyProtocol: false });
    expect(on.userTrafficRows).toEqual(off.userTrafficRows);
    expect(on.historyRows).toEqual(off.historyRows);
  });

  it('one active and one idle user on mtprotoproxy: only the active one appears', () => {
    const w = computeNodeStatsWrites({
      ...base,
      users: [
        { userId: 'active', bytesIn: 10, bytesOut: 20 },
        { userId: 'idle', bytesIn: 0, bytesOut: 0 },
      ],
      isPresenceOnlyProtocol: false,
    });
    expect(w.userTrafficRows.map((r) => r.userId)).toEqual(['active']);
  });

  it('the same pair on mtg: the idle one is still an online touch', () => {
    const w = computeNodeStatsWrites({
      ...base,
      users: [
        { userId: 'active', bytesIn: 10, bytesOut: 20 },
        { userId: 'idle', bytesIn: 0, bytesOut: 0 },
      ],
      isPresenceOnlyProtocol: true,
    });
    expect(w.userTrafficRows.map((r) => r.userId).sort()).toEqual(['active', 'idle']);
    expect(w.userTrafficRows.find((r) => r.userId === 'idle')!.scaled).toBe(0n);
  });
});
