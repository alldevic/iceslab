import { describe, it, expect, vi } from 'vitest';
import { rankNodesForUser, type NodeForRanking } from './node-selection.js';

const nodes: NodeForRanking[] = [
  { id: 'a', name: 'a-eu', regionCode: 'EU', currentUsers: 100, maxUsers: 500 },
  { id: 'b', name: 'b-ru', regionCode: 'RU', currentUsers: 50, maxUsers: 500 },
  { id: 'c', name: 'c-eu-full', regionCode: 'EU', currentUsers: 480, maxUsers: 500 },
  { id: 'd', name: 'd-untagged', regionCode: null, currentUsers: 10, maxUsers: 500 },
];

describe('rankNodesForUser', () => {
  it('puts the region match ahead of utilization', () => {
    const top = rankNodesForUser(nodes, 'RU', 1);
    expect(top[0].id).toBe('b');
  });

  it('within same region, less-loaded node wins', () => {
    const top = rankNodesForUser(nodes, 'EU', 2);
    expect(top.map((n) => n.id)).toEqual(['a', 'c']);
  });

  it('with no country, falls back to utilization order', () => {
    const top = rankNodesForUser(nodes, null);
    // Utilization scores: a=40, b=45, c=2, d=49 (out of 50)
    // d > b > a > c
    expect(top[0].id).toBe('d');
    expect(top[top.length - 1].id).toBe('c');
  });

  it('untagged-region nodes still rank by utilization alone', () => {
    const top = rankNodesForUser(nodes, 'EU', 4);
    // a (EU + 80% capacity) → 100 + 40 = 140
    // c (EU + 4% capacity)  → 100 + 2  = 102
    // d (null + 98% cap)    →   0 + 49 = 49
    // b (RU + 90% cap)      →   0 + 45 = 45
    expect(top.map((n) => n.id)).toEqual(['a', 'c', 'd', 'b']);
  });

  it('limit=0 / negative is treated as "no limit"', () => {
    expect(rankNodesForUser(nodes, null, 0).length).toBe(4);
    expect(rankNodesForUser(nodes, null, -5).length).toBe(4);
  });

  it('limit > node count returns all nodes', () => {
    expect(rankNodesForUser(nodes, 'EU', 100).length).toBe(4);
  });

  it('treats missing currentUsers as zero load', () => {
    const minimal: NodeForRanking[] = [
      { id: 'x', name: 'x', regionCode: 'EU' },
      { id: 'y', name: 'y', regionCode: 'EU', currentUsers: 250, maxUsers: 500 },
    ];
    const top = rankNodesForUser(minimal, 'EU', 1);
    expect(top[0].id).toBe('x');
  });
});

describe('lookupClientCountry with the cache unavailable', () => {
  it('answers from the request headers, as it does on a miss', async () => {
    vi.resetModules();
    vi.doMock('../../lib/infra/redis.js', () => ({
      redis: {
        get: vi.fn().mockRejectedValue(new Error('Command timed out')),
        set: vi.fn().mockRejectedValue(new Error('Command timed out')),
      },
    }));
    const { lookupClientCountry } = await import('./node-selection.js');
    await expect(lookupClientCountry('198.51.100.7', { cfCountry: 'de' } as never)).resolves.toBe('DE');
    await expect(lookupClientCountry('198.51.100.7', { cfCountry: 'XX' } as never)).resolves.toBeNull();
    vi.doUnmock('../../lib/infra/redis.js');
    vi.resetModules();
  });
});
