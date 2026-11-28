// A setting that already exists follows the code, not the row it was born as.
//
// `isPublic` was written only in the `create` branch of the settings upsert.
// The comment above PUBLIC_KEYS says "flip `isPublic` per key", which reads as
// though editing that set were enough - and it is, exactly once, on an install
// where the row does not exist yet. For every panel that has already written
// the key, the visibility it was born with is the visibility it keeps.
//
// Both directions cost something real, and `/api/settings/public` is
// deliberately unauthenticated: a key taken OUT of PUBLIC_KEYS because it leaked
// keeps being served; a key put IN never becomes readable by the SPA that needs
// it before anyone has logged in. The tests seed a row in the wrong state, which
// is what an upgraded install looks like.

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { getSubscriptionSettings, invalidateSubscriptionSettingsCache } from './settings.service.js';
import { makeNode, makeSquad } from '../../../tests/helpers/preset-nodes.js';

let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  token = await registerAndLogin(app);
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

const auth = () => ({ authorization: `Bearer ${token}` });

async function put(payload: Record<string, unknown>) {
  const res = await app.inject({ method: 'PUT', url: '/api/settings', headers: auth(), payload });
  expect(res.statusCode, res.body).toBeLessThan(300);
  return JSON.parse(res.body);
}

const readPublic = () => app.inject({ method: 'GET', url: '/api/settings/public' });

describe('a setting that already exists follows the code, not the row it was born as', () => {
  it('stops serving a key that is no longer public', async () => {
    // `brandName` is the only public key, so any other key standing marked
    // public is one the code says must not be served.
    await prisma.appSetting.create({
      data: { key: 'subscriptionSupportUrl', value: 'https://old.example.com', isPublic: true },
    });

    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: auth(),
      payload: { subscriptionSupportUrl: 'https://support.example.com/help' },
    });
    expect(put.statusCode).toBe(200);

    // The control: the write did land, so this is about visibility and not
    // about a PUT that quietly did nothing.
    const all = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/settings', headers: auth() })).body,
    );
    expect(all.subscriptionSupportUrl).toBe('https://support.example.com/help');

    const pub = JSON.parse((await app.inject({ method: 'GET', url: '/api/settings/public' })).body);
    expect(
      pub,
      'an operator support URL is served to anyone who asks, on every panel that wrote the key before it was made private',
    ).not.toHaveProperty('subscriptionSupportUrl');
  });

  it('starts serving a key that has become public', async () => {
    await prisma.appSetting.create({
      data: { key: 'brandName', value: 'Old Brand', isPublic: false },
    });

    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: auth(),
      payload: { brandName: 'New Brand' },
    });
    expect(put.statusCode).toBe(200);

    const pub = JSON.parse((await app.inject({ method: 'GET', url: '/api/settings/public' })).body);
    expect(pub.brandName).toBe('New Brand');
  });
});

describe('the public door stays open', () => {
  // The login screen renders the brand before there is a session to check, so
  // an accidental `requireAuth` here is an empty page for every visitor.
  it('answers without a token', async () => {
    await put({ brandName: 'Iceslab Lab' });
    const res = await readPublic();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).brandName).toBe('Iceslab Lab');
  });

  it('answers an empty object before anything is configured', async () => {
    const res = await readPublic();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({});
  });
});

describe('the public door stays narrow', () => {
  // Everything written here through the admin route in one go; only the brand
  // is on the public list.
  it('serves the public keys and none of the operator ones', async () => {
    await put({
      brandName: 'Iceslab Lab',
      subscriptionSupportUrl: 'https://support.internal.example.com',
      subscriptionAnnounceTemplate: 'internal notice {{DAYS_LEFT}}',
      subscriptionProfileTitle: 'Internal profile title',
      subscriptionEntryPoolSize: 3,
    });

    const body = JSON.parse((await readPublic()).body);

    expect(body).toEqual({ brandName: 'Iceslab Lab' });
    for (const leaked of [
      'subscriptionSupportUrl',
      'subscriptionAnnounceTemplate',
      'subscriptionProfileTitle',
      'subscriptionEntryPoolSize',
    ]) {
      expect(body, `${leaked} reached an unauthenticated caller`).not.toHaveProperty(leaked);
    }
  });

  // The filter is on the column, not on a list consulted at read time. A row
  // written by a migration, a fixture or a future writer is judged by its own
  // flag - so a key nobody thought about is private by default.
  it('hides a row that was never marked public, whatever it is called', async () => {
    await prisma.appSetting.create({
      data: { key: 'someFutureSecret', value: 'do-not-publish', isPublic: false },
    });
    await prisma.appSetting.create({
      data: { key: 'someFutureBanner', value: 'publish-me', isPublic: true },
    });

    const body = JSON.parse((await readPublic()).body);
    expect(body).not.toHaveProperty('someFutureSecret');
    expect(body.someFutureBanner, 'the flag is what decides, in both directions').toBe('publish-me');
  });
});

describe('the admin door stays locked', () => {
  it('refuses to read or write the whole table without a session', async () => {
    await put({ brandName: 'Iceslab Lab', subscriptionSupportUrl: 'https://s.example.com' });

    const read = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(read.statusCode).toBe(401);

    const write = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { brandName: 'hijacked' },
    });
    expect(write.statusCode).toBe(401);

    // And the refused write changed nothing.
    const after = JSON.parse((await readPublic()).body);
    expect(after.brandName).toBe('Iceslab Lab');
  });

  it('serves the whole table to an authenticated admin', async () => {
    await put({ brandName: 'Iceslab Lab', subscriptionSupportUrl: 'https://s.example.com' });
    const res = await app.inject({ method: 'GET', url: '/api/settings', headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.brandName).toBe('Iceslab Lab');
    expect(
      body.subscriptionSupportUrl,
      'the admin view is the one place the operator settings are readable',
    ).toBe('https://s.example.com/'); // stored in header form (A-168), hence the slash
  });

  it('reports exactly the keys it wrote', async () => {
    const body = await put({ brandName: 'Iceslab Lab', subscriptionUpdateIntervalHours: 12 });
    expect(body.ok).toBe(true);
    expect([...body.updated].sort()).toEqual(['brandName', 'subscriptionUpdateIntervalHours']);
  });

  it('refuses a value the schema does not accept', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: auth(),
      payload: { subscriptionUpdateIntervalHours: 0 },
    });
    expect(res.statusCode, 'a poll interval of zero would make every client hammer /sub').toBe(400);
  });
});

describe('the panel-wide DNS rules (19.2)', () => {
  beforeEach(() => invalidateSubscriptionSettingsCache());
  const RULES = [{ match: ['domain:corp.example'], server: 'tcp://10.0.0.1', note: 'office' }];
  const readAdmin = async () =>
    JSON.parse((await app.inject({ method: 'GET', url: '/api/settings', headers: auth() })).body);

  it('is saved, read back, and none on a panel that never set it', async () => {
    expect((await getSubscriptionSettings()).dnsRules).toEqual([]);
    expect((await readAdmin()).subscriptionDnsRules).toBeNull();
    await put({ subscriptionDnsRules: RULES });
    expect((await readAdmin()).subscriptionDnsRules).toEqual(RULES);
    expect((await getSubscriptionSettings()).dnsRules).toEqual(RULES);
    await put({ subscriptionDnsRules: null });
    expect((await getSubscriptionSettings()).dnsRules).toEqual([]);
  });

  it('refuses what a preset refuses, with the same codes', async () => {
    const send = (rules: unknown) => app.inject({ method: 'PUT', url: '/api/settings', headers: auth(), payload: { subscriptionDnsRules: rules } });
    const name = await send([{ match: ['keyword:x'], server: '10.0.0.1' }]);
    expect(name.statusCode).toBe(400);
    expect(JSON.parse(name.body)).toMatchObject({ error: 'ROUTING_PRESET_DNS_MATCH_INVALID', entries: ['keyword:x'] });
    const server = await send([{ match: ['corp.example'], server: 'udp://10.0.0.1' }]);
    expect(JSON.parse(server.body)).toMatchObject({ error: 'ROUTING_PRESET_DNS_SERVER_INVALID' });
    const rule = { match: ['corp.example'], server: '10.0.0.1' };
    expect((await send(Array.from({ length: 17 }, () => rule))).statusCode).toBe(400);
    expect((await readAdmin()).subscriptionDnsRules).toBeNull();
  });

  it('a damaged stored value reads as an empty list', async () => {
    for (const bad of ['junk', { a: 1 }, [{ match: ['keyword:x'], server: '10.0.0.1' }], [{ match: ['corp.example'], server: 'nope' }], [1]]) {
      await prisma.appSetting.deleteMany({ where: { key: 'subscriptionDnsRules' } });
      await prisma.appSetting.create({ data: { key: 'subscriptionDnsRules', value: bad as object, isPublic: false } });
      invalidateSubscriptionSettingsCache();
      expect((await getSubscriptionSettings()).dnsRules, JSON.stringify(bad)).toEqual([]);
    }
  });
});

describe('the wg config settings (9.8)', () => {
  beforeEach(() => invalidateSubscriptionSettingsCache());

  const readAdmin = async () =>
    JSON.parse((await app.inject({ method: 'GET', url: '/api/settings', headers: auth() })).body);

  it('stores a DNS list and the ::/0 switch, and reads them back', async () => {
    await put({ subscriptionWgDns: ['1.1.1.1', '2606:4700:4700::1111'], subscriptionWgDropIpv6: true });
    const body = await readAdmin();
    expect(body.subscriptionWgDns).toEqual(['1.1.1.1', '2606:4700:4700::1111']);
    expect(body.subscriptionWgDropIpv6).toBe(true);
    const settings = await getSubscriptionSettings();
    expect(settings.wgDns).toEqual(['1.1.1.1', '2606:4700:4700::1111']);
    expect(settings.wgDropIpv6).toBe(true);
  });

  it('is empty and off on a panel that never set them', async () => {
    const settings = await getSubscriptionSettings();
    expect(settings.wgDns).toEqual([]);
    expect(settings.wgDropIpv6).toBe(false);
  });

  it('refuses a DNS entry that is not an IP address, and more than four', async () => {
    for (const bad of [['dns.example.com'], ['1.1.1.1', 'nope'], ['1.1.1.1\nPostUp = x'], ['999.1.1.1'], ['1.1.1.1/32'], ['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', '9.9.9.9']]) {
      const res = await app.inject({ method: 'PUT', url: '/api/settings', headers: auth(), payload: { subscriptionWgDns: bad } });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await readAdmin()).subscriptionWgDns).toBeNull();
  });

  it('busts the cache on write and clears with null', async () => {
    await put({ subscriptionWgDns: ['9.9.9.9'] });
    expect((await getSubscriptionSettings()).wgDns).toEqual(['9.9.9.9']);
    await put({ subscriptionWgDns: null });
    expect((await getSubscriptionSettings()).wgDns).toEqual([]);
  });

  it('a hand-edited row cannot put anything but an IP into a config', async () => {
    await prisma.appSetting.create({
      data: { key: 'subscriptionWgDns', value: ['1.1.1.1', 'x\nPostUp = rm', 5, '8.8.8.8'], isPublic: false },
    });
    await prisma.appSetting.create({ data: { key: 'subscriptionWgDropIpv6', value: 'yes', isPublic: false } });
    invalidateSubscriptionSettingsCache();
    const settings = await getSubscriptionSettings();
    expect(settings.wgDns).toEqual(['1.1.1.1', '8.8.8.8']);
    expect(settings.wgDropIpv6).toBe(false);
  });
});

describe('19.10: the panel-wide DNS rules go to the nodes', () => {
  const rule = (name: string, server: string) => ({ match: [name], server, note: '' });
  const put = (payload: Record<string, unknown>) => app.inject({ method: 'PUT', url: '/api/settings', headers: auth(), payload });
  const carried = async (id: string) => (await prisma.node.findUniqueOrThrow({ where: { id }, select: { presetDnsRules: true } })).presetDnsRules;

  it('are written to every node, and refused when a preset on any node gives a name another server', async () => {
    const on = await makeNode();
    const idle = await makeNode({ name: 'idle-node' });
    const preset = await prisma.routingPreset.create({
      data: { name: 'Beta', dnsRules: [rule('example.com', '10.99.0.2')] },
      select: { id: true },
    });
    await makeSquad([on.id], { presetId: preset.id });
    const ok = await put({ subscriptionDnsRules: [rule('other.com', '10.99.0.9')] });
    expect(ok.statusCode, ok.body).toBe(200);
    const panel = { presetId: null, rules: [{ match: ['other.com'], server: '10.99.0.9' }] };
    expect(await carried(idle.id)).toEqual([panel]);
    // The node a preset reaches carries the preset's rule and the panel-wide one.
    expect(((await carried(on.id)) as unknown[]).length).toBe(2);

    const bad = await put({ subscriptionDnsRules: [rule('example.com', '10.99.0.1')] });
    expect(bad.statusCode, bad.body).toBe(409);
    expect(JSON.parse(bad.body)).toMatchObject({ error: 'ROUTING_PRESET_DNS_CONFLICT', preset: 'Beta', node: on.name });
    // Nothing was written: the stored rules and the nodes are as they were.
    expect((await prisma.appSetting.findUniqueOrThrow({ where: { key: 'subscriptionDnsRules' } })).value).toEqual([rule('other.com', '10.99.0.9')]);
    expect(await carried(idle.id)).toEqual([panel]);

    const cleared = await put({ subscriptionDnsRules: null });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(await carried(idle.id)).toBeNull();
  });
});

describe('19.15: an own preset as the panel default', () => {
  const rule = (name: string, server: string) => ({ match: [name], server, note: '' });
  const putRaw = (payload: Record<string, unknown>) => app.inject({ method: 'PUT', url: '/api/settings', headers: auth(), payload });
  const carried = async (id: string) => (await prisma.node.findUniqueOrThrow({ where: { id }, select: { presetDnsRules: true } })).presetDnsRules;
  const own = async (name: string, ...dnsRules: ReturnType<typeof rule>[]) =>
    (await prisma.routingPreset.create({ data: { name, dnsRules }, select: { id: true } })).id;

  it('is stored and read back, null clears it, a preset that does not exist is a 400 naming the field', async () => {
    const id = await own('Mine');
    expect((await putRaw({ subscriptionDefaultPresetId: id })).statusCode).toBe(200);
    expect((await prisma.appSetting.findUniqueOrThrow({ where: { key: 'subscriptionDefaultPresetId' } })).value).toBe(id);
    invalidateSubscriptionSettingsCache();
    expect((await getSubscriptionSettings()).defaultPresetId).toBe(id);
    const read = JSON.parse((await app.inject({ method: 'GET', url: '/api/settings', headers: auth() })).body);
    expect(read.subscriptionDefaultPresetId).toBe(id);

    const missing = await putRaw({ subscriptionDefaultPresetId: '7b0d1c1e-0000-4000-8000-000000000000' });
    expect(missing.statusCode, missing.body).toBe(400);
    expect(JSON.parse(missing.body)).toMatchObject({ error: 'ROUTING_PRESET_NOT_FOUND', field: 'subscriptionDefaultPresetId' });
    expect((await prisma.appSetting.findUniqueOrThrow({ where: { key: 'subscriptionDefaultPresetId' } })).value).toBe(id);
    expect((await putRaw({ subscriptionDefaultPresetId: 'ru-split' })).statusCode).toBe(400);

    expect((await putRaw({ subscriptionDefaultPresetId: null })).statusCode).toBe(200);
    invalidateSubscriptionSettingsCache();
    expect((await getSubscriptionSettings()).defaultPresetId).toBeNull();
  });

  it('puts the rules of the default on the nodes of squads without a preset, and takes them off when it changes', async () => {
    const [bare, held] = [await makeNode(), await makeNode()];
    const [d1, d2, q] = [await own('D1', rule('one.com', '10.99.0.1')), await own('D2', rule('two.com', '10.99.0.2')), await own('Q')];
    await makeSquad([bare.id]);
    await makeSquad([held.id], { presetId: q });
    expect((await putRaw({ subscriptionDefaultPresetId: d1 })).statusCode).toBe(200);
    expect(await carried(bare.id)).toEqual([{ presetId: d1, rules: [{ match: ['one.com'], server: '10.99.0.1' }] }]);
    expect(await carried(held.id)).toBeNull();
    expect((await putRaw({ subscriptionDefaultPresetId: d2 })).statusCode).toBe(200);
    expect(await carried(bare.id)).toEqual([{ presetId: d2, rules: [{ match: ['two.com'], server: '10.99.0.2' }] }]);
    expect((await putRaw({ subscriptionDefaultPresetId: null })).statusCode).toBe(200);
    expect(await carried(bare.id)).toBeNull();
  });

  it('a default that makes a new conflict on a node is refused with nothing written', async () => {
    const node = await makeNode({ name: 'shared-node' });
    const [d, q] = [await own('D', rule('example.com', '10.99.0.1')), await own('Q', rule('example.com', '10.99.0.2'))];
    await makeSquad([node.id], { presetId: q });
    await makeSquad([node.id]);
    const res = await putRaw({ subscriptionDefaultPresetId: d, brandName: 'Changed' });
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'ROUTING_PRESET_DNS_CONFLICT', field: 'subscriptionDefaultPresetId', preset: 'Q', node: 'shared-node' });
    expect(await prisma.appSetting.findUnique({ where: { key: 'subscriptionDefaultPresetId' } })).toBeNull();
    expect(await prisma.appSetting.findUnique({ where: { key: 'brandName' } })).toBeNull();
    expect(await carried(node.id)).toBeNull();
  });

  it('a panel-wide DNS save that repeats an already recorded conflict does not stop at it', async () => {
    const node = await makeNode({ name: 'shared-node' });
    const [a, b] = [await own('A', rule('example.com', '10.99.0.1')), await own('B', rule('example.com', '10.99.0.2'))];
    await makeSquad([node.id], { presetId: a });
    await makeSquad([node.id], { presetId: b });
    const { recomputeAfterChange } = await import('../routing-presets/routing-presets.nodes.js');
    await recomputeAfterChange();
    // One of the two was left out (which one is the older preset's business, not this test's).
    const recorded = (await prisma.node.findUniqueOrThrow({ where: { id: node.id }, select: { presetDnsConflicts: true } })).presetDnsConflicts as { kind: string; presetId: string; otherPresetId: string }[];
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.kind).toBe('conflict');
    expect([recorded[0]!.presetId, recorded[0]!.otherPresetId].sort()).toEqual([a, b].sort());
    // Panel-wide rules naming something else: 200, though A and B still clash on the node.
    expect((await putRaw({ subscriptionDnsRules: [rule('other.com', '10.99.0.9')] })).statusCode).toBe(200);
    // Panel-wide rules naming example.com with a third server meet both: a new conflict.
    const bad = await putRaw({ subscriptionDnsRules: [rule('example.com', '10.99.0.3')] });
    expect(bad.statusCode, bad.body).toBe(409);
  });
});
