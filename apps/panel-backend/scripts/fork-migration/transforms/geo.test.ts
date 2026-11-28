import { describe, expect, it } from 'vitest';
import { coerceCategories, coerceSources, normalizeTag, planGeo, rewriteDeep, rewriteExt } from './geo.js';

const sources = coerceSources([
  { id: 'default', name: 'runetfreedom (official)', geositeUrl: 'https://x/geosite.dat', geoipUrl: 'https://x/geoip.dat', enabled: true, refreshIntervalHours: 24, trusted: true },
  { id: 's1', name: 'My Source!', geositeUrl: 'https://geo.example.org/geosite.dat', geoipUrl: 'https://geo.example.org/geoip.dat', enabled: true, refreshIntervalHours: 12 },
  { id: 's2', name: 'Only IPs', geoipUrl: 'https://geo.example.org/only.dat', enabled: true },
  { id: 's3', name: 'Off', geositeUrl: 'https://geo.example.org/off.dat', enabled: false },
  { id: 's4', name: 'Odd', geositeUrl: 'ftp://nope/x.dat', enabled: true },
]);

describe('geo sources and categories of the old fork -> geo sets', () => {
  it('the default source is not carried, the others become one url set per kind', () => {
    const p = planGeo(sources, [], new Set());
    expect(p.urlSets.map((s) => [s.name, s.kind, s.refreshHours])).toEqual([
      ['my-source-site', 'geosite', 12],
      ['my-source-ip', 'geoip', 12],
      ['only-ips-ip', 'geoip', 24],
    ]);
    expect(p.skipped.map((s) => s.what)).toEqual(expect.arrayContaining(['source "Off"', 'source "Odd" geosite url']));
  });

  it('names stay free of the taken and the reserved ones', () => {
    const p = planGeo(sources, [], new Set(['my-source-site']));
    expect(p.urlSets[0]!.name).toBe('my-source-2-site');
  });

  it('a category becomes a domain and an address category of the two composite sets, names lower-cased', () => {
    const cats = coerceCategories([
      { id: 'c', name: 'MyCat', domainRefs: [{ sourceId: 'default', category: 'Category-RU' }, { sourceId: 's1', category: 'streaming' }], ipRefs: [{ sourceId: 's1', category: 'ru' }], manualDomains: ['example.org'], manualIps: ['203.0.113.0/24'], excludeDomains: ['bad.example.org'], enabled: true },
      { id: 'd', name: 'Dotted.Name', domainRefs: [{ sourceId: 'default', category: 'x' }] },
    ]);
    const p = planGeo(sources, cats, new Set());
    const [dom, ip] = p.composites;
    expect(dom).toMatchObject({ name: 'geo-custom', kind: 'geosite' });
    expect(dom!.categories[0]).toEqual({
      name: 'mycat',
      refs: [{ set: 'geosite', tag: 'category-ru' }, { set: 'my-source-site', tag: 'streaming' }],
      manual: ['example.org'],
      exclude: ['bad.example.org'],
      enabled: true,
    });
    expect(dom!.categories[1]!.name).toBe('dotted-name');
    expect(ip).toMatchObject({ name: 'geo-custom-ip', kind: 'geoip' });
    expect(ip!.categories).toEqual([{ name: 'mycat', refs: [{ set: 'my-source-ip', tag: 'ru' }], manual: ['203.0.113.0/24'], exclude: [], enabled: true }]);
  });

  it('what cannot be carried is named, not guessed: unknown source, a bad entry, an empty category, a repeated name', () => {
    const cats = coerceCategories([
      { id: '1', name: 'ghost', domainRefs: [{ sourceId: 'nope', category: 'z' }] },
      { id: '2', name: 'badentry', manualDomains: ['not a domain!'] },
      { id: '3', name: 'empty' },
      { id: '4', name: 'Twin', manualDomains: ['a.example'] },
      { id: '5', name: 'TWIN', manualDomains: ['b.example'] },
      { id: '6', name: 'ipcat-only-ip-source', domainRefs: [{ sourceId: 's2', category: 'z' }] },
    ]);
    const p = planGeo(sources, cats, new Set());
    expect(p.composites[0]!.categories.map((c) => c.name)).toEqual(['twin']);
    expect(p.skipped.map((s) => s.what)).toEqual(
      expect.arrayContaining(['category "ghost" (domains)', 'category "badentry" (domains)', 'category "empty"', 'category "TWIN" (domains)', 'category "ipcat-only-ip-source" (domains)']),
    );
  });

  it('rewrites the file-name matchers, with prefix and @attribute kept, and lists the ones it cannot', () => {
    const cats = coerceCategories([{ id: 'c', name: 'MyCat', domainRefs: [{ sourceId: 'default', category: 'x' }], manualIps: ['203.0.113.0/24'] }]);
    const p = planGeo(sources, cats, new Set());
    expect(rewriteExt('ext:geo-custom.dat:MYCAT', p.tags).value).toBe('ext:geo-custom:mycat');
    expect(rewriteExt('ext-ip:geo-custom-ip.dat:MyCat', p.tags).value).toBe('ext-ip:geo-custom-ip:mycat');
    expect(rewriteExt('ext:geo-custom.dat:MyCat@cn', p.tags).value).toBe('ext:geo-custom:mycat@cn');
    expect(rewriteExt('ext:geo-custom.dat:Gone', p.tags)).toEqual({ value: null, unresolved: 'ext:geo-custom.dat:Gone' });
    expect(rewriteExt('geosite:ru', p.tags)).toEqual({ value: null });
    const acc = { changed: 0, unresolved: [] as string[] };
    const out = rewriteDeep({ a: ['ext:geo-custom.dat:MyCat', 'x.example'], b: { c: 'ext:geo-custom.dat:Gone' } }, p.tags, acc);
    expect(out).toEqual({ a: ['ext:geo-custom:mycat', 'x.example'], b: { c: 'ext:geo-custom.dat:Gone' } });
    expect(acc).toEqual({ changed: 1, unresolved: ['ext:geo-custom.dat:Gone'] });
  });

  it('normalizeTag', () => {
    expect(normalizeTag('A.B_c-D')).toBe('a-b_c-d');
  });
});
