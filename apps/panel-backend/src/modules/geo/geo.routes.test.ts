import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { addSource } from './geo.sources.js';
import { addCategory } from './geo.categories.js';
import { encodeGeoSite, type Domain } from './geo.dat.js';
import type { DatFetcher } from './geo.fetch.js';
import { invalidateSourceCache } from './geo.sourcecache.js';
import { rebuildGeo, getGeoArtifact, invalidateGeoBuild } from './geo.registry.js';
import { geoArtifactToken } from './geo.url.js';

const GS = encodeGeoSite(
  new Map<string, Domain[]>([['YOUTUBE', [{ type: 2, value: 'youtube.com' }]]]),
);
const fetchDat: DatFetcher = async (url) => {
  if (url === 'https://example.com/gs.dat') return { status: 200, bytes: GS };
  throw new Error('unreachable in test');
};

let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  await prisma.appSetting.deleteMany({ where: { key: { in: ['geoSources', 'geoCategories'] } } });
  invalidateGeoBuild();
  invalidateSourceCache();
  token = await registerAndLogin(app);
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

async function seed(): Promise<void> {
  const src = await addSource({ name: 'syn', geositeUrl: 'https://example.com/gs.dat' });
  await addCategory({ name: 'my-block', domainRefs: [{ sourceId: src.id, category: 'youtube' }] });
  await rebuildGeo({ fetchDat }); // populate the cache so the route serves without network
}

describe('public geo distribution (/geo/:token/:name)', () => {
  it('serves an artifact unauthenticated at the capability path', async () => {
    await seed();
    const expected = (await getGeoArtifact('geo-custom.dat'))!.bytes;
    const res = await app.inject({ method: 'GET', url: `/geo/${geoArtifactToken()}/geo-custom.dat` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/octet-stream');
    expect(Uint8Array.from(res.rawPayload)).toEqual(expected);
  });

  it('serves the full-database mirror too', async () => {
    await seed();
    const res = await app.inject({ method: 'GET', url: `/geo/${geoArtifactToken()}/geosite.dat` });
    expect(res.statusCode).toBe(200);
    expect(Uint8Array.from(res.rawPayload)).toEqual(GS);
  });

  it('serves 304 for a matching If-None-Match (content-addressed ETag)', async () => {
    await seed();
    const art = (await getGeoArtifact('geo-custom.dat'))!;
    const etag = `"${art.sha256}"`;
    const res = await app.inject({
      method: 'GET',
      url: `/geo/${geoArtifactToken()}/geo-custom.dat`,
      headers: { 'if-none-match': etag },
    });
    expect(res.statusCode).toBe(304);
    expect(res.headers['etag']).toBe(etag);
    expect(res.headers['cache-control']).toContain('max-age=3600');
    expect(res.rawPayload.length).toBe(0);
  });

  it('serves the body (200) for a non-matching If-None-Match', async () => {
    await seed();
    const res = await app.inject({
      method: 'GET',
      url: `/geo/${geoArtifactToken()}/geo-custom.dat`,
      headers: { 'if-none-match': '"stale-etag"' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBeGreaterThan(0);
  });

  it('404s a wrong capability token (no oracle)', async () => {
    await seed();
    const res = await app.inject({ method: 'GET', url: `/geo/wrongtoken/geo-custom.dat` });
    expect(res.statusCode).toBe(404);
  });

  it('404s an unknown artifact name', async () => {
    await seed();
    const res = await app.inject({ method: 'GET', url: `/geo/${geoArtifactToken()}/secrets.dat` });
    expect(res.statusCode).toBe(404);
  });

  /**
   * A cold cache used to build lazily WHILE holding the connection, and a build
   * is silent end to end - no headers, no bytes. Measured against the lab panel
   * and its real source on 2026-08-29: 34.3 s to the first byte cold, 4.8 ms
   * warm. The node cancels an attempt that goes 30 s with nothing arriving, and
   * calls the fetcher under the xray adapter's restart lock, so waiting here
   * cost that node every config apply and every live user update for ~93 s and
   * still ended in failure.
   */
  it('answers a retryable 503 instead of holding the connection through a cold build', async () => {
    // No build, and the one configured source is under the reserved `.invalid`
    // TLD: the background build this kicks off dies on NXDOMAIN instead of
    // reaching for the network, and a route that WAITED for it would fail the
    // test by timing out rather than by asserting.
    await addSource({ name: 'dead', geositeUrl: 'https://geo-src.invalid/gs.dat' });
    invalidateGeoBuild();
    const res = await app.inject({ method: 'GET', url: `/geo/${geoArtifactToken()}/geosite.dat` });
    // 503, not 404: the artifact is not missing, it is not built yet, and the
    // node's fetcher retries a 5xx and gives up on a 4xx.
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('60');
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('serves normally once a build exists, and still 404s an unknown name', async () => {
    // The other side of the same branch: "not built" must not swallow "no such
    // artifact" once there IS a build.
    await seed();
    expect(
      (await app.inject({ method: 'GET', url: `/geo/${geoArtifactToken()}/geo-custom.dat` }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: `/geo/${geoArtifactToken()}/secrets.dat` }))
        .statusCode,
    ).toBe(404);
  });

});

describe('admin geo routes require auth', () => {
  it('rejects POST /api/geo/build without a token', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/geo/build', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('lists sources for an authed admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/geo/sources',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sources.length).toBeGreaterThan(0); // seeded default
  });
});

describe('source category browser', () => {
  it('lists a source\'s geosite categories with entry counts', async () => {
    const src = await addSource({ name: 'syn', geositeUrl: 'https://example.com/gs.dat' });
    await rebuildGeo({ fetchDat }); // primes the source-bytes cache for gs.dat
    const res = await app.inject({
      method: 'GET',
      url: `/api/geo/sources/${src.id}/categories`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().geosite).toEqual([{ name: 'YOUTUBE', count: 1 }]);
  });

  it('previews a category\'s entries (as xray matchers)', async () => {
    const src = await addSource({ name: 'syn', geositeUrl: 'https://example.com/gs.dat' });
    await rebuildGeo({ fetchDat });
    const res = await app.inject({
      method: 'GET',
      url: `/api/geo/sources/${src.id}/categories/geosite/youtube`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ entries: ['domain:youtube.com'], total: 1, truncated: false });
  });

  it('404s an unknown category', async () => {
    const src = await addSource({ name: 'syn', geositeUrl: 'https://example.com/gs.dat' });
    await rebuildGeo({ fetchDat });
    const res = await app.inject({
      method: 'GET',
      url: `/api/geo/sources/${src.id}/categories/geosite/nope`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
