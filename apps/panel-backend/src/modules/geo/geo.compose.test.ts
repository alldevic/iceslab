import { describe, expect, it } from 'vitest';
import type { Domain, CIDR } from './geo.dat.js';
import { parseGeoSite } from './geo.dat.js';
import {
  composeCategory,
  parseManualDomain,
  parseCidr,
  composedToGeoSiteDat,
  composedToGeoIPDat,
  domainMatchers,
} from './geo.compose.js';

describe('domainMatchers', () => {
  it('renders domains as xray matcher strings by type', () => {
    expect(
      domainMatchers([
        { type: 2, value: 'youtube.com' },
        { type: 3, value: 'www.x.com' },
        { type: 0, value: 'ads' },
        { type: 1, value: '.*\\.ru' },
      ]),
      // keyword is EXPLICIT (not bare) so clash maps it to DOMAIN-KEYWORD instead
      // of silently narrowing it to DOMAIN-SUFFIX.
    ).toEqual(['domain:youtube.com', 'full:www.x.com', 'keyword:ads', 'regexp:.*\\.ru']);
  });
});

describe('parseManualDomain', () => {
  it('maps xray prefixes to Domain.type, bare = suffix', () => {
    expect(parseManualDomain('example.com')).toEqual({ type: 2, value: 'example.com' });
    expect(parseManualDomain('full:x.com')).toEqual({ type: 3, value: 'x.com' });
    expect(parseManualDomain('domain:y.com')).toEqual({ type: 2, value: 'y.com' });
    expect(parseManualDomain('keyword:ads')).toEqual({ type: 0, value: 'ads' });
    expect(parseManualDomain('regexp:.*\\.ru$')).toEqual({ type: 1, value: '.*\\.ru$' });
  });
});

describe('parseCidr', () => {
  it('parses v4 with and without prefix', () => {
    expect(parseCidr('1.2.3.0/24')).toEqual({ ip: Uint8Array.from([1, 2, 3, 0]), prefix: 24 });
    expect(parseCidr('8.8.8.8')).toEqual({ ip: Uint8Array.from([8, 8, 8, 8]), prefix: 32 });
  });
  it('parses v6 (incl. :: expansion)', () => {
    expect(parseCidr('2001:db8::/32')).toEqual({
      ip: Uint8Array.from([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      prefix: 32,
    });
    expect(parseCidr('::1')!.prefix).toBe(128);
    expect(parseCidr('::1')!.ip[15]).toBe(1);
  });
  it('rejects malformed CIDRs', () => {
    expect(parseCidr('1.2.3')).toBeNull();
    expect(parseCidr('1.2.3.256')).toBeNull();
    expect(parseCidr('1.2.3.0/33')).toBeNull();
    expect(parseCidr('zzzz::/16')).toBeNull();
    expect(parseCidr('')).toBeNull();
    // `Number('')`/`Number('1e2')` leniency must not sneak past: a trailing
    // slash would otherwise parse as prefix 0 (match-everything).
    expect(parseCidr('1.2.3.4/')).toBeNull();
    expect(parseCidr('1..2.3')).toBeNull();
    expect(parseCidr('1.2.3.0/1e1')).toBeNull();
    expect(parseCidr('2001:db8::/')).toBeNull();
  });
});

describe('composeCategory', () => {
  const siteA = new Map<string, Domain[]>([
    ['YOUTUBE', [{ type: 2, value: 'youtube.com' }, { type: 2, value: 'ytimg.com' }]],
  ]);
  const siteB = new Map<string, Domain[]>([
    // overlaps youtube.com (must dedupe) + adds googlevideo.com
    ['MYLIST', [{ type: 2, value: 'youtube.com' }, { type: 2, value: 'googlevideo.com' }]],
  ]);

  it('merges categories from several sources + manual domains, deduped', () => {
    const c = composeCategory({
      name: 'my-video',
      domainSources: [
        { site: siteA, category: 'youtube' },
        { site: siteB, category: 'mylist' },
      ],
      manualDomains: ['full:vimeo.com', 'youtube.com'], // youtube.com dupes the sourced one
    });
    expect(c.name).toBe('MY-VIDEO');
    expect(c.domains).toEqual([
      { type: 2, value: 'youtube.com' },
      { type: 2, value: 'ytimg.com' },
      { type: 2, value: 'googlevideo.com' },
      { type: 3, value: 'vimeo.com' },
    ]);
    expect(c.missing).toEqual([]);
  });

  it('applies excludeDomains (case-insensitive, exact value)', () => {
    const c = composeCategory({
      name: 'x',
      domainSources: [{ site: siteA, category: 'youtube' }],
      excludeDomains: ['YTIMG.COM'],
    });
    expect(c.domains.map((d) => d.value)).toEqual(['youtube.com']);
  });

  it('reports missing source categories', () => {
    const c = composeCategory({
      name: 'x',
      domainSources: [{ site: siteA, category: 'nope' }],
      ipSources: [{ ip: new Map(), category: 'ru' }],
    });
    expect(c.missing).toEqual(['geosite:nope', 'geoip:ru']);
  });

  it('merges ip sources + manual IPs, deduped', () => {
    const ipA = new Map<string, CIDR[]>([
      ['RU', [{ ip: Uint8Array.from([77, 88, 0, 0]), prefix: 16 }]],
    ]);
    const c = composeCategory({
      name: 'ru-plus',
      ipSources: [{ ip: ipA, category: 'ru' }],
      manualIps: ['77.88.0.0/16', '10.0.0.0/8'], // first dupes the sourced one
    });
    expect(c.cidrs).toEqual([
      { ip: Uint8Array.from([77, 88, 0, 0]), prefix: 16 },
      { ip: Uint8Array.from([10, 0, 0, 0]), prefix: 8 },
    ]);
  });

  it('round-trips a composed category through a .dat', () => {
    const c = composeCategory({
      name: 'my-video',
      domainSources: [{ site: siteA, category: 'youtube' }],
      manualDomains: ['vimeo.com'],
    });
    const parsed = parseGeoSite(composedToGeoSiteDat([c]));
    expect([...parsed.keys()]).toEqual(['MY-VIDEO']);
    expect(parsed.get('MY-VIDEO')).toEqual([
      { type: 2, value: 'youtube.com' },
      { type: 2, value: 'ytimg.com' },
      { type: 2, value: 'vimeo.com' },
    ]);
  });

  it('omits empty categories from the emitted .dat', () => {
    const ipOnly = composeCategory({ name: 'ips', manualIps: ['1.2.3.0/24'] });
    // no domains -> not in the geosite dat; present in the geoip dat
    expect(parseGeoSite(composedToGeoSiteDat([ipOnly])).size).toBe(0);
    expect(composedToGeoIPDat([ipOnly]).length).toBeGreaterThan(0);
  });
});
