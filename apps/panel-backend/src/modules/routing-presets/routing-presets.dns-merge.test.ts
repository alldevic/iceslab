import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_NODE_RESOLVERS } from '@iceslab/shared';
import {
  allDnsConflicts,
  carriesRule,
  findDnsConflict,
  mergeNodeDns,
  nodeDnsServerCount,
  normalizeDnsName,
  normalizeDnsServer,
  resolveDnsConflicts,
  type NamedDnsSource,
} from './routing-presets.dns-merge.js';

const src = (presetId: string | null, name: string, ...rules: [string[], string][]): NamedDnsSource => ({
  presetId,
  name,
  rules: rules.map(([match, server]) => ({ match, server })),
});

describe('what a node carries', () => {
  it('runs UDP, TCP and DoH and not DoT (xray has none, m19-01)', () => {
    expect(carriesRule({ server: '10.99.0.1' })).toBe(true);
    expect(carriesRule({ server: 'tcp://10.99.0.1:5353' })).toBe(true);
    expect(carriesRule({ server: 'https://dns.example/dns-query' })).toBe(true);
    expect(carriesRule({ server: 'tls://dns.example' })).toBe(false);
    expect(carriesRule({ server: 'not a server' })).toBe(false);
  });
});

describe('names and servers compared in one spelling', () => {
  it('a bare name is domain:NAME, case folded; full: and geosite: stay apart', () => {
    expect(normalizeDnsName('Example.com')).toBe('domain:example.com');
    expect(normalizeDnsName('domain:example.com')).toBe('domain:example.com');
    expect(normalizeDnsName('full:example.com')).toBe('full:example.com');
    expect(normalizeDnsName('geosite:google')).toBe('geosite:google');
  });
  it('an IP and the same IP with the default port are one server', () => {
    expect(normalizeDnsServer('10.0.0.1')).toBe(normalizeDnsServer('10.0.0.1'));
    expect(normalizeDnsServer('https://DNS.example/dns-query')).toBe(normalizeDnsServer('https://dns.example:443/dns-query'));
    expect(normalizeDnsServer('tcp://10.0.0.1')).not.toBe(normalizeDnsServer('10.0.0.1'));
  });
});

describe('findDnsConflict', () => {
  it('names two presets that give one name two servers', () => {
    const c = findDnsConflict([src('a', 'A', [['example.com'], '10.0.0.1']), src('b', 'B', [['domain:example.com'], '10.0.0.2'])]);
    expect(c).toMatchObject({ domain: 'example.com', a: { name: 'A', server: '10.0.0.1' }, b: { name: 'B', server: '10.0.0.2' } });
  });
  it('is not a conflict when the servers are the same, or the names differ', () => {
    expect(findDnsConflict([src('a', 'A', [['example.com'], '10.0.0.1']), src('b', 'B', [['domain:example.com'], '10.0.0.1:53'])])).toBeNull();
    expect(findDnsConflict([src('a', 'A', [['example.com'], '10.0.0.1']), src('b', 'B', [['full:example.com'], '10.0.0.2'])])).toBeNull();
  });
  it('geosite: meets only the same tag, never a single name', () => {
    expect(findDnsConflict([src('a', 'A', [['geosite:google'], '10.0.0.1']), src('b', 'B', [['google.com'], '10.0.0.2'])])).toBeNull();
    expect(findDnsConflict([src('a', 'A', [['geosite:google'], '10.0.0.1']), src('b', 'B', [['geosite:google'], '10.0.0.2'])])).not.toBeNull();
  });
  it('one source repeating a name is its own business (the first rule wins)', () => {
    expect(findDnsConflict([src('a', 'A', [['x.com'], '10.0.0.1'], [['x.com'], '10.0.0.2'])])).toBeNull();
  });
  it('a rule the node does not run is no conflict', () => {
    expect(findDnsConflict([src('a', 'A', [['x.com'], '10.0.0.1']), src('b', 'B', [['x.com'], 'tls://dns.example'])])).toBeNull();
  });
  it('the panel-wide rules are a source like a preset; focus keeps a save to the disagreements it makes', () => {
    const a = src('a', 'A', [['x.com'], '10.0.0.1']);
    const b = src('b', 'B', [['x.com'], '10.0.0.2']);
    const panel = src(null, 'panel', [['x.com'], '10.0.0.3']);
    expect(findDnsConflict([a, panel])).toMatchObject({ b: { presetId: null } });
    expect(findDnsConflict([a, b, panel], { presetId: 'c' })).toBeNull();
    expect(findDnsConflict([a, b], { presetId: 'a' })).not.toBeNull();
    expect(findDnsConflict([a, b, src('c', 'C', [['y.com'], '10.0.0.4'])], { presetId: 'c' })).toBeNull();
  });
});

describe('findDnsConflict with the conflicts that were already there (19.15)', () => {
  const a = src('a', 'A', [['x.com'], '10.0.0.1']);
  const b = src('b', 'B', [['x.com'], '10.0.0.2']);
  const known = (...sources: NamedDnsSource[]) => new Set(allDnsConflicts(sources).map((c) => c.key));

  it('a pair that was there before does not stop a save', () => {
    expect(findDnsConflict([a, b], { presetId: 'a' }, known(a, b))).toBeNull();
  });
  it('the key does not depend on which side came first', () => {
    expect(findDnsConflict([b, a], { presetId: 'a' }, known(a, b))).toBeNull();
  });
  it('the same name with another server is a new conflict', () => {
    const a2 = src('a', 'A', [['x.com'], '10.0.0.9']);
    expect(findDnsConflict([a2, b], { presetId: 'a' }, known(a, b))).toMatchObject({ a: { server: '10.0.0.9' }, b: { server: '10.0.0.2' } });
  });
  it('a pair with a third source is new, an old one next to it stays quiet', () => {
    const c = src('c', 'C', [['x.com'], '10.0.0.3']);
    expect(findDnsConflict([a, b, c], { presetId: 'c' }, known(a, b))).toMatchObject({ b: { presetId: 'c' } });
    expect(findDnsConflict([a, b, c], { presetId: 'a' }, known(a, b))).toMatchObject({ a: { presetId: 'a' }, b: { presetId: 'c' } });
  });
  it('another name of the same pair is new', () => {
    const a2 = src('a', 'A', [['x.com'], '10.0.0.1'], [['y.com'], '10.0.0.1']);
    const b2 = src('b', 'B', [['x.com'], '10.0.0.2'], [['y.com'], '10.0.0.2']);
    expect(findDnsConflict([a2, b2], { presetId: 'a' }, known(a, b))).toMatchObject({ domain: 'y.com' });
  });
  it('without known, the first conflict is found as before', () => {
    expect(allDnsConflicts([a, b]).map((c) => c.domain)).toEqual(['x.com']);
    expect(findDnsConflict([a, b], { presetId: 'a' })).not.toBeNull();
  });
});

const DEFAULTS = DEFAULT_NODE_RESOLVERS.map((address) => ({ address }));

describe('mergeNodeDns', () => {
  const manual = { servers: [{ address: '77.88.8.8', domains: ['geosite:category-ru'], skipFallback: true }, { address: '8.8.8.8' }], queryStrategy: 'UseIPv4' as const };

  it('gives the manual dns back untouched when nothing is carried', () => {
    expect(mergeNodeDns(manual, null)).toBe(manual);
    expect(mergeNodeDns(manual, [])).toBe(manual);
    expect(mergeNodeDns(null, null)).toBeUndefined();
    expect(mergeNodeDns(null, [{ presetId: 'a', rules: [{ match: ['x.com'], server: 'tls://dns.example' }] }])).toBeUndefined();
  });

  it('puts the manual servers first, then one skipFallback server per carried server, names in xray spelling', () => {
    const out = mergeNodeDns(manual, [
      { presetId: 'a', rules: [{ match: ['example.com', 'geosite:google'], server: '10.0.0.1' }] },
      { presetId: null, rules: [{ match: ['full:b.com'], server: '10.0.0.1' }, { match: ['c.com'], server: 'tcp://10.0.0.2:5353' }, { match: ['d.com'], server: 'tls://x.example' }] },
    ]);
    expect(out).toEqual({
      queryStrategy: 'UseIPv4',
      servers: [
        ...manual.servers,
        { address: '10.0.0.1', domains: ['domain:example.com', 'geosite:google', 'full:b.com'], skipFallback: true },
        { address: 'tcp://10.0.0.2:5353', domains: ['domain:c.com'], skipFallback: true },
      ],
    });
    expect(manual.servers).toHaveLength(2);
  });

  it('with no manual dns, the carried servers alone', () => {
    expect(mergeNodeDns(null, [{ presetId: 'a', rules: [{ match: ['x.com'], server: 'https://dns.example/dns-query' }] }])).toEqual({
      queryStrategy: 'UseIPv4',
      servers: [...DEFAULTS, { address: 'https://dns.example/dns-query', domains: ['domain:x.com'], skipFallback: true }],
    });
  });

  it('with no manual dns the agent\'s default resolvers stay as general servers, ahead of the carried ones', () => {
    const rules = [{ presetId: 'a', rules: [{ match: ['x.com'], server: '10.0.0.1' }] }];
    const out = mergeNodeDns(undefined, rules);
    expect(out?.servers.slice(0, 3)).toEqual([{ address: '1.1.1.1' }, { address: '8.8.8.8' }, { address: 'localhost' }]);
    expect(mergeNodeDns({ servers: [] }, rules)?.servers).toHaveLength(4);
    expect(nodeDnsServerCount(null, rules)).toBe(1);
  });

  it('the default section gets the queryStrategy the agent would give: UseIP out by IPv6, else UseIPv4; a manual dns keeps its own', () => {
    const rules = [{ presetId: 'a', rules: [{ match: ['x.com'], server: '10.0.0.1' }] }];
    expect(mergeNodeDns(null, rules)?.queryStrategy).toBe('UseIPv4');
    expect(mergeNodeDns(null, rules, false)?.queryStrategy).toBe('UseIPv4');
    expect(mergeNodeDns(null, rules, true)?.queryStrategy).toBe('UseIP');
    expect(mergeNodeDns({ servers: [{ address: '9.9.9.9' }] }, rules, true)).not.toHaveProperty('queryStrategy');
    expect(mergeNodeDns({ servers: [{ address: '9.9.9.9' }], queryStrategy: 'UseIPv6' }, rules, true)?.queryStrategy).toBe('UseIPv6');
    expect(mergeNodeDns(null, null, true)).toBeUndefined();
  });

  it('a manual dns without a general server gets the defaults after its own servers, and keeps its options', () => {
    const only = { servers: [{ address: '77.88.8.8', domains: ['geosite:category-ru'], skipFallback: true }], queryStrategy: 'UseIPv4' as const, disableCache: true };
    const out = mergeNodeDns(only, [{ presetId: 'a', rules: [{ match: ['x.com'], server: '10.0.0.1' }] }]);
    expect(out).toEqual({ ...only, servers: [only.servers[0], ...DEFAULTS, { address: '10.0.0.1', domains: ['domain:x.com'], skipFallback: true }] });
    expect(mergeNodeDns(only, null)).toBe(only);
  });

  it('a manual dns with a general server gets no defaults', () => {
    const out = mergeNodeDns(manual, [{ presetId: 'a', rules: [{ match: ['x.com'], server: '10.0.0.1' }] }]);
    expect(out?.servers).toEqual([...manual.servers, { address: '10.0.0.1', domains: ['domain:x.com'], skipFallback: true }]);
    expect(nodeDnsServerCount(manual, [{ presetId: 'a', rules: [{ match: ['x.com'], server: '10.0.0.1' }] }])).toBe(3);
  });

  it('the defaults are the agent\'s core.DefaultResolvers', () => {
    const go = readFileSync(resolve(__dirname, '../../../../node/internal/core/resolvers.go'), 'utf8');
    const m = /var DefaultResolvers = \[\]string\{([^}]*)\}/.exec(go);
    expect(m && [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1])).toEqual([...DEFAULT_NODE_RESOLVERS]);
  });

  it('keeps the 64 names a server takes: more go in a second entry of the same address', () => {
    const names = Array.from({ length: 70 }, (_, i) => `n${i}.example`);
    const out = mergeNodeDns(null, [{ presetId: 'a', rules: [{ match: names.slice(0, 40), server: '10.0.0.1' }, { match: names.slice(40), server: '10.0.0.1' }] }]);
    expect(out?.servers.slice(3).map((s) => [s.address, s.domains?.length])).toEqual([['10.0.0.1', 64], ['10.0.0.1', 6]]);
  });
});

describe('19.11: what is carried when a conflict cannot be refused', () => {
  it('the source ahead keeps the name, the clashing rule of the later one is left out whole and reported', () => {
    const out = resolveDnsConflicts([
      src('a', 'A', [['example.com'], '10.0.0.1']),
      src('b', 'B', [['domain:example.com', 'b-only.com'], '10.0.0.2'], [['other.com'], '10.0.0.2']),
    ]);
    expect(out.kept[0]!.rules).toHaveLength(1);
    expect(out.kept[1]!.rules).toEqual([{ match: ['other.com'], server: '10.0.0.2' }]);
    expect(out.dropped).toEqual([{ presetId: 'b', otherPresetId: 'a', domain: 'domain:example.com', server: '10.0.0.2' }]);
  });

  it('the same server for a name, or a name only one source has, is no conflict; neither is a source repeating itself', () => {
    const sources = [
      src('a', 'A', [['x.com'], '10.0.0.1'], [['x.com'], '10.0.0.9']),
      src('b', 'B', [['x.com'], '10.0.0.1:53'], [['y.com'], '10.0.0.2']),
    ];
    const out = resolveDnsConflicts(sources);
    expect(out.dropped).toEqual([]);
    expect(out.kept).toEqual(sources);
  });

  it('a rule that lost does not hide its names from a third source: the third meets the first', () => {
    const out = resolveDnsConflicts([
      src('a', 'A', [['x.com'], '10.0.0.1']),
      src('b', 'B', [['x.com'], '10.0.0.2']),
      src('c', 'C', [['x.com'], '10.0.0.1']),
    ]);
    expect(out.dropped.map((d) => d.presetId)).toEqual(['b']);
    expect(out.kept[2]!.rules).toHaveLength(1);
  });

  it('the panel-wide rules, first in the order, win over a preset', () => {
    const out = resolveDnsConflicts([src(null, 'panel', [['x.com'], '10.0.0.1']), src('a', 'A', [['x.com'], '10.0.0.2'])]);
    expect(out.dropped).toEqual([{ presetId: 'a', otherPresetId: null, domain: 'x.com', server: '10.0.0.2' }]);
  });
});
