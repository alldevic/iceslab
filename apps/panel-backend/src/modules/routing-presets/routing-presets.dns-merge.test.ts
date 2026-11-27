import { describe, it, expect } from 'vitest';
import {
  carriesRule,
  findDnsConflict,
  mergeNodeDns,
  normalizeDnsName,
  normalizeDnsServer,
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
      servers: [{ address: 'https://dns.example/dns-query', domains: ['domain:x.com'], skipFallback: true }],
    });
  });

  it('keeps the 64 names a server takes: more go in a second entry of the same address', () => {
    const names = Array.from({ length: 70 }, (_, i) => `n${i}.example`);
    const out = mergeNodeDns(null, [{ presetId: 'a', rules: [{ match: names.slice(0, 40), server: '10.0.0.1' }, { match: names.slice(40), server: '10.0.0.1' }] }]);
    expect(out?.servers.map((s) => [s.address, s.domains?.length])).toEqual([['10.0.0.1', 64], ['10.0.0.1', 6]]);
  });
});
