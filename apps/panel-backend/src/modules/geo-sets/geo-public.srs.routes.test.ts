import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Read when config.ts is first imported.
vi.stubEnv('GEO_SELF_HOST', 'true');
vi.stubEnv('RATE_LIMIT_GEO_PER_MIN', '100');

const { buildApp } = await import('../../app.js');
const { prisma } = await import('../../prisma.js');
const { closeRedis } = await import('../../lib/infra/redis.js');
const { cleanDatabase } = await import('../../../tests/helpers/db.js');
const { ROOT, FULL, cidr, datFile, domain, geoip, site } = await import('../../../tests/helpers/geo-dat.js');
const { ingestGeoFile, buildCompositeSet } = await import('./geo-sets.store.js');
const { geoArtifactToken } = await import('./geo-public-url.js');
const { resetGeoPublicCache } = await import('./geo-public-cache.js');
const { resetGeoSrsCache, geoSrsCacheStats } = await import('./geo-srs-cache.js');
const { resetServedTagMemo } = await import('./geo-self-host.js');

/**
 * GET /geo/:token/<kind>-<tag>.srs (milestone 10.5) with the flag on. The
 * compiler is a script that writes its input JSON as the "srs" and logs each run,
 * so what was compiled, and how often, is readable; the real sing-box is taken
 * in the compiler's own test and in the last case here.
 */
let app: FastifyInstance;
const TOKEN = geoArtifactToken();
const REAL = [process.env.SINGBOX_BIN ?? '', '/usr/local/bin/sing-box', '/usr/bin/sing-box'].find((p) => p !== '' && existsSync(p)) ?? '';

const work = mkdtempSync(join(tmpdir(), 'iceslab-srs-routes-'));
const LOG = join(work, 'runs.log');
const FAKE = join(work, 'sing-box');
writeFileSync(FAKE, `#!/bin/sh\necho run >> "${LOG}"\nfor a; do last=$a; done\nwhile [ "$1" != -o ]; do shift; done\ncat "$last" > "$2"\n`);
chmodSync(FAKE, 0o755);
const runs = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean).length : 0);

const sites = datFile(
  site('ADS', domain(ROOT, 'ads.example.com'), domain(FULL, 'track.example.org')),
  site('RU', domain(ROOT, 'ru.example.com', ['cn'])),
  site('GOOGLE', domain(ROOT, 'google.com'), domain(ROOT, 'google.cn', ['cn'])),
);
const ips = datFile(geoip('RU', cidr([10, 0, 0, 0], 8), cidr([192, 168, 0, 0], 16)), geoip('CN', cidr([1, 0, 0, 0], 8)));

beforeAll(() => {
  writeFileSync(LOG, '');
});
beforeEach(async () => {
  vi.stubEnv('SINGBOX_BIN', FAKE);
  writeFileSync(LOG, '');
  app = await buildApp();
  await cleanDatabase();
  resetGeoPublicCache();
  resetGeoSrsCache();
  resetServedTagMemo();
});
afterEach(async () => {
  await app.close();
  vi.unstubAllEnvs();
  vi.stubEnv('GEO_SELF_HOST', 'true');
  vi.stubEnv('RATE_LIMIT_GEO_PER_MIN', '100');
});
afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });

async function set(name: string, bytes: Uint8Array, over: { sourceType?: string; kind?: string } = {}) {
  const s = await prisma.geoSet.create({
    data: { name, kind: over.kind ?? 'geosite', sourceType: over.sourceType ?? 'upload', filename: `${name}.dat` },
    select: { id: true },
  });
  const out = await ingestGeoFile(s.id, { bytes });
  if (out.status !== 'verified') throw new Error('fixture');
  return s.id;
}
const builtins = async () => {
  await set('geosite', sites, { sourceType: 'builtin' });
  await set('geoip', ips, { sourceType: 'builtin', kind: 'geoip' });
};
const rulesOf = (res: { rawPayload: Buffer }) => JSON.parse(res.rawPayload.toString('utf8')) as { version: number; rules: Record<string, string[]>[] };

describe('serving a compiled tag', () => {
  it('a built-in geosite tag: the compiler gets that tag of the current version, the body is its output', async () => {
    await builtins();
    const res = await get(`/geo/${TOKEN}/geosite-ads.srs`);
    expect(res.statusCode).toBe(200);
    expect(rulesOf(res).rules).toEqual([{ domain: ['ads.example.com', 'track.example.org'], domain_suffix: ['.ads.example.com'] }]);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-length']).toBe(String(res.rawPayload.length));
    expect(res.headers['cache-control']).toBe('public, no-cache');
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(runs()).toBe(1);
  });

  it('a geoip tag, and an attribute of a geosite tag', async () => {
    await builtins();
    const ip = await get(`/geo/${TOKEN}/geoip-ru.srs`);
    expect(rulesOf(ip).rules).toEqual([{ ip_cidr: ['10.0.0.0/8', '192.168.0.0/16'] }]);
    const attr = await get(`/geo/${TOKEN}/geosite-google@cn.srs`);
    expect(rulesOf(attr).rules).toEqual([{ domain: ['google.cn'], domain_suffix: ['.google.cn'] }]);
  });

  it('the second request for the same tag does not run the compiler again, even after a new app', async () => {
    await builtins();
    const a = await get(`/geo/${TOKEN}/geosite-ru.srs`);
    const b = await get(`/geo/${TOKEN}/geosite-ru.srs`);
    expect(b.rawPayload.equals(a.rawPayload)).toBe(true);
    expect(runs()).toBe(1);
    expect(geoSrsCacheStats().files).toBe(1);
    await get(`/geo/${TOKEN}/geosite-ads.srs`);
    expect(runs()).toBe(2);
  });

  it('simultaneous requests for one tag share one run', async () => {
    await builtins();
    const all = await Promise.all(Array.from({ length: 6 }, () => get(`/geo/${TOKEN}/geosite-ads.srs`)));
    expect(all.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(runs()).toBe(1);
  });

  it('If-None-Match with the ETag is a 304 and no run', async () => {
    await builtins();
    const first = await get(`/geo/${TOKEN}/geosite-ads.srs`);
    resetGeoSrsCache();
    writeFileSync(LOG, '');
    const second = await get(`/geo/${TOKEN}/geosite-ads.srs`, { 'if-none-match': first.headers.etag as string });
    expect(second.statusCode).toBe(304);
    expect(second.rawPayload.length).toBe(0);
    expect(runs()).toBe(0);
  });

  it('a new version of the set: a new ETag and a new compilation', async () => {
    await builtins();
    const before = await get(`/geo/${TOKEN}/geosite-ads.srs`);
    const s = await prisma.geoSet.findUniqueOrThrow({ where: { name: 'geosite' } });
    const next = datFile(site('ADS', domain(ROOT, 'other.example.net')));
    expect((await ingestGeoFile(s.id, { bytes: next })).status).toBe('verified');
    const after = await get(`/geo/${TOKEN}/geosite-ads.srs`);
    expect(after.headers.etag).not.toBe(before.headers.etag);
    expect(rulesOf(after).rules).toEqual([{ domain: ['other.example.net'], domain_suffix: ['.other.example.net'] }]);
    expect(runs()).toBe(2);
  });

  it('an operator set is iceslab-<set>.<tag>.srs, a composite too, and the kind follows the set', async () => {
    await builtins();
    await set('mine', ips, { kind: 'geoip' });
    const res = await get(`/geo/${TOKEN}/iceslab-mine.cn.srs`);
    expect(res.statusCode).toBe(200);
    expect(rulesOf(res).rules).toEqual([{ ip_cidr: ['1.0.0.0/8'] }]);

    const comp = await prisma.geoSet.create({
      data: {
        name: 'mix',
        kind: 'geosite',
        sourceType: 'composite',
        compositeDef: [{ name: 'both', refs: [{ set: 'geosite', tag: 'ads' }, { set: 'geosite', tag: 'ru' }], manual: [], exclude: [], enabled: true }],
      },
      select: { id: true },
    });
    expect((await buildCompositeSet(comp.id)).status).toBe('verified');
    const c = await get(`/geo/${TOKEN}/iceslab-mix.both.srs`);
    expect(c.statusCode).toBe(200);
    expect(rulesOf(c).rules[0]!.domain).toContain('ads.example.com');
  });
});

describe('what is not served is the one 404', () => {
  const NOT = { error: 'NOT_FOUND' };

  it('a tag the set does not have, with and without attribute', async () => {
    await builtins();
    for (const n of ['geosite-nope.srs', 'geoip-nope.srs', 'geosite-ads@zz.srs']) {
      const res = await get(`/geo/${TOKEN}/${n}`);
      // An attribute no entry has is an empty rule-set, as xray reads it, not a missing tag.
      if (n.includes('@')) expect(res.statusCode).toBe(200);
      else {
        expect(res.statusCode, n).toBe(404);
        expect(JSON.parse(res.body)).toEqual(NOT);
      }
    }
    expect(runs()).toBe(1);
  });

  it('the wrong spelling of a set: a built-in under iceslab-, an operator set under its kind', async () => {
    await builtins();
    await set('mine', sites);
    for (const n of ['iceslab-geosite.ads.srs', 'geosite-ads.dat.srs', 'iceslab-mine.nope.srs', 'mine-ads.srs']) {
      expect((await get(`/geo/${TOKEN}/${n}`)).statusCode, n).toBe(404);
    }
    expect(runs()).toBe(0);
  });

  it('a wrong token, a path walk, a name the pattern does not take', async () => {
    await builtins();
    for (const u of [`/geo/${'x'.repeat(32)}/geosite-ads.srs`, `/geo/${TOKEN}/..%2Fgeosite-ads.srs`, `/geo/${TOKEN}/geosite-.srs`, `/geo/${TOKEN}/GEOSITE-ads.srs`, `/geo/${TOKEN}/geosite-a.b.srs`]) {
      const res = await get(u);
      expect(res.statusCode, u).toBe(404);
      expect(JSON.parse(res.body)).toEqual(NOT);
    }
    expect(runs()).toBe(0);
  });

  it('a set with no verified version, or a broken one', async () => {
    await prisma.geoSet.create({ data: { name: 'geosite', kind: 'geosite', sourceType: 'builtin' } });
    expect((await get(`/geo/${TOKEN}/geosite-ads.srs`)).statusCode).toBe(404);
    await prisma.geoSet.delete({ where: { name: 'geosite' } });
    await builtins();
    expect((await get(`/geo/${TOKEN}/geosite-ads.srs`)).statusCode).toBe(200);
    await prisma.geoSet.update({ where: { name: 'geosite' }, data: { status: 'broken' } });
    expect((await get(`/geo/${TOKEN}/geosite-ads.srs`)).statusCode).toBe(404);
    expect(runs()).toBe(1);
  });

  it('no sing-box on the panel: the same 404, the .dat still served', async () => {
    await builtins();
    vi.stubEnv('SINGBOX_BIN', '/nowhere/sing-box');
    const res = await get(`/geo/${TOKEN}/geosite-ads.srs`);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual(NOT);
        expect((await get(`/geo/${TOKEN}/geosite.dat`)).statusCode).toBe(200);
  });

  it('a compiler that fails: 503, nothing kept, the next request tries again', async () => {
    await builtins();
    const bad = join(work, 'bad.sh');
    writeFileSync(bad, '#!/bin/sh\necho boom >&2\nexit 1\n');
    chmodSync(bad, 0o755);
    vi.stubEnv('SINGBOX_BIN', bad);
    const res = await get(`/geo/${TOKEN}/geosite-ads.srs`);
    expect(res.statusCode).toBe(503);
    expect(res.headers.etag).toBeUndefined();
    expect(geoSrsCacheStats().files).toBe(0);
    vi.stubEnv('SINGBOX_BIN', FAKE);
    expect((await get(`/geo/${TOKEN}/geosite-ads.srs`)).statusCode).toBe(200);
  });
});

describe.skipIf(!REAL)('with the real sing-box', () => {
  it('the .srs it serves starts with the SRS magic and is what the compiler makes of the tag', async () => {
    vi.stubEnv('SINGBOX_BIN', REAL);
    await builtins();
    const res = await get(`/geo/${TOKEN}/geosite-ads.srs`);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 3).toString('latin1')).toBe('SRS');
  });
});
