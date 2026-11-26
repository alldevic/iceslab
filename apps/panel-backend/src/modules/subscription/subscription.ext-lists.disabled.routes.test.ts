import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// GEO_SELF_HOST stays off, the default.

const { buildApp } = await import('../../app.js');
const { prisma } = await import('../../prisma.js');
const { closeRedis } = await import('../../lib/infra/redis.js');
const { cleanDatabase } = await import('../../../tests/helpers/db.js');
const { registerAndLogin } = await import('../../../tests/helpers/auth.js');
const { FULL, PLAIN, ROOT, datFile, domain, site } = await import('../../../tests/helpers/geo-dat.js');
const { ingestGeoFile } = await import('../geo-sets/geo-sets.store.js');
const { resetServedTagMemo } = await import('../geo-sets/geo-self-host.js');
const { resetExtListMemo } = await import('../geo-sets/geo-ext-lists.js');

/**
 * `ext:` links with GEO_SELF_HOST off (milestone 10.6): the subscription is the base's, the entry goes out as written.
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

describe('GET /sub/:token, ext: links in the custom domain lists, flag off', () => {
  it('the entry is sent as it is in every format that carries the lists, and sing-box has no rule-set for it', async () => {
    await custom('mine', cat);
    await put(lists(['keep.example', 'ext:mine:my-list']));
    const t = await user();
    for (const f of ['xrayjson', 'xrayjson-array', 'xkeen']) {
      const body = (await fetchSub(t, f)).body;
      expect(body, f).toContain('ext:mine:my-list');
      expect(body, f).not.toContain('a.example.ru');
    }
    expect((await fetchSub(t, 'mihomo')).body).toContain('ext:mine:my-list');
    const sb = (await fetchSub(t, 'singbox')).body;
    expect(sb).not.toMatch(/ext:|iceslab-|\/geo\//);
  });

  it('with the link in the lists the document is the one without it, but for the link', async () => {
    await custom('mine', cat);
    const t = await user();
    await put(lists(['keep.example']));
    const sb = (await fetchSub(t, 'singbox')).body;
    await put(lists(['keep.example', 'ext:mine:my-list']));
    expect((await fetchSub(t, 'singbox')).body).toBe(sb);
  });
});
