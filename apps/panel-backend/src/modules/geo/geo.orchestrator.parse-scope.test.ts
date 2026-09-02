import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { addSource } from './geo.sources.js';
import { addCategory } from './geo.categories.js';
import { encodeGeoSite, encodeGeoIP, type Domain, type CIDR } from './geo.dat.js';
import { invalidateSourceCache } from './geo.sourcecache.js';
import type { DatFetcher } from './geo.fetch.js';

/**
 * A build turns into JS objects only what some enabled category actually reads.
 *
 * Parsing is how categories are enumerated, so it was done in full whenever a
 * build ran at all — including a build with NO custom categories, whose whole
 * output is a copy of the bytes already in hand. On the runetfreedom sources
 * that is 3.15M domains and 1.23M networks: 590 MB of heap and 762 MB RSS,
 * measured, against the image's own `--max-old-space-size=512`. With
 * GEO_SELF_HOST on the start-up warm-up runs a build, so the panel crash-looped
 * rather than failed once.
 *
 * That the narrowing SAVES the memory is measured in geo.dat.filter.test.ts,
 * where the parsed result can be held and weighed. What is pinned here is the
 * other half — that the orchestrator asks for the narrow thing, and asks for
 * exactly the categories its specs name — which cannot be weighed, because the
 * maps are released before the build returns.
 */

const parseCalls: { fn: 'site' | 'ip'; only: string[] | null }[] = [];

vi.mock('./geo.dat.js', async () => {
  const actual = await vi.importActual<typeof import('./geo.dat.js')>('./geo.dat.js');
  return {
    ...actual,
    parseGeoSite: (data: Uint8Array, only?: Iterable<string>) => {
      parseCalls.push({ fn: 'site', only: only ? [...only] : null });
      return actual.parseGeoSite(data, only);
    },
    parseGeoIP: (data: Uint8Array, only?: Iterable<string>) => {
      parseCalls.push({ fn: 'ip', only: only ? [...only] : null });
      return actual.parseGeoIP(data, only);
    },
  };
});

const { buildGeoArtifacts } = await import('./geo.orchestrator.js');

const GS = encodeGeoSite(
  new Map<string, Domain[]>([
    ['CAT0', [{ type: 2, value: 'a.example' }]],
    ['CAT1', [{ type: 2, value: 'b.example' }]],
    ['CAT2', [{ type: 2, value: 'c.example' }, { type: 2, value: 'd.example' }]],
  ]),
);
const GI = encodeGeoIP(
  new Map<string, CIDR[]>([
    ['IPCAT0', [{ ip: Uint8Array.from([10, 0, 0, 0]), prefix: 8 }]],
    ['IPCAT1', [{ ip: Uint8Array.from([172, 16, 0, 0]), prefix: 12 }]],
  ]),
);

const fetchDat: DatFetcher = async (url) => {
  if (url === 'https://example.com/gs.dat') return { status: 200, bytes: GS };
  if (url === 'https://example.com/gi.dat') return { status: 200, bytes: GI };
  throw new Error('unreachable in test'); // the seeded runetfreedom default
};

async function synSource(): Promise<string> {
  const src = await addSource({
    name: `syn-${Date.now()}`,
    geositeUrl: 'https://example.com/gs.dat',
    geoipUrl: 'https://example.com/gi.dat',
  });
  return src.id;
}

beforeEach(async () => {
  await prisma.appSetting.deleteMany({ where: { key: { in: ['geoSources', 'geoCategories'] } } });
  invalidateSourceCache();
  parseCalls.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('a build parses what it is going to use', () => {
  it('parses nothing when no category reads anything', async () => {
    await synSource();
    const res = await buildGeoArtifacts({ fetchDat, singboxBin: '' });

    expect(parseCalls, `parsed anyway: ${JSON.stringify(parseCalls)}`).toEqual([]);
    // And it still did its job: the mirror is what clients pull, and
    // revalidating the sources is the reason this build runs at all. The saving
    // is in the parse, not the fetch.
    expect(res.mirror.geosite!.bytes).toEqual(GS);
    expect(res.mirror.geoip!.bytes).toEqual(GI);
  });

  it('asks for exactly the categories its specs name', async () => {
    const sourceId = await synSource();
    await addCategory({
      name: 'one-cat',
      domainRefs: [{ sourceId, category: 'cat2' }],
      ipRefs: [{ sourceId, category: 'ipcat1' }],
    });
    const res = await buildGeoArtifacts({ fetchDat, singboxBin: '' });

    expect(parseCalls).toEqual([
      { fn: 'site', only: ['cat2'] },
      { fn: 'ip', only: ['ipcat1'] },
    ]);
    // The control that matters: narrowing must not change the answer.
    const built = res.categories.find((c) => c.name === 'ONE-CAT');
    expect(built).toMatchObject({ domains: 2, cidrs: 1, missing: [] });
  });

  it('unions what several categories read from one source', async () => {
    const sourceId = await synSource();
    await addCategory({ name: 'a', domainRefs: [{ sourceId, category: 'cat0' }] });
    await addCategory({ name: 'b', domainRefs: [{ sourceId, category: 'cat1' }] });
    await buildGeoArtifacts({ fetchDat, singboxBin: '' });

    const site = parseCalls.filter((c) => c.fn === 'site');
    expect(site).toHaveLength(1);
    expect([...site[0]!.only!].sort()).toEqual(['cat0', 'cat1']);
  });

  it('skips a disabled category, which is what "enabled" has to mean here', async () => {
    const sourceId = await synSource();
    await addCategory({
      name: 'off',
      enabled: false,
      domainRefs: [{ sourceId, category: 'cat0' }],
    });
    await buildGeoArtifacts({ fetchDat, singboxBin: '' });
    expect(parseCalls).toEqual([]);
  });
});
