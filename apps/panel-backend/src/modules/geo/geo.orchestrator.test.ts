import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { addSource } from './geo.sources.js';
import { addCategory } from './geo.categories.js';
import {
  encodeGeoSite,
  encodeGeoIP,
  parseGeoSite,
  parseGeoIP,
  type Domain,
  type CIDR,
} from './geo.dat.js';
import { buildGeoArtifacts, plannedCustomSrs } from './geo.orchestrator.js';
import { composeCategory, type ComposedCategory } from './geo.compose.js';
import type { DatFetcher } from './geo.fetch.js';
import { invalidateSourceCache } from './geo.sourcecache.js';

// Deterministic (binary-free) guard for the custom .srs selection + naming - the
// runIf(SINGBOX_BIN) tests below don't run in the default CI path, so this locks
// the domain-only selection and the custom-<UPPER>.srs naming the compile loop
// depends on, without needing a real sing-box binary.
describe('plannedCustomSrs (custom .srs selection + naming)', () => {
  it('selects only domain-bearing categories, named custom-<name>.srs', () => {
    const composed = [
      { name: 'RUNET', domains: [{ type: 2, value: 'x.ru' }], cidrs: [], missing: [] },
      { name: 'IPONLY', domains: [], cidrs: [{ ip: Uint8Array.of(10, 0, 0, 0), prefix: 8 }], missing: [] },
    ] as ComposedCategory[];
    expect(plannedCustomSrs(composed)).toEqual([
      { category: composed[0], artifact: 'custom-RUNET.srs' },
    ]);
  });

  it('composeCategory UPPERCASES the name, so the .srs is custom-<UPPER>.srs', () => {
    const c = composeCategory({
      name: 'my-block',
      domainSources: [],
      ipSources: [],
      manualDomains: ['example.com'],
      manualIps: [],
      excludeDomains: [],
    });
    expect(plannedCustomSrs([c])).toEqual([{ category: c, artifact: 'custom-MY-BLOCK.srs' }]);
  });

  it('an IP-only composed category is excluded (parity with the xray/clash domain-only path)', () => {
    const c = composeCategory({
      name: 'ipcat',
      domainSources: [],
      ipSources: [],
      manualDomains: [],
      manualIps: ['10.0.0.0/8'],
      excludeDomains: [],
    });
    expect(c.domains.length).toBe(0);
    expect(c.cidrs.length).toBeGreaterThan(0);
    expect(plannedCustomSrs([c])).toEqual([]);
  });
});

// Synthetic upstream .dat the injected fetcher serves (no network in tests).
const GS = encodeGeoSite(
  new Map<string, Domain[]>([
    ['YOUTUBE', [{ type: 2, value: 'youtube.com' }, { type: 2, value: 'ytimg.com' }]],
    ['ADS', [{ type: 2, value: 'ads.example' }]],
  ]),
);
const GI = encodeGeoIP(
  new Map<string, CIDR[]>([['RU', [{ ip: Uint8Array.from([77, 88, 0, 0]), prefix: 16 }]]]),
);

beforeEach(async () => {
  await prisma.appSetting.deleteMany({ where: { key: { in: ['geoSources', 'geoCategories'] } } });
  invalidateSourceCache(); // cold source-bytes cache per test
});
afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('geo build orchestrator', () => {
  it('composes custom categories from fetched sources + manual entries', async () => {
    const src = await addSource({
      name: 'syn',
      geositeUrl: 'https://example.com/gs.dat',
      geoipUrl: 'https://example.com/gi.dat',
    });
    await addCategory({
      name: 'my-block',
      domainRefs: [{ sourceId: src.id, category: 'youtube' }],
      ipRefs: [{ sourceId: src.id, category: 'ru' }],
      manualDomains: ['full:vimeo.com'],
      manualIps: ['10.0.0.0/8'],
    });

    const fetchDat: DatFetcher = async (url) => {
      if (url === 'https://example.com/gs.dat') return { status: 200, bytes: GS };
      if (url === 'https://example.com/gi.dat') return { status: 200, bytes: GI };
      throw new Error('unreachable in test'); // the seeded runetfreedom default
    };
    const res = await buildGeoArtifacts({ fetchDat });

    const site = parseGeoSite(res.geosite.bytes);
    expect(site.get('MY-BLOCK')).toEqual([
      { type: 2, value: 'youtube.com' },
      { type: 2, value: 'ytimg.com' },
      { type: 3, value: 'vimeo.com' },
    ]);
    const ip = parseGeoIP(res.geoip.bytes);
    expect(ip.get('MY-BLOCK')).toEqual([
      { ip: Uint8Array.from([77, 88, 0, 0]), prefix: 16 },
      { ip: Uint8Array.from([10, 0, 0, 0]), prefix: 8 },
    ]);

    // the full-database mirror is the raw bytes of the first working source
    // (the seeded default runetfreedom fails in the test, so it is `syn`).
    expect(res.mirror.geosite!.bytes).toEqual(GS);
    expect(res.mirror.geosite!.name).toBe('geosite.dat');
    expect(res.mirror.geoip!.bytes).toEqual(GI);

    expect(res.geosite.name).toBe('geo-custom.dat');
    expect(res.geoip.name).toBe('geo-custom-ip.dat');
    expect(res.geosite.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res.categories[0]).toMatchObject({ name: 'MY-BLOCK', missing: [] });
    // the default runetfreedom source is unreachable in the test -> recorded,
    // not fatal, and does not affect MY-BLOCK (which refs the syn source).
    expect(res.sourceErrors.length).toBeGreaterThan(0);
  });

  it('records source errors and surfaces missing refs when a fetch fails', async () => {
    const src = await addSource({ name: 'broken', geositeUrl: 'https://example.com/broken.dat' });
    await addCategory({ name: 'x', domainRefs: [{ sourceId: src.id, category: 'youtube' }] });

    const fetchDat: DatFetcher = async () => {
      throw new Error('boom');
    };
    const res = await buildGeoArtifacts({ fetchDat });

    expect(res.sourceErrors.some((e) => e.sourceId === src.id)).toBe(true);
    expect(res.categories[0]!.missing).toContain('geosite:youtube');
    // nothing composed -> empty geosite artifact
    expect(parseGeoSite(res.geosite.bytes).size).toBe(0);
  });

  it.runIf(process.env.SINGBOX_BIN)(
    'compiles preset .srs rule-sets from the mirror when SINGBOX_BIN is set',
    async () => {
      const GSru = encodeGeoSite(
        new Map<string, Domain[]>([['CATEGORY-RU', [{ type: 2, value: 'yandex.ru' }]]]),
      );
      const src = await addSource({ name: 'ru', geositeUrl: 'https://example.com/ru.dat' });
      await addCategory({ name: 'c', domainRefs: [{ sourceId: src.id, category: 'category-ru' }] });
      const fetchDat: DatFetcher = async (url) => {
        if (url === 'https://example.com/ru.dat') return { status: 200, bytes: GSru };
        throw new Error('unreachable');
      };
      const res = await buildGeoArtifacts({ fetchDat, singboxBin: process.env.SINGBOX_BIN });
      const srs = res.ruleSets.find((r) => r.name === 'geosite-category-ru.srs');
      expect(srs).toBeDefined();
      expect(srs!.bytes.length).toBeGreaterThan(0);
      expect(srs!.sha256).toMatch(/^[0-9a-f]{64}$/);
    },
  );

  it.runIf(process.env.SINGBOX_BIN)(
    'compiles a domain-only custom .srs (UPPERCASE) and skips an IP-only category',
    async () => {
      const GS = encodeGeoSite(new Map<string, Domain[]>([['SEED', [{ type: 2, value: 'x.com' }]]]));
      const src = await addSource({ name: 's', geositeUrl: 'https://example.com/s.dat' });
      // Domain-bearing custom category -> gets a custom-<UPPER>.srs.
      await addCategory({ name: 'mydom', domainRefs: [{ sourceId: src.id, category: 'seed' }] });
      // IP-only custom category -> NO custom .srs (symmetric with the xray/clash
      // domain-only inline path, so no format silently diverges on IP matching).
      await addCategory({ name: 'myip', manualIps: ['10.0.0.0/8'] });
      const fetchDat: DatFetcher = async (url) => {
        if (url === 'https://example.com/s.dat') return { status: 200, bytes: GS };
        throw new Error('unreachable');
      };
      const res = await buildGeoArtifacts({ fetchDat, singboxBin: process.env.SINGBOX_BIN });
      const names = res.ruleSets.map((r) => r.name);
      expect(names).toContain('custom-MYDOM.srs');
      expect(names).not.toContain('custom-MYIP.srs');
    },
  );

  it('respectInterval reuses cached source bytes without re-fetching within the interval', async () => {
    const src = await addSource({
      name: 'syn',
      geositeUrl: 'https://example.com/gs.dat',
      refreshIntervalHours: 24,
    });
    await addCategory({ name: 'c', domainRefs: [{ sourceId: src.id, category: 'youtube' }] });
    let calls = 0; // count only OUR source (the seeded default also gets tried)
    const fetchDat: DatFetcher = async (url) => {
      if (url === 'https://example.com/gs.dat') {
        calls++;
        return { status: 200, bytes: GS };
      }
      throw new Error('unreachable'); // default runetfreedom source
    };
    await buildGeoArtifacts({ fetchDat }); // force -> fetches (calls=1)
    await buildGeoArtifacts({ fetchDat, respectInterval: true }); // within 24h -> reuse, no fetch
    expect(calls).toBe(1);
  });

  it('produces a deterministic sha256 for identical inputs', async () => {
    const src = await addSource({ name: 'syn', geositeUrl: 'https://example.com/gs.dat' });
    await addCategory({ name: 'c', domainRefs: [{ sourceId: src.id, category: 'youtube' }] });
    const fetchDat: DatFetcher = async (url) => {
      if (url === 'https://example.com/gs.dat') return { status: 200, bytes: GS };
      throw new Error('unreachable');
    };
    const a = await buildGeoArtifacts({ fetchDat });
    const b = await buildGeoArtifacts({ fetchDat });
    expect(a.geosite.sha256).toBe(b.geosite.sha256);
  });
});
