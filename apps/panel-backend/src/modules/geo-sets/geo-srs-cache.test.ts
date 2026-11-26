import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { ROOT, datFile, domain, site } from '../../../tests/helpers/geo-dat.js';
import { ingestGeoFile } from './geo-sets.store.js';
import { resetGeoPublicCache } from './geo-public-cache.js';
import { GeoTagUnknownError } from './geo-dat.js';
import { geoSrsBytes, geoSrsCacheStats, resetGeoSrsCache, SRS_MAX_CONCURRENT, GEO_SRS_CACHE_MAX_BYTES } from './geo-srs-cache.js';

/** The `.srs` cache (milestone 10.5): one run per (version, kind, tag), bounded runs at once. */
let sha = '';
beforeEach(async () => {
  await cleanDatabase();
  resetGeoPublicCache();
  resetGeoSrsCache();
  const s = await prisma.geoSet.create({ data: { name: 'geosite', kind: 'geosite', sourceType: 'builtin' }, select: { id: true } });
  const dat = datFile(...['A', 'B', 'C', 'D', 'E', 'F'].map((c) => site(c, domain(ROOT, `${c.toLowerCase()}.example.com`))));
  const out = await ingestGeoFile(s.id, { bytes: dat });
  if (out.status !== 'verified') throw new Error('fixture');
  sha = (await prisma.geoSetVersion.findFirstOrThrow({ where: { geoSetId: s.id } })).sha256;
});
afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};

describe('geoSrsBytes', () => {
  it('compiles once and serves the rest from memory, by version and tag', async () => {
    let n = 0;
    const compile = async () => Buffer.from(`srs-${++n}`);
    expect((await geoSrsBytes(sha, 'geosite', 'a', compile)).toString()).toBe('srs-1');
    expect((await geoSrsBytes(sha, 'geosite', 'a', compile)).toString()).toBe('srs-1');
    expect((await geoSrsBytes(sha, 'geosite', 'b', compile)).toString()).toBe('srs-2');
    expect(n).toBe(2);
    expect(geoSrsCacheStats()).toEqual({ files: 2, bytes: 10 });
  });

  it('concurrent requests for one key share one run', async () => {
    const g = gate();
    let n = 0;
    const compile = async () => {
      n++;
      await g.p;
      return Buffer.from('x');
    };
    const all = Promise.all(Array.from({ length: 8 }, () => geoSrsBytes(sha, 'geosite', 'a', compile)));
    await new Promise((r) => setTimeout(r, 50));
    g.open();
    await all;
    expect(n).toBe(1);
  });

  it(`at most ${SRS_MAX_CONCURRENT} runs at once, the rest wait and all finish`, async () => {
    const g = gate();
    let now = 0;
    let peak = 0;
    const compile = async () => {
      peak = Math.max(peak, ++now);
      await g.p;
      now--;
      return Buffer.from('x');
    };
    const all = Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map((t) => geoSrsBytes(sha, 'geosite', t, compile)));
    await new Promise((r) => setTimeout(r, 100));
    expect(now).toBe(SRS_MAX_CONCURRENT);
    g.open();
    await all;
    expect(peak).toBe(SRS_MAX_CONCURRENT);
    expect(geoSrsCacheStats().files).toBe(6);
  });

  it('a failure is not kept, does not hold a slot, and the next call runs again', async () => {
    let n = 0;
    const compile = async () => {
      if (++n <= SRS_MAX_CONCURRENT + 1) throw new Error('boom');
      return Buffer.from('ok');
    };
    for (let i = 0; i < SRS_MAX_CONCURRENT + 1; i++) await expect(geoSrsBytes(sha, 'geosite', 'a', compile)).rejects.toThrow('boom');
    expect((await geoSrsBytes(sha, 'geosite', 'a', compile)).toString()).toBe('ok');
  });

  it('a tag the file lacks is GeoTagUnknownError and the compiler is not run', async () => {
    let n = 0;
    await expect(geoSrsBytes(sha, 'geosite', 'zz', async () => (n++, Buffer.from('x')))).rejects.toBeInstanceOf(GeoTagUnknownError);
    expect(n).toBe(0);
  });

  it('stays under the cap: the least recently used goes first', async () => {
    const big = Buffer.alloc(Math.floor(GEO_SRS_CACHE_MAX_BYTES / 2) + 1);
    let n = 0;
    const compile = async () => (n++, big);
    await geoSrsBytes(sha, 'geosite', 'a', compile);
    await geoSrsBytes(sha, 'geosite', 'b', compile);
    expect(geoSrsCacheStats().files).toBe(1);
    await geoSrsBytes(sha, 'geosite', 'b', compile);
    expect(n).toBe(2);
    await geoSrsBytes(sha, 'geosite', 'a', compile);
    expect(n).toBe(3);
  });
});
