import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Read when config.ts is first imported; the flag off is the existing route tests.
vi.stubEnv('GEO_SELF_HOST', 'true');

const { buildApp } = await import('../../app.js');
const { prisma } = await import('../../prisma.js');
const { closeRedis } = await import('../../lib/infra/redis.js');
const { cleanDatabase } = await import('../../../tests/helpers/db.js');
const { registerAndLogin } = await import('../../../tests/helpers/auth.js');
const { ROOT, cidr, datFile, domain, geoip, site } = await import('../../../tests/helpers/geo-dat.js');
const { ingestGeoFile } = await import('../geo-sets/geo-sets.store.js');
const { geoArtifactBaseUrl } = await import('../geo-sets/geo-public-url.js');
const { resetServedTagMemo } = await import('../geo-sets/geo-self-host.js');

/**
 * The subscription as the route builds it with GEO_SELF_HOST on (milestone 10.5):
 * mihomo and sing-box learn the panel's addresses, with the checks the formats
 * make. The panel's built-in sets here hold the ru-split tags, but for gov-ru.
 */
let app: FastifyInstance;
let token: string;

const work = mkdtempSync(join(tmpdir(), 'iceslab-sub-geo-'));
const BIN = join(work, 'sing-box');
writeFileSync(BIN, '#!/bin/sh\nexit 0\n');
chmodSync(BIN, 0o755);

beforeEach(async () => {
  vi.stubEnv('SINGBOX_BIN', BIN);
  app = await buildApp();
  await cleanDatabase();
  resetServedTagMemo();
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
const siteSet = (...codes: string[]) => datFile(...codes.map((c) => site(c, domain(ROOT, `${c.toLowerCase()}.example.com`))));
const ipSet = datFile(geoip('RU', cidr([10, 0, 0, 0], 8)));

async function user(): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/users', headers: { authorization: `Bearer ${token}` }, payload: { username: 'alice' } });
  const body = JSON.parse(res.body) as { subscriptionToken: string };
  const node = await app.inject({ method: 'POST', url: '/api/nodes', headers: { authorization: `Bearer ${token}` }, payload: { name: 'eu-1', address: '10.0.0.1:8443' } });
  const profile = await app.inject({ method: 'POST', url: '/api/profiles', headers: { authorization: `Bearer ${token}` }, payload: { name: 'hy', protocol: 'hysteria', config: {} } });
  await app.inject({
    method: 'POST',
    url: '/api/bindings',
    headers: { authorization: `Bearer ${token}` },
    payload: { profileId: JSON.parse(profile.body).id, nodeId: JSON.parse(node.body).id, port: 443 },
  });
  return body.subscriptionToken;
}
const sub = (t: string, format: string) => app.inject({ method: 'GET', url: `/sub/${t}?format=${format}&routing=ru-split` });
const ruSplit = ['ADS', 'CATEGORY-ADS-ALL', 'CATEGORY-RU', 'CATEGORY-GOV-RU'];

describe('GET /sub/:token with the flag on', () => {
  it('sing-box: the rule-sets the panel has are its addresses, the one it lacks stays on GitHub', async () => {
    await builtin('geosite', siteSet('CATEGORY-ADS-ALL', 'CATEGORY-RU'));
    await builtin('geoip', ipSet);
    const t = await user();
    const cfg = JSON.parse((await sub(t, 'singbox')).body) as { route: { rule_set: { tag: string; url: string }[] } };
    const u = Object.fromEntries(cfg.route.rule_set.map((r) => [r.tag, r.url]));
    const base = geoArtifactBaseUrl();
    expect(base).toContain('/geo/');
    expect(u['geosite-category-ads-all']).toBe(`${base}/geosite-category-ads-all.srs`);
    expect(u['geosite-category-ru']).toBe(`${base}/geosite-category-ru.srs`);
    expect(u['geoip-ru']).toBe(`${base}/geoip-ru.srs`);
    expect(u['geosite-category-gov-ru']).toMatch(/^https:\/\/raw\.githubusercontent\.com\/SagerNet\/sing-geosite\//);
  });

  it('sing-box: no sing-box on the panel, every address is the base\'s', async () => {
    await builtin('geosite', siteSet(...ruSplit));
    await builtin('geoip', ipSet);
    vi.stubEnv('SINGBOX_BIN', '/nowhere/sing-box');
    const t = await user();
    const cfg = JSON.parse((await sub(t, 'singbox')).body) as { route: { rule_set: { url: string }[] } };
    for (const r of cfg.route.rule_set) expect(r.url).toMatch(/^https:\/\/raw\.githubusercontent\.com\//);
  });

  it('mihomo: every tag in the panel sets, geox-url is the panel\'s; one missing, the base\'s whole', async () => {
    await builtin('geosite', siteSet(...ruSplit));
    await builtin('geoip', ipSet);
    const t = await user();
    const ok = (await sub(t, 'mihomo')).body;
    expect(ok).toContain(`geosite: "${geoArtifactBaseUrl()}/geosite.dat"`);
    expect(ok).toContain('geodata-mode: true');
    expect(ok).not.toContain('jsdelivr');

    await prisma.geoSet.deleteMany({ where: { name: 'geosite' } });
    await builtin('geosite', siteSet('CATEGORY-ADS-ALL'));
    resetServedTagMemo();
    const lacking = (await sub(t, 'mihomo')).body;
    expect(lacking).toContain('testingcf.jsdelivr.net');
    expect(lacking).not.toContain('/geo/');
  });

  it('the other formats do not know of it: the subscription is the base', async () => {
    await builtin('geosite', siteSet(...ruSplit));
    await builtin('geoip', ipSet);
    const t = await user();
    for (const f of ['xrayjson', 'plain', 'json']) {
      const res = await app.inject({ method: 'GET', url: `/sub/${t}?format=${f}` });
      expect(res.body).not.toContain('/geo/');
    }
  });
});
