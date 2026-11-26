import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

vi.stubEnv('SUBSCRIPTION_XRAY_GEO_INLINE', 'true');

const { prisma } = await import('../../prisma.js');
const { closeRedis } = await import('../../lib/infra/redis.js');
const { cleanDatabase } = await import('../../../tests/helpers/db.js');
const { FULL, PLAIN, REGEX, ROOT, cidr, datFile, domain, geoip, site } = await import('../../../tests/helpers/geo-dat.js');
const { ingestGeoFile } = await import('./geo-sets.store.js');
const { resetServedTagMemo } = await import('./geo-self-host.js');
const { presetGeoInline, resetPresetGeoInlineMemo } = await import('./geo-preset-inline.js');

/** The embedded data of the built-in split presets (milestone 12.5), switch on; the switch off is in geo-preset-inline.disabled.test.ts. */
beforeEach(async () => {
  await cleanDatabase();
  resetServedTagMemo();
  resetPresetGeoInlineMemo();
});
afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

async function builtin(name: 'geosite' | 'geoip', bytes: Uint8Array) {
  const existing = await prisma.geoSet.findUnique({ where: { name }, select: { id: true } });
  const id = existing?.id ?? (await prisma.geoSet.create({ data: { name, kind: name, sourceType: 'builtin' }, select: { id: true } })).id;
  const out = await ingestGeoFile(id, { bytes });
  if (out.status !== 'verified') throw new Error('fixture');
}

const sites = datFile(
  site('CATEGORY-ADS-ALL', domain(ROOT, 'ads.example.com')),
  site('CATEGORY-RU', domain(ROOT, 'yandex.ru'), domain(FULL, 'www.example.ru'), domain(PLAIN, 'ruword'), domain(REGEX, '^a\\.ru$'), domain(ROOT, 'yandex.ru')),
  site('CATEGORY-GOV-RU', domain(ROOT, 'gosuslugi.ru'), domain(ROOT, 'yandex.ru')),
  site('CN', domain(ROOT, 'baidu.com')),
);
const v6 = [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const ips = datFile(geoip('RU', cidr([5, 3, 0, 0], 16), cidr(v6, 32), cidr([77, 88, 0, 0], 16)), geoip('CN', cidr([1, 0, 1, 0], 24)));

describe('presetGeoInline', () => {
  it('ru-split: the domains in xray\'s spelling, per category and without repeats; IPv4 networks only', async () => {
    await builtin('geosite', sites);
    await builtin('geoip', ips);
    const d = await presetGeoInline('ru-split');
    expect(d).toEqual({
      domains: {
        'category-ru': ['domain:yandex.ru', 'full:www.example.ru', 'keyword:ruword', 'regexp:^a\\.ru$'],
        'category-gov-ru': ['domain:gosuslugi.ru', 'domain:yandex.ru'],
      },
      cidrs: { ru: ['5.3.0.0/16', '77.88.0.0/16'] },
    });
    expect(JSON.stringify(d)).not.toContain('2001');
    expect(JSON.stringify(d)).not.toContain('ads.example.com');
  });

  it('cn-split is not embedded (12.5 decision), even with both sets served', async () => {
    await builtin('geosite', sites);
    await builtin('geoip', ips);
    expect(await presetGeoInline('cn-split')).toBeNull();
  });

  it('proxy-all has nothing to embed', async () => {
    await builtin('geosite', sites);
    await builtin('geoip', ips);
    expect(await presetGeoInline('proxy-all')).toBeNull();
  });

  it('no answer when a set is missing or not verified, or broken', async () => {
    expect(await presetGeoInline('ru-split')).toBeNull();
    await builtin('geoip', ips);
    expect(await presetGeoInline('ru-split')).toBeNull();
    await prisma.geoSet.create({ data: { name: 'geosite', kind: 'geosite', sourceType: 'builtin' } });
    expect(await presetGeoInline('ru-split')).toBeNull();
    await builtin('geosite', sites);
    expect(await presetGeoInline('ru-split')).not.toBeNull();
    await prisma.geoSet.update({ where: { name: 'geoip' }, data: { status: 'broken' } });
    expect(await presetGeoInline('ru-split')).toBeNull();
  });

  it('no answer when one category of the preset is absent', async () => {
    await builtin('geosite', datFile(site('CATEGORY-RU', domain(ROOT, 'yandex.ru')), site('CN', domain(ROOT, 'baidu.com'))));
    await builtin('geoip', ips);
    expect(await presetGeoInline('ru-split')).toBeNull();
  });

  it('no answer when a category holds no IPv4 network, or no domain', async () => {
    await builtin('geosite', sites);
    await builtin('geoip', datFile(geoip('RU', cidr(v6, 32)), geoip('CN', cidr([1, 0, 1, 0], 24))));
    expect(await presetGeoInline('ru-split')).toBeNull();
    expect(await presetGeoInline('cn-split')).toBeNull();
  });

  it('a new current version of a set changes the answer without a restart', async () => {
    await builtin('geosite', sites);
    await builtin('geoip', ips);
    expect((await presetGeoInline('ru-split'))!.cidrs.ru).toEqual(['5.3.0.0/16', '77.88.0.0/16']);
    await builtin('geoip', datFile(geoip('RU', cidr([9, 9, 0, 0], 16)), geoip('CN', cidr([1, 0, 1, 0], 24))));
    expect((await presetGeoInline('ru-split'))!.cidrs.ru).toEqual(['9.9.0.0/16']);
    await builtin('geosite', datFile(site('CATEGORY-RU', domain(ROOT, 'new.ru')), site('CATEGORY-GOV-RU', domain(ROOT, 'gov.new.ru'))));
    expect((await presetGeoInline('ru-split'))!.domains['category-ru']).toEqual(['domain:new.ru']);
  });
});
