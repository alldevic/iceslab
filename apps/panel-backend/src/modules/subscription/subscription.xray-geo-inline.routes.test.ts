import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Read when config.ts is first imported; the switch off is the .off. file next to this one.
vi.stubEnv('SUBSCRIPTION_XRAY_GEO_INLINE', 'true');

const { buildApp } = await import('../../app.js');
const { prisma } = await import('../../prisma.js');
const { closeRedis } = await import('../../lib/infra/redis.js');
const { cleanDatabase } = await import('../../../tests/helpers/db.js');
const { registerAndLogin } = await import('../../../tests/helpers/auth.js');
const { ROOT, cidr, datFile, domain, geoip, site } = await import('../../../tests/helpers/geo-dat.js');
const { ingestGeoFile } = await import('../geo-sets/geo-sets.store.js');
const { resetServedTagMemo } = await import('../geo-sets/geo-self-host.js');
const { resetPresetGeoInlineMemo } = await import('../geo-sets/geo-preset-inline.js');

/**
 * The xray-json documents as the route builds them with SUBSCRIPTION_XRAY_GEO_INLINE
 * on (milestone 12.5): the region's lists when the built-in sets can supply every
 * category, the base's document when they cannot, and never in the router form,
 * Clash or sing-box.
 */
let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  resetServedTagMemo();
  resetPresetGeoInlineMemo();
  token = await registerAndLogin(app);
});
afterEach(async () => {
  await app.close();
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
const sites = datFile(
  site('CATEGORY-ADS-ALL', domain(ROOT, 'ads.example.com')),
  site('CATEGORY-RU', domain(ROOT, 'yandex.ru')),
  site('CATEGORY-GOV-RU', domain(ROOT, 'gosuslugi.ru')),
);
const ips = datFile(geoip('RU', cidr([5, 3, 0, 0], 16)));

const REALITY = {
  security: 'reality',
  realityDest: 'www.microsoft.com:443',
  realityServerNames: ['www.microsoft.com'],
  realityPrivateKey: 'k'.repeat(43),
  realityPublicKey: 'p'.repeat(43),
  realityShortIds: ['0123abcd'],
  subprotocol: 'vless',
  network: 'raw',
};

async function user(): Promise<string> {
  const auth = { authorization: `Bearer ${token}` };
  const node = await app.inject({ method: 'POST', url: '/api/nodes', headers: auth, payload: { name: 'eu-1', address: 'eu1.test', protocol: 'xray' } });
  const profile = await app.inject({ method: 'POST', url: '/api/profiles', headers: auth, payload: { name: 'x', protocol: 'xray', config: REALITY } });
  const binding = await app.inject({
    method: 'POST',
    url: '/api/bindings',
    headers: auth,
    payload: { profileId: JSON.parse(profile.body).id, nodeId: JSON.parse(node.body).id, port: 443 },
  });
  expect(binding.statusCode, binding.body).toBe(201);
  const u = await app.inject({ method: 'POST', url: '/api/users', headers: auth, payload: { username: 'alice' } });
  return (JSON.parse(u.body) as { subscriptionToken: string }).subscriptionToken;
}
const sub = async (t: string, format: string, routing = 'ru-split') =>
  (await app.inject({ method: 'GET', url: `/sub/${t}?format=${format}&routing=${routing}` })).body;

describe('GET /sub/:token with the switch on', () => {
  it('sets verified: xrayjson and the array carry the lists, no geo names, no ad rule', async () => {
    await builtin('geosite', sites);
    await builtin('geoip', ips);
    const t = await user();
    const single = await sub(t, 'xrayjson');
    const array = await sub(t, 'xrayjson-array');
    for (const body of [single, array]) {
      expect(body).toContain('domain:yandex.ru');
      expect(body).toContain('domain:gosuslugi.ru');
      expect(body).toContain('5.3.0.0/16');
      expect(body).not.toMatch(/geosite:|geoip:/);
      // The `block` outbound stays in the frame; no rule sends anything to it.
      expect(body).not.toContain('"outboundTag": "block"');
      expect(body).not.toContain('"outboundTag":"block"');
    }
  });

  it('the router form (xkeen), Clash and sing-box are the same as without the sets', async () => {
    const t = await user();
    const before = await Promise.all(['xkeen', 'mihomo', 'singbox'].map((f) => sub(t, f)));
    await builtin('geosite', sites);
    await builtin('geoip', ips);
    const after = await Promise.all(['xkeen', 'mihomo', 'singbox'].map((f) => sub(t, f)));
    expect(after).toEqual(before);
    expect(before[0]).toContain('geosite:category-ru');
  });

  it('proxy-all is the same as without the sets', async () => {
    const t = await user();
    const before = await sub(t, 'xrayjson', 'proxy-all');
    await builtin('geosite', sites);
    await builtin('geoip', ips);
    expect(await sub(t, 'xrayjson', 'proxy-all')).toBe(before);
  });

  it('no data: a set not verified, or a category missing, gives the base\'s document', async () => {
    const t = await user();
    const base = await sub(t, 'xrayjson');
    const baseArray = await sub(t, 'xrayjson-array');
    expect(base).toContain('geosite:category-ads-all');
    await prisma.geoSet.create({ data: { name: 'geosite', kind: 'geosite', sourceType: 'builtin' } });
    await builtin('geoip', ips);
    expect(await sub(t, 'xrayjson')).toBe(base);
    await prisma.geoSet.delete({ where: { name: 'geosite' } });
    await builtin('geosite', datFile(site('CATEGORY-RU', domain(ROOT, 'yandex.ru'))));
    resetServedTagMemo();
    expect(await sub(t, 'xrayjson')).toBe(base);
    expect(await sub(t, 'xrayjson-array')).toBe(baseArray);
  });
});
