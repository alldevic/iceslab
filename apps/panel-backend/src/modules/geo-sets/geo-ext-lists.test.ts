import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const { prisma } = await import('../../prisma.js');
const { closeRedis } = await import('../../lib/infra/redis.js');
const { cleanDatabase } = await import('../../../tests/helpers/db.js');
const { FULL, PLAIN, REGEX, ROOT, cidr, datFile, domain, geoip, site } = await import('../../../tests/helpers/geo-dat.js');
const { ingestGeoFile } = await import('./geo-sets.store.js');
const { resetServedTagMemo } = await import('./geo-self-host.js');
const { EXT_LIST_MAX_ENTRIES, expandExtLists, hasExtEntries, parseExtListEntry, resetExtListMemo, singboxExtRefs } = await import(
  './geo-ext-lists.js'
);
import type { SelfHostedGeo } from './geo-self-host.js';

const GEO: SelfHostedGeo = { baseUrl: 'https://p.example.com/geo/T', tags: { geosite: null, geoip: null }, srs: true };
const NO_SRS: SelfHostedGeo = { ...GEO, srs: false };
const lists = (o: Partial<Record<'direct' | 'proxy' | 'block', string[]>>) => ({ direct: [], proxy: [], block: [], ...o });
const log = () => ({ warn: vi.fn() });

beforeEach(async () => {
  await cleanDatabase();
  resetServedTagMemo();
  resetExtListMemo();
});
afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

async function set(name: string, kind: 'geosite' | 'geoip', sourceType: string, bytes: Uint8Array) {
  const s = await prisma.geoSet.create({ data: { name, kind, sourceType }, select: { id: true } });
  const out = await ingestGeoFile(s.id, { bytes });
  if (out.status !== 'verified') throw new Error('fixture');
}
const sites = datFile(
  site('RU-LIST', domain(ROOT, 'a.example.ru'), domain(FULL, 'www.b.example.ru'), domain(PLAIN, 'kw'), domain(REGEX, '^r\\d+\\.example$')),
  site('OTHER', domain(ROOT, 'o.example')),
);

describe('parseExtListEntry', () => {
  it('reads ext:<set>:<category>, the category lower-cased', () => {
    expect(parseExtListEntry('ext:my-set:Ru-List')).toEqual({ set: 'my-set', tag: 'ru-list' });
    expect(parseExtListEntry(' ext:geosite:ads ')).toEqual({ set: 'geosite', tag: 'ads' });
  });

  it.each([
    'ext:geosite',
    'ext:geosite:',
    'ext::ads',
    'ext:geosite:ads:more',
    'ext:Bad_Set:ads',
    'ext:geosite.dat:ads',
    'ext:geosite:ads@cn',
    'ext:geosite:!ads',
    'ext:geosite:a/b',
    'ext-domain:geosite:ads',
    'xext:geosite:ads',
    'geosite:ads',
    'example.com',
    `ext:${'a'.repeat(33)}:ads`,
  ])('is not a link: %s', (e) => {
    expect(parseExtListEntry(e)).toBeNull();
  });

  it('hasExtEntries sees anything that starts like a link', () => {
    expect(hasExtEntries(lists({ proxy: ['example.com', 'ext:x:y'] }))).toBe(true);
    expect(hasExtEntries(lists({ proxy: ['example.com', 'geosite:ads'] }))).toBe(false);
  });
});

describe('expandExtLists', () => {
  it('replaces a link with the category\'s domains, xray prefixes, other entries and order kept', async () => {
    await set('mine', 'geosite', 'upload', sites);
    const l = log();
    const out = await expandExtLists(lists({ direct: ['x.example', 'ext:mine:ru-list', 'y.example'], block: ['b.example'] }), GEO, l);
    expect(out.block).toEqual(['b.example']);
    expect(out.direct[0]).toBe('x.example');
    expect(out.direct.at(-1)).toBe('y.example');
    expect(out.direct.slice(1, -1).sort()).toEqual(['domain:a.example.ru', 'full:www.b.example.ru', 'keyword:kw', 'regexp:^r\\d+\\.example$']);
    expect(l.warn).not.toHaveBeenCalled();
  });

  it('is the same object while the panel does not serve, or with no link', async () => {
    const l = lists({ direct: ['ext:mine:ru-list'] });
    expect(await expandExtLists(l, null)).toBe(l);
    const plain = lists({ direct: ['a.example'] });
    expect(await expandExtLists(plain, GEO)).toBe(plain);
  });

  it.each([
    ['a set that is not there', 'ext:nope:ru-list'],
    ['a category that is not there', 'ext:mine:nope'],
    ['a geoip set', 'ext:ips:ru-list'],
    ['a set with no verified version', 'ext:empty:ru-list'],
    ['a spelling that is not a link', 'ext:mine:ru-list@cn'],
  ])('%s: left out of every bucket, logged', async (_n, entry) => {
    await set('mine', 'geosite', 'upload', sites);
    await set('ips', 'geoip', 'upload', datFile(geoip('RU-LIST', cidr([10, 0, 0, 0], 8))));
    await prisma.geoSet.create({ data: { name: 'empty', kind: 'geosite', sourceType: 'upload' } });
    const l = log();
    const out = await expandExtLists(lists({ direct: [entry, 'keep.example'], proxy: [entry], block: [entry] }), GEO, l);
    expect(out).toEqual(lists({ direct: ['keep.example'] }));
    expect(l.warn).toHaveBeenCalledTimes(3);
  });

  it('a broken set is not served', async () => {
    await set('mine', 'geosite', 'upload', sites);
    await prisma.geoSet.update({ where: { name: 'mine' }, data: { status: 'broken' } });
    expect(await expandExtLists(lists({ direct: ['ext:mine:ru-list'] }), GEO, log())).toEqual(lists({}));
  });

  it('a category over the limit is dropped with a log entry; one at the limit stays', async () => {
    const many = (n: number) => site('BIG', ...Array.from({ length: n }, (_, i) => domain(FULL, `h${i}.example`)));
    await set('big', 'geosite', 'upload', datFile(many(EXT_LIST_MAX_ENTRIES + 1), site('EDGE', ...Array.from({ length: EXT_LIST_MAX_ENTRIES }, (_, i) => domain(FULL, `e${i}.example`)))));
    const l = log();
    const out = await expandExtLists(lists({ direct: ['ext:big:big', 'ext:big:edge'] }), GEO, l);
    expect(out.direct).toHaveLength(EXT_LIST_MAX_ENTRIES);
    expect(out.direct[0]).toBe('full:e0.example');
    expect(l.warn).toHaveBeenCalledTimes(1);
    expect(l.warn.mock.calls[0]![0]).toMatchObject({ entry: 'ext:big:big', entries: EXT_LIST_MAX_ENTRIES + 1, limit: EXT_LIST_MAX_ENTRIES });
    // Asked again: the same answer, from the memo.
    const again = log();
    expect((await expandExtLists(lists({ direct: ['ext:big:big'] }), GEO, again)).direct).toEqual([]);
    expect(again.warn).toHaveBeenCalledTimes(1);
  });
});

describe('singboxExtRefs', () => {
  it('a link to a served category is the .srs of the panel, per list, no limit', async () => {
    await set('geosite', 'geosite', 'builtin', sites);
    await set('mine', 'geosite', 'upload', sites);
    const out = await singboxExtRefs(
      lists({ direct: ['ext:geosite:other', 'ext:mine:ru-list', 'ext:mine:ru-list'], block: ['ext:mine:other'], proxy: ['plain.example'] }),
      GEO,
      log(),
    );
    expect(out).toEqual([
      { bucket: 'block', tag: 'iceslab-mine.other', url: 'https://p.example.com/geo/T/iceslab-mine.other.srs' },
      { bucket: 'direct', tag: 'geosite-other', url: 'https://p.example.com/geo/T/geosite-other.srs' },
      { bucket: 'direct', tag: 'iceslab-mine.ru-list', url: 'https://p.example.com/geo/T/iceslab-mine.ru-list.srs' },
    ]);
  });

  it('no sing-box on the panel, no set, no category, a geoip set: nothing, logged', async () => {
    await set('mine', 'geosite', 'upload', sites);
    await set('ips', 'geoip', 'upload', datFile(geoip('RU-LIST', cidr([10, 0, 0, 0], 8))));
    const l = log();
    expect(await singboxExtRefs(lists({ direct: ['ext:mine:ru-list'] }), NO_SRS, l)).toEqual([]);
    expect(await singboxExtRefs(lists({ direct: ['ext:nope:a', 'ext:mine:nope', 'ext:ips:ru-list'] }), GEO, l)).toEqual([]);
    expect(l.warn).toHaveBeenCalledTimes(4);
    expect(await singboxExtRefs(lists({ direct: ['ext:mine:ru-list'] }), null, l)).toEqual([]);
  });
});
