import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

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
 * off (milestone 12.5, the default): the base's, whatever the sets hold.
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

describe('GET /sub/:token with the switch off (the default)', () => {
  it('verified sets change nothing: every xray-json document is the same as without them', async () => {
    const t = await user();
    const formats = ['xrayjson', 'xrayjson-array', 'xkeen'];
    const before = await Promise.all(formats.map((f) => sub(t, f)));
    await builtin('geosite', sites);
    await builtin('geoip', ips);
    expect(await Promise.all(formats.map((f) => sub(t, f)))).toEqual(before);
    for (const body of before) expect(body).toContain('geosite:category-ru');
    expect(before[0]).toContain('geosite:category-ads-all');
  });
});
