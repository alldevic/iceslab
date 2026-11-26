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
const { FULL, PLAIN, ROOT, datFile, domain, site } = await import('../../../tests/helpers/geo-dat.js');
const { ingestGeoFile } = await import('../geo-sets/geo-sets.store.js');
const { geoArtifactBaseUrl } = await import('../geo-sets/geo-public-url.js');
const { resetServedTagMemo } = await import('../geo-sets/geo-self-host.js');
const { resetExtListMemo } = await import('../geo-sets/geo-ext-lists.js');

/**
 * `ext:<set>:<category>` in the operator's domain lists, through the route with GEO_SELF_HOST on (milestone 10.6).
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
  resetExtListMemo();
  token = await registerAndLogin(app);
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});


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
const put = (payload: object) =>
  app.inject({ method: 'PUT', url: '/api/settings', headers: { authorization: `Bearer ${token}` }, payload });
const lists = (direct: string[], extra: Partial<Record<'proxy' | 'block', string[]>> = {}) => ({
  subscriptionCustomDomainLists: { direct, proxy: [], block: [], ...extra },
});
const fetchSub = (t: string, format: string) => app.inject({ method: 'GET', url: `/sub/${t}?format=${format}` });
async function custom(name: string, bytes: Uint8Array) {
  const s = await prisma.geoSet.create({ data: { name, kind: 'geosite', sourceType: 'upload' }, select: { id: true } });
  const out = await ingestGeoFile(s.id, { bytes });
  if (out.status !== 'verified') throw new Error('fixture');
}
const cat = datFile(site('MY-LIST', domain(ROOT, 'a.example.ru'), domain(FULL, 'www.b.example.ru'), domain(PLAIN, 'kw')));

describe('GET /sub/:token, ext: links in the custom domain lists, flag on', () => {
  it('xray-json (document and array) and xkeen carry the category\'s domains in place of the link', async () => {
    await custom('mine', cat);
    expect((await put(lists(['keep.example', 'ext:mine:my-list']))).statusCode).toBe(200);
    const t = await user();
    for (const f of ['xrayjson', 'xrayjson-array', 'xkeen']) {
      const body = (await fetchSub(t, f)).body;
      expect(body, f).not.toContain('ext:');
      for (const d of ['keep.example', 'domain:a.example.ru', 'full:www.b.example.ru', 'keyword:kw']) expect(body, f).toContain(d);
    }
  });

  it('clash: rules with the type of each prefix', async () => {
    await custom('mine', cat);
    await put(lists(['ext:mine:my-list']));
    const body = (await fetchSub(await user(), 'mihomo')).body;
    expect(body).not.toContain('ext:');
    expect(body).toContain('DOMAIN-SUFFIX,a.example.ru,DIRECT');
    expect(body).toContain('DOMAIN,www.b.example.ru,DIRECT');
    expect(body).toContain('DOMAIN-KEYWORD,kw,DIRECT');
  });

  it('sing-box: the category is a remote rule-set of the panel, routed to the list\'s exit', async () => {
    await custom('mine', cat);
    await put(lists(['ext:mine:my-list']));
    const cfg = JSON.parse((await fetchSub(await user(), 'singbox')).body) as { route: { rules: object[]; rule_set: object[] } };
    expect(cfg.route.rule_set).toContainEqual({
      type: 'remote', tag: 'iceslab-mine.my-list', format: 'binary', url: `${geoArtifactBaseUrl()}/iceslab-mine.my-list.srs`,
    });
    expect(cfg.route.rules).toContainEqual({ rule_set: ['iceslab-mine.my-list'], action: 'route', outbound: 'direct' });
  });

  it('a link that cannot be resolved is in no format; sing-box without a binary has none either', async () => {
    await custom('mine', cat);
    await put(lists(['ext:mine:nope', 'ext:nope:my-list', 'ext:mine:my-list@cn'], { proxy: ['ext:geosite:ads'] }));
    const t = await user();
    for (const f of ['xrayjson', 'xrayjson-array', 'mihomo', 'singbox']) expect((await fetchSub(t, f)).body, f).not.toMatch(/ext:|iceslab-/);

    await put(lists(['ext:mine:my-list']));
    vi.stubEnv('SINGBOX_BIN', '/nowhere/sing-box');
    expect((await fetchSub(t, 'singbox')).body).not.toContain('iceslab-mine');
    // The domains do not need a sing-box.
    expect((await fetchSub(t, 'xrayjson')).body).toContain('domain:a.example.ru');
  });
});
