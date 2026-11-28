import { describe, expect, it } from 'vitest';
import { convertEgressRules, policyName, type ConvertContext } from './egress-convert.js';

const node: ConvertContext = { scope: 'node', warpEnabled: true, directionIdByTag: new Map(), legsToDirection: () => 0 };
const D1 = '72000000-0000-4000-8000-000000000001';
const position = (legs = 1, warpEnabled = true): ConvertContext => ({
  scope: 'position',
  warpEnabled,
  directionIdByTag: new Map([[1, D1]]),
  legsToDirection: () => legs,
});

describe('egress policy of the old fork -> node policy rows', () => {
  it('qualifies bare geosite/geoip names, keeps qualified ones, and says "any of" as one row per kind', () => {
    const r = convertEgressRules([{ geosite: ['category-ru', 'ext:f.dat:c'], geoip: ['ru'], domain: ['domain:a.example'], ip: ['10.0.0.0/8', '2001:db8::/32'], target: 'direct' }], node);
    expect(r.refused).toEqual([]);
    expect(r.rules).toHaveLength(2);
    expect(r.rules[0]).toMatchObject({ matchDomain: ['geosite:category-ru', 'ext:f.dat:c', 'domain:a.example'], matchIp: [], actionKind: 'direct' });
    expect(r.rules[1]).toMatchObject({ matchDomain: [], matchIp: ['geoip:ru', '10.0.0.0/8', '2001:db8::/32'] });
  });

  it('keeps port and network on every row; a rule of a port alone is one row', () => {
    const r = convertEgressRules([{ port: '443', network: 'tcp', target: 'block' }, { geosite: ['a'], geoip: ['b'], port: '80,443', target: 'block' }], node);
    expect(r.rules).toHaveLength(3);
    expect(r.rules[0]).toMatchObject({ matchDomain: [], matchIp: [], matchPort: '443', matchNetwork: 'tcp', actionKind: 'block' });
    expect(r.rules[1]!.matchPort).toBe('80,443');
    expect(r.rules[2]!.matchPort).toBe('80,443');
  });

  it('drops what the old compiler dropped: zapret2 everywhere, link-out and direction on a node, warp without WARP', () => {
    const r = convertEgressRules(
      [{ geosite: ['x'], target: 'zapret2' }, { geosite: ['x'], target: 'link-out' }, { geosite: ['x'], target: 'direction', directionTag: 1 }, { geosite: ['w'], target: 'warp' }, { geosite: ['ok'], target: 'direct' }],
      { ...node, warpEnabled: false },
    );
    expect(r.dropped.map((d) => d.index)).toEqual([0, 1, 2, 3]);
    expect(r.rules).toHaveLength(1);
    expect(r.refused).toEqual([]);
  });

  it('a direction becomes a cascade action on the id of the direction, when the node dials it once', () => {
    const r = convertEgressRules([{ geosite: ['netflix'], target: 'direction', directionTag: 1 }], position(1));
    expect(r.rules).toEqual([expect.objectContaining({ actionKind: 'cascade', actionDirectionId: D1 })]);
    expect(convertEgressRules([{ geosite: ['n'], target: 'direction', directionTag: 1 }], position(0)).dropped[0]!.reason).toMatch(/no link/);
    expect(convertEgressRules([{ geosite: ['n'], target: 'direction', directionTag: 1 }], position(2)).dropped[0]!.reason).toMatch(/2 links/);
    expect(convertEgressRules([{ geosite: ['n'], target: 'direction', directionTag: 9 }], position(1)).dropped[0]!.reason).toMatch(/no direction/);
  });

  it('link-out on a cascade member has no equivalent: the whole policy is refused', () => {
    const r = convertEgressRules([{ geosite: ['a'], target: 'direct' }, { geosite: ['b'], target: 'link-out' }], position());
    expect(r.refused).toEqual([expect.objectContaining({ index: 1 })]);
  });

  it('an entry the new schema refuses refuses the policy, not a part of it', () => {
    const r = convertEgressRules([{ domain: ['10.0.0.1/8'], target: 'direct' }], node);
    expect(r.refused).toHaveLength(1);
    expect(convertEgressRules('nonsense', node).refused).toHaveLength(1);
    expect(convertEgressRules([{ geosite: ['a'], target: 'teleport' }], node).refused).toHaveLength(1);
  });

  it('names the policy fork-<node>, fits 64 characters, never repeats', () => {
    const taken = new Set<string>();
    const a = policyName('entry', taken);
    expect(a).toBe('fork-entry');
    taken.add(a);
    expect(policyName('entry', taken)).toBe('fork-entry-2');
    const long = policyName('x'.repeat(100), new Set());
    expect(long).toHaveLength(64);
    expect(policyName('x'.repeat(100), new Set([long]))).toHaveLength(64);
  });
});
