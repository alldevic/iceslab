import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { addSource } from './geo.sources.js';
import { addCategory } from './geo.categories.js';
import { encodeGeoSite, parseGeoSite, type Domain } from './geo.dat.js';
import type { DatFetcher } from './geo.fetch.js';
import { invalidateSourceCache } from './geo.sourcecache.js';
import {
  rebuildGeo,
  getGeoBuildMeta,
  getGeoArtifact,
  getCategoryDomains,
  invalidateGeoBuild,
  GeoBuildAllSourcesFailed,
} from './geo.registry.js';

const GS = encodeGeoSite(
  new Map<string, Domain[]>([['YOUTUBE', [{ type: 2, value: 'youtube.com' }]]]),
);
const fetchDat: DatFetcher = async (url) => {
  if (url === 'https://example.com/gs.dat') return { status: 200, bytes: GS };
  throw new Error('unreachable in test'); // seeded default runetfreedom source
};

beforeEach(async () => {
  await prisma.appSetting.deleteMany({ where: { key: { in: ['geoSources', 'geoCategories'] } } });
  invalidateGeoBuild();
  invalidateSourceCache();
});
afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('geo build registry (cache)', () => {
  it('builds, caches metadata, and serves the artifact bytes', async () => {
    const src = await addSource({ name: 'syn', geositeUrl: 'https://example.com/gs.dat' });
    await addCategory({ name: 'c', domainRefs: [{ sourceId: src.id, category: 'youtube' }] });

    expect(getGeoBuildMeta()).toBeNull(); // nothing built yet

    const meta = await rebuildGeo({ fetchDat });
    expect(meta.builtAt).toBeTruthy();
    const site = meta.artifacts.find((a) => a.name === 'geo-custom.dat')!;
    expect(site.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(site.size).toBeGreaterThan(0);

    // metadata is cached (same builtAt without rebuilding)
    expect(getGeoBuildMeta()!.builtAt).toBe(meta.builtAt);

    // the served artifact matches the composed category + advertised sha
    const artifact = await getGeoArtifact('geo-custom.dat');
    expect(parseGeoSite(artifact!.bytes).get('C')).toEqual([{ type: 2, value: 'youtube.com' }]);
    expect(artifact!.sha256).toBe(site.sha256);

    // the category's domains are exposed as xray matchers (for inline use)
    expect(getCategoryDomains('c')).toEqual(['domain:youtube.com']);
    expect(getCategoryDomains('nope')).toBeNull();
  });

  it('invalidate clears the cache', async () => {
    await addSource({ name: 'syn', geositeUrl: 'https://example.com/gs.dat' });
    await rebuildGeo({ fetchDat });
    expect(getGeoBuildMeta()).not.toBeNull();
    invalidateGeoBuild();
    expect(getGeoBuildMeta()).toBeNull();
  });

  it('returns null for an unknown artifact name', async () => {
    // A real source so the build succeeds (the seeded default points at
    // runetfreedom, which this fetcher can't serve; a build where EVERY source
    // fails now throws instead of caching an empty build - see next test).
    await addSource({ name: 'syn', geositeUrl: 'https://example.com/gs.dat' });
    await rebuildGeo({ fetchDat });
    expect(await getGeoArtifact('nope.dat')).toBeNull();
  });

  it('does NOT cache a build where every source failed (retries next time)', async () => {
    // Only the seeded default source is present; the fetcher throws for it.
    await expect(rebuildGeo({ fetchDat })).rejects.toBeInstanceOf(GeoBuildAllSourcesFailed);
    expect(getGeoBuildMeta()).toBeNull(); // not cached -> a later request retries
  });

  it('the all-failed sentinel carries per-source diagnostics', async () => {
    const err = await rebuildGeo({ fetchDat }).catch((e) => e);
    expect(err).toBeInstanceOf(GeoBuildAllSourcesFailed);
    // the default runetfreedom source's fetch failure is reported (not swallowed)
    expect(err.meta.sourceErrors.length).toBeGreaterThan(0);
  });
});
