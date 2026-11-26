import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';

// Read when config.ts is first imported; the disabled case has its own file.
vi.stubEnv('GEO_SELF_HOST', 'true');
vi.stubEnv('RATE_LIMIT_GEO_PER_MIN', '6');

const { buildApp } = await import('../../app.js');
const { prisma } = await import('../../prisma.js');
const { closeRedis } = await import('../../lib/infra/redis.js');
const { cleanDatabase } = await import('../../../tests/helpers/db.js');
const { ROOT, cidr, datFile, domain, geoip, site } = await import('../../../tests/helpers/geo-dat.js');
const { ingestGeoFile, buildCompositeSet } = await import('./geo-sets.store.js');
const { geoArtifactToken } = await import('./geo-public-url.js');
const { geoPublicCacheStats, resetGeoPublicCache } = await import('./geo-public-cache.js');

/** GET /geo/:token/:name (milestone 10.4) with the flag on. */
let app: FastifyInstance;
const TOKEN = geoArtifactToken();

const dat = (...codes: string[]) => datFile(...codes.map((c) => site(c, domain(ROOT, `${c.toLowerCase()}.example.com`))));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  resetGeoPublicCache();
});
afterEach(async () => {
  await app.close();
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

describe('serving', () => {
  it('a built-in set under its node name: the body is the blob, the ETag is the version sha256', async () => {
    const bytes = dat('ADS', 'RU');
    await set('geosite', bytes, { sourceType: 'builtin' });
    const res = await get(`/geo/${TOKEN}/geosite.dat`);
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe(`"${sha(bytes)}"`);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-length']).toBe(String(bytes.length));
    expect(res.headers['cache-control']).toBe('public, no-cache');
    expect(res.headers['content-encoding']).toBeUndefined();
    const blob = await prisma.geoBlob.findUniqueOrThrow({ where: { sha256: sha(bytes) } });
    expect(Buffer.compare(res.rawPayload, Buffer.from(blob.data))).toBe(0);
  });

  it('geoip.dat, an operator set and a composite set under iceslab-<name>.dat', async () => {
    const ip = datFile(geoip('RU', cidr([10, 1, 2, 0], 24)));
    await set('geoip', ip, { sourceType: 'builtin', kind: 'geoip' });
    await set('mylist', dat('ADS'));
    const comp = await prisma.geoSet.create({
      data: {
        name: 'ads-all',
        kind: 'geosite',
        sourceType: 'composite',
        compositeDef: [{ name: 'ads', refs: [{ set: 'mylist', tag: 'ads' }], manual: [], exclude: [], enabled: true }],
      },
      select: { id: true },
    });
    const out = await buildCompositeSet(comp.id);
    expect(out, JSON.stringify(out)).toMatchObject({ status: 'verified' });
    for (const name of ['geoip.dat', 'iceslab-mylist.dat', 'iceslab-ads-all.dat']) {
      expect((await get(`/geo/${TOKEN}/${name}`)).statusCode, name).toBe(200);
    }
  });

  it('If-None-Match with the ETag: 304 and no body; a list and a weak tag count; another tag does not', async () => {
    const bytes = dat('ADS');
    await set('mylist', bytes);
    const url = `/geo/${TOKEN}/iceslab-mylist.dat`;
    const etag = `"${sha(bytes)}"`;
    for (const h of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
      const res = await get(url, { 'if-none-match': h });
      expect(res.statusCode, h).toBe(304);
      expect(res.rawPayload.length, h).toBe(0);
      expect(res.headers.etag, h).toBe(etag);
    }
    expect((await get(url, { 'if-none-match': '"other"' })).statusCode).toBe(200);
  });

  it('a new version of the set: a new ETag and the new bytes', async () => {
    const first = dat('ADS');
    const id = await set('mylist', first);
    const url = `/geo/${TOKEN}/iceslab-mylist.dat`;
    const a = await get(url);
    const second = dat('ADS', 'NEW');
    expect((await ingestGeoFile(id, { bytes: second })).status).toBe('verified');
    const b = await get(url, { 'if-none-match': a.headers.etag as string });
    expect(b.statusCode).toBe(200);
    expect(b.headers.etag).toBe(`"${sha(second)}"`);
    expect(b.headers.etag).not.toBe(a.headers.etag);
    expect(Buffer.compare(b.rawPayload, Buffer.from(second))).toBe(0);
  });

  it('keeps the bytes in the process: a second request does not read the table again', async () => {
    await set('mylist', dat('ADS'));
    const spy = vi.spyOn(prisma.geoBlob, 'findUnique');
    await get(`/geo/${TOKEN}/iceslab-mylist.dat`);
    await get(`/geo/${TOKEN}/iceslab-mylist.dat`);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(geoPublicCacheStats().files).toBe(1);
    spy.mockRestore();
  });
});

describe('what is not served: one 404, the same body', () => {
  it('no token, a wrong token, an unknown name, traversal, a rule-set json, a built-in under the operator spelling, no version, a broken set', async () => {
    await set('mylist', dat('ADS'));
    await set('geosite', dat('RU'), { sourceType: 'builtin' });
    await prisma.geoSet.create({ data: { name: 'empty', kind: 'geosite', sourceType: 'upload' } });
    const broken = await set('bad', dat('ADS'));
    await prisma.geoSet.update({ where: { id: broken }, data: { status: 'broken', error: 'x' } });

    const urls = [
      `/geo/geosite.dat`,
      `/geo//geosite.dat`,
      `/geo/${TOKEN.slice(0, 31)}x/geosite.dat`,
      `/geo/nope/iceslab-mylist.dat`,
      `/geo/${TOKEN}/nothing.dat`,
      `/geo/${TOKEN}/iceslab-unknown.dat`,
      `/geo/${TOKEN}/..%2F..%2Fetc%2Fpasswd`,
      `/geo/${TOKEN}/..%2Fgeosite.dat`,
      `/geo/${TOKEN}/%2e%2e/geosite.dat`,
      `/geo/${TOKEN}/iceslab-mylist.json`,
      `/geo/${TOKEN}/iceslab-geosite.dat`,
      `/geo/${TOKEN}/iceslab-empty.dat`,
      `/geo/${TOKEN}/iceslab-bad.dat`,
      `/geo/${TOKEN}/geoip.dat`,
    ];
    const bodies = new Set<string>();
    for (const [i, url] of urls.entries()) {
      // Another address each, so the limiter (its own test) does not answer.
      const res = await app.inject({ method: 'GET', url, remoteAddress: `10.9.0.${i + 1}` });
      expect(res.statusCode, url).toBe(404);
      bodies.add(res.body);
    }
    expect(bodies.size).toBe(1);
  });
});

describe('the limit', () => {
  it('answers 429 past RATE_LIMIT_GEO_PER_MIN, wrong tokens counted', async () => {
    let last = 0;
    for (let i = 0; i < 8 && last !== 429; i++) last = (await get(`/geo/wrong-${i}/geosite.dat`)).statusCode;
    expect(last).toBe(429);
  });
});
