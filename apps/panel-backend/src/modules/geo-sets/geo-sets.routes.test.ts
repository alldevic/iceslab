import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { ROOT, datFile, domain, site } from '../../../tests/helpers/geo-dat.js';
import { GEO_BUILTIN } from '@iceslab/shared';
import { ingestGeoFile } from './geo-sets.store.js';
import { geoSetsQueue, enqueueDependentBuilds } from './geo-sets.queue.js';
import { replaceUploadFile } from './geo-sets.service.js';
import { eventBus } from '../../lib/infra/event-bus.js';
import { inboundSyncQueue } from '../inbounds/inbounds.queue.js';
import { registerInboundEventHandlers } from '../inbounds/inbounds.events.js';
import { chainRuleSetFileName } from './geo-refs.js';

/**
 * Phase 9.1v: /api/geo-sets as geo-contract.md section 5 draws it. The push
 * that carries a rollout to a node is phase 9.2; here a rollout moves pins.
 */
let app: FastifyInstance;
let token: string;
let queued: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  token = await registerAndLogin(app);
  // Nothing reaches the real queue: the dev backend's worker shares this
  // Redis and would pick a test's job up against the dev database.
  queued = vi.spyOn(geoSetsQueue, 'add').mockResolvedValue({} as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
});

afterAll(async () => {
  await geoSetsQueue.close();
  await inboundSyncQueue.close();
  await prisma.$disconnect();
  await closeRedis();
});

const call = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
  const res = await app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload: payload as object });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};

const lists = datFile(
  site('ADS', domain(ROOT, 'a.com')),
  site('ADULT', domain(ROOT, 'b.com')),
  site('CATEGORY-ADS', domain(ROOT, 'c.com')),
  site('RU', domain(ROOT, 'd.ru')),
);

/** An operator's set with a verified version, as an upload leaves it. */
async function verifiedSet(name = 'mylist', bytes = lists) {
  const s = await prisma.geoSet.create({
    data: { name, kind: 'geosite', sourceType: 'upload', filename: `${name}.dat` },
    select: { id: true },
  });
  const out = await ingestGeoFile(s.id, { bytes });
  if (out.status !== 'verified') throw new Error('fixture');
  return s.id;
}

async function node(name: string, extra: { policyId?: string; cores?: object; dns?: object } = {}) {
  const n = await prisma.node.create({
    data: {
      name,
      address: `${name}.example.com:1337`,
      protocol: 'xray',
      heartbeatSecret: randomBytes(32),
      ...(extra.policyId ? { policyId: extra.policyId } : {}),
      ...(extra.cores ? { cores: extra.cores } : {}),
      ...(extra.dns ? { dns: extra.dns } : {}),
    },
    select: { id: true },
  });
  return n.id;
}

async function policy(name: string, domains: string[], ips: string[] = []) {
  const p = await prisma.nodePolicy.create({
    data: {
      name,
      rules: { create: [{ position: 0, matchDomain: domains, matchIp: ips, matchProtocol: [], actionKind: 'block' }] },
    },
    select: { id: true },
  });
  return p.id;
}

describe('the list', () => {
  it('has the two built-in sets on a fresh panel, waiting for their pinned release', async () => {
    const { status, body } = await call('GET', '/api/geo-sets');
    expect(status).toBe(200);
    expect(body.geoSets.map((s: { name: string; source: unknown; status: string; nodes: unknown }) => [s.name, s.source, s.status, s.nodes])).toEqual([
      ['geoip', { type: 'builtin', tag: GEO_BUILTIN.geoip.tag }, 'checking', { total: 0, behind: 0 }],
      ['geosite', { type: 'builtin', tag: GEO_BUILTIN.geosite.tag }, 'checking', { total: 0, behind: 0 }],
    ]);
  });

  it('counts the rule entries naming a set and the nodes they reach, behind only by what a node REPORTED', async () => {
    const id = await verifiedSet();
    const p = await policy('no-ads', ['ext:mylist:ads', 'ext:mylist:adult@x', 'example.com']);
    const ru1 = await node('ru-01', { policyId: p });
    await node('ru-02', { dns: { servers: [{ address: '1.1.1.1', domains: ['ext-domain:mylist:ru'], expectIps: [] }] } });
    const { body } = await call('GET', `/api/geo-sets/${id}`);
    // ARCH 24.09: behind by fact, the rule of the node card. Neither node has
    // reported, and the card calls that "did not report", not "behind".
    expect(body).toMatchObject({
      name: 'mylist',
      source: { type: 'upload', filename: 'mylist.dat' },
      status: 'verified',
      current: { tagCount: 4 },
      usedByRules: 3,
      nodes: { total: 2, behind: 0 },
    });

    // ru-01 reports the file with another sha: now it is behind.
    await prisma.node.update({
      where: { id: ru1 },
      data: {
        geo: { version: 'x', files: [{ name: 'iceslab-mylist.dat', sha256: 'ab'.repeat(32), size: 1 }], observedAt: new Date().toISOString() },
      },
    });
    expect((await call('GET', `/api/geo-sets/${id}`)).body.nodes).toEqual({ total: 2, behind: 1 });

    // And with the right one, it is not.
    await prisma.node.update({
      where: { id: ru1 },
      data: {
        geo: {
          version: 'x',
          files: [{ name: 'iceslab-mylist.dat', sha256: body.current.sha256, size: body.current.sizeBytes }],
          observedAt: new Date().toISOString(),
        },
      },
    });
    expect((await call('GET', `/api/geo-sets/${id}`)).body.nodes).toEqual({ total: 2, behind: 0 });
  });
});

describe('behind agrees with the rollout plan (17.6)', () => {
  it('a node pinned to the old version after a new current is behind, and the plan has files to send', async () => {
    const id = await verifiedSet();
    const p = await policy('no-ads', ['ext:mylist:ads']);
    const ru1 = await node('ru-01', { policyId: p });
    const v1 = (await call('GET', `/api/geo-sets/${id}`)).body.current;
    await prisma.nodeGeoPin.create({
      data: { nodeId: ru1, geoSetId: id, versionId: (await prisma.geoSet.findUniqueOrThrow({ where: { id } })).currentVersionId! },
    });
    await prisma.node.update({
      where: { id: ru1 },
      data: { geo: { version: 'x', files: [{ name: 'iceslab-mylist.dat', sha256: v1.sha256, size: v1.sizeBytes }], observedAt: new Date().toISOString() } },
    });
    expect((await call('GET', `/api/geo-sets/${id}`)).body.nodes).toEqual({ total: 1, behind: 0 });

    // A second version becomes current; the pin stays where it was.
    const out = await ingestGeoFile(id, { bytes: datFile(site('ADS', domain(ROOT, 'other.com'))) });
    expect(out.status).toBe('verified');
    const plan = (await call('GET', `/api/geo-sets/${id}/rollout-plan`)).body;
    expect(plan.nodes[0].filesToSend).toEqual(['iceslab-mylist.dat']);
    expect((await call('GET', `/api/geo-sets/${id}`)).body.nodes).toEqual({ total: 1, behind: 1 });
  });
});

describe('creating from a URL', () => {
  const create = (over: Record<string, unknown> = {}, source: Record<string, unknown> = {}) =>
    call('POST', '/api/geo-sets', {
      name: 'lists',
      kind: 'geosite',
      source: { type: 'url', url: 'https://example.com/lists.dat', sha256Source: 'sidecar', ...source },
      ...over,
    });

  it('answers checking at once and queues the fetch', async () => {
    const { status, body } = await create();
    expect(status).toBe(202);
    expect(body).toMatchObject({
      status: 'checking',
      current: null,
      source: { type: 'url', url: 'https://example.com/lists.dat', sha256Source: 'sidecar', refreshHours: 24 },
    });
    expect(queued).toHaveBeenCalledWith('fetchUrl', { setId: body.id }, { jobId: `url-${body.id}` });
  });

  it.each([
    [{ name: 'My.List' }, {}, 'name'],
    [{ name: 'geosite' }, {}, 'name-reserved'],
    [{}, { url: 'ftp://example.com/x.dat' }, 'url'],
    [{}, { sha256Source: 'manual' }, 'sha256'],
  ])('refuses %j %j with reason %s', async (over, source, reason) => {
    const { status, body } = await create(over, source);
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'GEO_SET_INVALID', reason });
  });

  it('refuses a name that is taken', async () => {
    await create();
    expect((await create()).body).toMatchObject({ error: 'GEO_SET_NAME_TAKEN' });
  });
});

describe('a set rules name cannot be deleted or renamed, and the refusal says where', () => {
  it('node policy, route policy, node DNS', async () => {
    const id = await verifiedSet();
    const p = await policy('no-ads', ['ext:mylist:ads']);
    const rp = await prisma.routePolicy.create({
      data: { name: 'ad-split', ordinal: 1, directDomains: [], blockDomains: ['ext:mylist:ads'] },
      select: { id: true },
    });
    const dnsNode = await node('ru-02', { dns: { servers: [{ address: '1.1.1.1', domains: [], expectIps: ['ext-ip:mylist:ru'] }] } });

    const del = await call('DELETE', `/api/geo-sets/${id}`);
    expect(del.status).toBe(409);
    expect(del.body).toMatchObject({ error: 'GEO_SET_IN_USE' });
    expect(del.body.uses).toEqual([
      { kind: 'node-dns', id: dnsNode, name: 'ru-02' },
      { kind: 'node-policy', id: p, name: 'no-ads' },
      { kind: 'route-policy', id: rp.id, name: 'ad-split' },
    ]);
    expect((await call('PATCH', `/api/geo-sets/${id}`, { name: 'other' })).body).toMatchObject({ error: 'GEO_SET_IN_USE' });
  });

  it('an unused one goes, and its bytes with it', async () => {
    const id = await verifiedSet();
    expect((await call('DELETE', `/api/geo-sets/${id}`)).status).toBe(204);
    expect(await prisma.geoBlob.count()).toBe(0);
  });

  it('a built-in one never goes', async () => {
    const { body } = await call('GET', '/api/geo-sets');
    const geoip = body.geoSets.find((s: { name: string }) => s.name === 'geoip');
    expect((await call('DELETE', `/api/geo-sets/${geoip.id}`)).body).toMatchObject({ error: 'GEO_SET_BUILTIN' });
  });

  it('an uploaded one has no refresh, a built-in one no source to edit', async () => {
    const id = await verifiedSet();
    expect((await call('POST', `/api/geo-sets/${id}/refresh`)).body).toMatchObject({
      error: 'GEO_SET_INVALID',
      reason: 'source-not-editable',
    });
    const { body } = await call('GET', '/api/geo-sets');
    const geosite = body.geoSets.find((s: { name: string }) => s.name === 'geosite');
    expect((await call('PATCH', `/api/geo-sets/${geosite.id}`, { name: 'x' })).body).toMatchObject({
      reason: 'source-not-editable',
    });
  });
});

describe('tags', () => {
  it('filtered by what was typed, a prefix before a mere match, limited', async () => {
    const id = await verifiedSet();
    const { body } = await call('GET', `/api/geo-sets/${id}/tags?q=ad&limit=2`);
    expect(body).toMatchObject({ total: 3, tags: [{ name: 'ads' }, { name: 'adult' }] });
    const all = await call('GET', `/api/geo-sets/${id}/tags?q=ad`);
    expect(all.body.tags.map((t: { name: string }) => t.name)).toEqual(['ads', 'adult', 'category-ads']);
  });

  it('a set with no verified version has none to offer', async () => {
    const { body } = await call('GET', '/api/geo-sets');
    const geoip = body.geoSets.find((s: { name: string }) => s.name === 'geoip');
    expect((await call('GET', `/api/geo-sets/${geoip.id}/tags`)).body).toMatchObject({ error: 'GEO_SET_NOT_VERIFIED' });
  });
});

describe('rollout: the plan, then the pins', () => {
  it('lists every node the set reaches, what it would get and whether xray restarts', async () => {
    const id = await verifiedSet();
    const p = await policy('no-ads', ['ext:mylist:ads']);
    await node('ru-01', { policyId: p });
    await node('nl-01', {
      policyId: p,
      cores: { observedAt: new Date().toISOString(), cores: [{ name: 'tuic', engine: 'singbox', installed: true }] },
    });
    const { body } = await call('GET', `/api/geo-sets/${id}/rollout-plan`);
    expect(body).toEqual({
      version: expect.stringMatching(/^[0-9a-f]{12}$/),
      nodes: [
        { id: expect.any(String), name: 'nl-01', from: null, filesToSend: ['iceslab-mylist.dat'], restartsXray: false },
        // ru-01 never said what it runs: shown as the worse case.
        { id: expect.any(String), name: 'ru-01', from: null, filesToSend: ['iceslab-mylist.dat'], restartsXray: true },
      ],
      breaks: [],
    });
  });

  it('moves the pins of the confirmed version and pushes those nodes; a second rollout has nothing to move', async () => {
    const id = await verifiedSet();
    const p = await policy('no-ads', ['ext:mylist:ads']);
    const ru = await node('ru-01', { policyId: p });
    const { version } = (await call('GET', `/api/geo-sets/${id}/rollout-plan`)).body;
    const emitted = vi.spyOn(eventBus, 'emit');

    expect((await call('POST', `/api/geo-sets/${id}/rollout`, { version: 'aaaaaaaaaaaa' })).body).toMatchObject({
      error: 'GEO_ROLLOUT_STALE',
      current: version,
    });
    expect((await call('POST', `/api/geo-sets/${id}/rollout`, { version })).body).toEqual({ nodes: 1 });
    expect(await prisma.nodeGeoPin.count()).toBe(1);
    // Phase 9.2: the moved node gets its push, which lays the file out.
    expect(emitted).toHaveBeenCalledWith('geo.rolledOut', { geoSetId: id, nodeIds: [ru] });
    emitted.mockClear();

    // ARCH 24.09: the pin moved, the node has not reported. The plan speaks
    // of the machine, so the file is still to be sent, and a second rollout
    // pushes it again without moving anything.
    const unreported = (await call('GET', `/api/geo-sets/${id}/rollout-plan`)).body;
    expect(unreported.nodes[0]).toMatchObject({ from: version, filesToSend: ['iceslab-mylist.dat'], restartsXray: true });
    expect((await call('POST', `/api/geo-sets/${id}/rollout`, { version })).body).toEqual({ nodes: 1 });
    expect(emitted).toHaveBeenCalledWith('geo.rolledOut', { geoSetId: id, nodeIds: [ru] });
    emitted.mockClear();

    // The node reports the file with the version's sha: nothing left to do.
    const { current } = (await call('GET', `/api/geo-sets/${id}`)).body;
    await prisma.node.update({
      where: { id: ru },
      data: {
        geo: {
          version: 'x',
          files: [{ name: 'iceslab-mylist.dat', sha256: current.sha256, size: current.sizeBytes }],
          observedAt: new Date().toISOString(),
        },
      },
    });
    const again = (await call('GET', `/api/geo-sets/${id}/rollout-plan`)).body;
    expect(again.nodes[0]).toMatchObject({ from: version, filesToSend: [], restartsXray: false });
    expect((await call('GET', `/api/geo-sets/${id}`)).body.nodes).toEqual({ total: 1, behind: 0 });
    expect((await call('POST', `/api/geo-sets/${id}/rollout`, { version })).body).toEqual({ nodes: 0 });
    expect(emitted).not.toHaveBeenCalledWith('geo.rolledOut', expect.anything());
  });

  it('a node that reports another sha for the file gets it again, pin or no pin', async () => {
    const id = await verifiedSet();
    const p = await policy('no-ads', ['ext:mylist:ads']);
    await node('ru-01', {
      policyId: p,
      cores: { observedAt: new Date().toISOString(), cores: [{ name: 'vless', engine: 'xray', installed: true }] },
    });
    const ru = (await prisma.node.findFirstOrThrow({ where: { name: 'ru-01' }, select: { id: true } })).id;
    await prisma.node.update({
      where: { id: ru },
      data: {
        geo: {
          version: 'x',
          files: [{ name: 'iceslab-mylist.dat', sha256: 'ab'.repeat(32), size: 1 }],
          observedAt: new Date().toISOString(),
        },
      },
    });
    const plan = (await call('GET', `/api/geo-sets/${id}/rollout-plan`)).body;
    expect(plan.nodes[0]).toMatchObject({ filesToSend: ['iceslab-mylist.dat'], restartsXray: true });
  });

  it('a version that lacks a tag a rule names is not rolled out, and the rule is named', async () => {
    const id = await verifiedSet();
    // RU and adult@x are there, spelled as xray reads them: upper case, with
    // an attribute. Only the tag itself has to exist.
    const p = await policy('no-ads', ['ext:mylist:ads', 'ext:mylist:RU', 'ext:mylist:adult@x', 'ext:mylist:gone@x', 'ext:mylist:GONE']);
    await node('ru-01', { policyId: p });
    const plan = (await call('GET', `/api/geo-sets/${id}/rollout-plan`)).body;
    expect(plan.breaks).toEqual([
      { entry: 'ext:mylist:GONE', uses: [{ kind: 'node-policy', id: p, name: 'no-ads' }] },
      { entry: 'ext:mylist:gone@x', uses: [{ kind: 'node-policy', id: p, name: 'no-ads' }] },
    ]);
    const res = await call('POST', `/api/geo-sets/${id}/rollout`, { version: plan.version });
    expect(res.body).toMatchObject({ error: 'GEO_ROLLOUT_BREAKS', breaks: plan.breaks });
    expect(await prisma.nodeGeoPin.count()).toBe(0);
  });

  it('a route policy reaches the entries of enabled cascades, not their exits and not a disabled one', async () => {
    const id = await verifiedSet();
    await prisma.routePolicy.create({ data: { name: 'ad-split', ordinal: 1, directDomains: [], blockDomains: ['ext:mylist:ads'] } });
    const entry = await node('ru-01');
    const exit = await node('se-01');
    const offEntry = await node('ru-03');
    for (const [name, enabled, e] of [['on', true, entry], ['off', false, offEntry]] as const) {
      const c = await prisma.cascade.create({ data: { name, enabled, mode: 'chain' }, select: { id: true } });
      await prisma.cascadePosition.create({ data: { cascadeId: c.id, position: 0, entryProtocol: 'xray', nodes: { create: [{ nodeId: e }] } } });
      await prisma.cascadeDirection.create({ data: { cascadeId: c.id, tag: 1, nodes: { create: [{ nodeId: exit }] } } });
    }
    const plan = (await call('GET', `/api/geo-sets/${id}/rollout-plan`)).body;
    expect(plan.nodes.map((n: { name: string }) => n.name)).toEqual(['ru-01']);
  });

  it('a cascade exit is to hold the rule-set its chain reads from its node policy: the plan sends it, the rollout pushes it, the list counts it behind', async () => {
    registerInboundEventHandlersOnce();
    // The push's own queue is not reached: the revision moves before it.
    vi.spyOn(inboundSyncQueue, 'add').mockResolvedValue({} as never);
    const id = await verifiedSet();
    const p = await policy('no-ads', ['ext:mylist:ads']);
    const exit = await node('se-01', { policyId: p });
    const entry = await node('ru-01');
    const c = await prisma.cascade.create({ data: { name: 'on', enabled: true, mode: 'chain' }, select: { id: true } });
    await prisma.cascadePosition.create({ data: { cascadeId: c.id, position: 0, entryProtocol: 'xray', nodes: { create: [{ nodeId: entry }] } } });
    await prisma.cascadeDirection.create({ data: { cascadeId: c.id, tag: 1, nodes: { create: [{ nodeId: exit }] } } });

    // Pinned at current and holding the .dat, but not the chain's rule-set.
    const { current } = (await call('GET', `/api/geo-sets/${id}`)).body;
    await prisma.nodeGeoPin.create({ data: { nodeId: exit, geoSetId: id, versionId: (await prisma.geoSet.findUniqueOrThrow({ where: { id } })).currentVersionId! } });
    await prisma.node.update({
      where: { id: exit },
      data: {
        geo: {
          version: 'x',
          files: [{ name: 'iceslab-mylist.dat', sha256: current.sha256, size: current.sizeBytes }],
          observedAt: new Date().toISOString(),
        },
      },
    });

    const plan = (await call('GET', `/api/geo-sets/${id}/rollout-plan`)).body;
    expect(plan.nodes).toEqual([
      expect.objectContaining({ name: 'se-01', from: current.version, filesToSend: [chainRuleSetFileName('mylist', 'ads')], restartsXray: false }),
    ]);
    expect((await call('GET', `/api/geo-sets/${id}`)).body.nodes).toEqual({ total: 1, behind: 1 });

    const before = (await prisma.node.findUniqueOrThrow({ where: { id: exit } })).desiredRevision;
    expect((await call('POST', `/api/geo-sets/${id}/rollout`, { version: plan.version })).body).toEqual({ nodes: 1 });
    await vi.waitFor(async () =>
      expect((await prisma.node.findUniqueOrThrow({ where: { id: exit } })).desiredRevision).toBe(before + 1n),
    );

    // The same node out of the cascade reads no chain: the .dat is all it holds.
    await prisma.cascade.update({ where: { id: c.id }, data: { enabled: false } });
    expect((await call('GET', `/api/geo-sets/${id}/rollout-plan`)).body.nodes).toEqual([
      expect.objectContaining({ name: 'se-01', filesToSend: [] }),
    ]);
    expect((await call('GET', `/api/geo-sets/${id}`)).body.nodes).toEqual({ total: 1, behind: 0 });
  });
});

let handlersOn = false;
function registerInboundEventHandlersOnce(): void {
  if (handlersOn) return;
  handlersOn = true;
  registerInboundEventHandlers();
}

describe('composite sets (milestone 10.2)', () => {
  const comp = (categories: unknown, name = 'mine', kind = 'geosite') => ({ name, kind, source: { type: 'composite', categories } });
  const video = { name: 'video', refs: [{ set: 'mylist', tag: 'ads' }, { set: 'mylist', tag: 'ru' }], manual: ['full:vimeo.com', 'ads.example'], exclude: ['d.ru'], enabled: true };

  it('is created through /api/geo-sets: the definition comes back, the file is built as an ordinary version', async () => {
    await verifiedSet();
    const { status, body } = await call('POST', '/api/geo-sets', comp([video]));
    expect(status).toBe(202);
    expect(body).toMatchObject({
      name: 'mine',
      kind: 'geosite',
      source: { type: 'composite', categories: [video] },
      status: 'verified',
      current: { tagCount: 1 },
    });
    expect((await call('GET', `/api/geo-sets/${body.id}/tags`)).body.tags).toEqual([{ name: 'video', entries: 3, attrs: [] }]);
    // Listed beside the others, rolled out by the same plan.
    expect((await call('GET', `/api/geo-sets/${body.id}/rollout-plan`)).status).toBe(200);
    expect((await call('GET', '/api/geo-sets')).body.geoSets.map((x: { name: string }) => x.name)).toContain('mine');
  });

  it('refuses a reference to a missing set, a missing category, itself, a composite, the other kind', async () => {
    await verifiedSet();
    const refused = async (categories: unknown, name = 'mine') => {
      const r = await call('POST', '/api/geo-sets', comp(categories, name));
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ error: 'GEO_SET_INVALID', reason: 'composite' });
      return r.body;
    };
    const one = (set: string, tag: string) => [{ name: 'x', refs: [{ set, tag }], manual: [], exclude: [], enabled: true }];
    expect(await refused(one('nope', 'ads'))).toMatchObject({ at: { category: 'x', entry: 'nope:ads' }, message: expect.stringContaining('does not exist') });
    expect(await refused(one('mylist', 'zzz'))).toMatchObject({ at: { category: 'x', entry: 'mylist:zzz' }, message: expect.stringContaining('does not have') });
    expect(await refused(one('mine', 'x'))).toMatchObject({ message: expect.stringContaining('the set itself') });
    await prisma.geoSet.create({ data: { name: 'ipset', kind: 'geoip', sourceType: 'upload', filename: 'x' } });
    expect(await refused(one('ipset', 'ru'), 'mine2')).toMatchObject({ message: expect.stringContaining('this one is geosite') });
    // A composite is never a source.
    expect((await call('POST', '/api/geo-sets', comp([video]))).status).toBe(202);
    expect(await refused(one('mine', 'video'), 'second')).toMatchObject({ message: expect.stringContaining('composite set, which cannot be a source') });
    // A bad manual entry names the category and the entry.
    expect(await refused([{ ...video, manual: ['ok.com', 'a b'] }], 'third')).toMatchObject({ at: { category: 'video', entry: 'a b' } });
    expect((await call('POST', '/api/geo-sets', comp([video, video], 'dup'))).body).toMatchObject({ message: expect.stringContaining('named twice') });
  });

  it('refuses a name taken or reserved, like any set', async () => {
    expect((await call('POST', '/api/geo-sets', comp([], 'geosite'))).body).toMatchObject({ reason: 'name-reserved' });
    await verifiedSet();
    expect((await call('POST', '/api/geo-sets', comp([], 'mylist'))).status).toBe(409);
  });

  it('a set a composite is built from cannot be deleted or renamed', async () => {
    const src = await verifiedSet();
    const { body: made } = await call('POST', '/api/geo-sets', comp([video]));
    const del = await call('DELETE', `/api/geo-sets/${src}`);
    expect(del.status).toBe(409);
    expect(del.body).toMatchObject({ error: 'GEO_SET_REFERENCED', by: ['mine'] });
    expect((await call('PATCH', `/api/geo-sets/${src}`, { name: 'renamed' })).body).toMatchObject({ error: 'GEO_SET_REFERENCED' });
    // The composite itself goes, and then its source can.
    expect((await call('DELETE', `/api/geo-sets/${made.id}`)).status).toBe(204);
    expect((await call('DELETE', `/api/geo-sets/${src}`)).status).toBe(204);
  });

  it('PATCH changes the definition and builds again; refresh builds again and sends nothing', async () => {
    await verifiedSet();
    const { body: made } = await call('POST', '/api/geo-sets', comp([video]));
    const patched = await call('PATCH', `/api/geo-sets/${made.id}`, {
      categories: [video, { name: 'more', refs: [], manual: ['example.org'], exclude: [], enabled: true }],
    });
    expect(patched.status).toBe(200);
    expect(patched.body.current.tagCount).toBe(2);
    expect(patched.body.current.sha256).not.toBe(made.current.sha256);
    // A definition that does not hold leaves the set as it was.
    const bad = await call('PATCH', `/api/geo-sets/${made.id}`, { categories: [{ ...video, refs: [{ set: 'mylist', tag: 'gone' }] }] });
    expect(bad.status).toBe(400);
    expect((await call('GET', `/api/geo-sets/${made.id}`)).body.source.categories).toHaveLength(2);
    const again = await call('POST', `/api/geo-sets/${made.id}/refresh`);
    expect(again.status).toBe(202);
    expect(again.body.current.sha256).toBe(patched.body.current.sha256);
    expect(await prisma.geoSetVersion.count({ where: { geoSetId: made.id } })).toBe(2);
    // Only a composite takes categories.
    const other = await verifiedSet('other');
    expect((await call('PATCH', `/api/geo-sets/${other}`, { categories: [] })).body).toMatchObject({ reason: 'source-not-editable' });
  });

  it('a new version of a source queues the build of the composites made from it, and nothing else', async () => {
    const src = await verifiedSet();
    const { body: made } = await call('POST', '/api/geo-sets', comp([video]));
    await verifiedSet('unrelated');
    queued.mockClear();
    await replaceUploadFile(src, { filename: 'new.dat', bytes: datFile(site('ADS', domain(ROOT, 'a.com')), site('RU', domain(ROOT, 'd.ru'))) });
    expect(queued.mock.calls).toEqual([['buildComposite', { setId: made.id }, { jobId: `composite-${made.id}` }]]);

    queued.mockClear();
    expect(await enqueueDependentBuilds('unrelated')).toBe(0);
    expect(await enqueueDependentBuilds('mylist')).toBe(1);
    expect(queued).toHaveBeenCalledTimes(1);
  });
});
