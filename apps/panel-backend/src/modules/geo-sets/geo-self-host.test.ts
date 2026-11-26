import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

vi.stubEnv('GEO_SELF_HOST', 'true');

const { prisma } = await import('../../prisma.js');
const { closeRedis } = await import('../../lib/infra/redis.js');
const { cleanDatabase } = await import('../../../tests/helpers/db.js');
const { ROOT, cidr, datFile, domain, geoip, site } = await import('../../../tests/helpers/geo-dat.js');
const { ingestGeoFile } = await import('./geo-sets.store.js');
const { geoArtifactBaseUrl } = await import('./geo-public-url.js');
const { selfHostedGeo, servedSet, resetServedTagMemo } = await import('./geo-self-host.js');

/** What the panel can serve right now (milestone 10.5), flag on; the flag off is in geo-self-host.disabled.test.ts. */
beforeEach(async () => {
  vi.stubEnv('SINGBOX_BIN', process.execPath);
  await cleanDatabase();
  resetServedTagMemo();
});
afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

async function builtin(name: 'geosite' | 'geoip', bytes: Uint8Array) {
  const s = await prisma.geoSet.create({ data: { name, kind: name, sourceType: 'builtin' }, select: { id: true } });
  const out = await ingestGeoFile(s.id, { bytes });
  if (out.status !== 'verified') throw new Error('fixture');
}
const sites = datFile(site('ADS', domain(ROOT, 'a.example.com')), site('CATEGORY-RU', domain(ROOT, 'b.example.com')));
const ips = datFile(geoip('RU', cidr([10, 0, 0, 0], 8)));

describe('selfHostedGeo', () => {
  it('the address is the panel\'s /geo/<token>, the tags are lower case', async () => {
    await builtin('geosite', sites);
    await builtin('geoip', ips);
    const g = await selfHostedGeo();
    expect(g!.baseUrl).toBe(geoArtifactBaseUrl());
    expect(g!.baseUrl).toMatch(/\/geo\/[0-9a-f]{32}$/);
    expect([...g!.tags.geosite!].sort()).toEqual(['ads', 'category-ru']);
    expect([...g!.tags.geoip!]).toEqual(['ru']);
    expect(g!.srs).toBe(true);
  });

  it('a set with no verified version, or a broken one, is not served: null', async () => {
    await prisma.geoSet.create({ data: { name: 'geosite', kind: 'geosite', sourceType: 'builtin' } });
    await builtin('geoip', ips);
    expect((await selfHostedGeo())!.tags).toEqual({ geosite: null, geoip: new Set(['ru']) });
    await prisma.geoSet.update({ where: { name: 'geoip' }, data: { status: 'broken' } });
    expect((await selfHostedGeo())!.tags.geoip).toBeNull();
  });

  it('srs follows the binary: none or a path that is not there is false', async () => {
    vi.stubEnv('SINGBOX_BIN', '/nowhere/sing-box');
    expect((await selfHostedGeo())!.srs).toBe(false);
  });

  it('tags come from the version now current, not a remembered one', async () => {
    await builtin('geosite', sites);
    expect((await selfHostedGeo())!.tags.geosite!.has('ads')).toBe(true);
    const s = await prisma.geoSet.findUniqueOrThrow({ where: { name: 'geosite' } });
    await ingestGeoFile(s.id, { bytes: datFile(site('NEW', domain(ROOT, 'n.example.com'))) });
    const tags = (await selfHostedGeo())!.tags.geosite!;
    expect([...tags]).toEqual(['new']);
  });

  it('servedSet says the set, its kind and its version', async () => {
    await builtin('geoip', ips);
    expect(await servedSet('geoip')).toMatchObject({ name: 'geoip', kind: 'geoip', sourceType: 'builtin' });
    expect(await servedSet('nope')).toBeNull();
  });
});
