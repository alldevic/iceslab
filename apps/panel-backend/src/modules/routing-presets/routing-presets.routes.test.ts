import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { matcherKind } from './routing-presets.rules.js';
import { makeNode, makeSquad } from '../../../tests/helpers/preset-nodes.js';
import { inboundSyncQueue } from '../inbounds/inbounds.queue.js';

/**
 * A-229 part 2: /api/routing-presets. Built-ins listed and read-only on the
 * server; own presets written with their rules checked; a preset in use is not
 * deleted from under its users and squads.
 */
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
const RULES = [
  { match: ['geosite:google', 'domain:example.com'], action: 'direct', note: 'search' },
  { match: ['10.0.0.0/8', 'port:25'], action: 'block' },
];

async function create(payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/routing-presets', headers: auth(), payload });
}

/** A verified built-in geosite version holding only these tags. */
async function seedGeosite(tags: string[]): Promise<void> {
  const set = await prisma.geoSet.upsert({
    where: { name: 'geosite' },
    update: {},
    create: { name: 'geosite', kind: 'geosite', sourceType: 'builtin', sourceTag: 'test', status: 'verified' },
  });
  const blob = await prisma.geoBlob.create({ data: { sha256: 'a'.repeat(64), data: Buffer.from('x'), sizeBytes: 1 } });
  const version = await prisma.geoSetVersion.create({
    data: {
      geoSetId: set.id,
      version: 'v1',
      sha256: blob.sha256,
      sourceSha256: blob.sha256,
      sizeBytes: 1,
      fetchedAt: new Date(),
      tags: tags.map((name) => ({ name, count: 1 })),
    },
  });
  await prisma.geoSet.update({ where: { id: set.id }, data: { currentVersionId: version.id } });
}

describe('matcherKind', () => {
  it('reads names, addresses and ports, and refuses the node-only ext: sets', () => {
    expect(matcherKind('geosite:google')).toBe('domain');
    expect(matcherKind('example.com')).toBe('domain');
    expect(matcherKind('geoip:ru')).toBe('ip');
    expect(matcherKind('1.2.3.0/24')).toBe('ip');
    expect(matcherKind('port:443')).toBe('port');
    expect(matcherKind('port:1000-2000')).toBe('port');
    expect(matcherKind('port:0')).toBeNull();
    expect(matcherKind('port:2000-1000')).toBeNull();
    expect(matcherKind('ext:corp:office')).toBeNull();
    expect(matcherKind('ext-ip:corp:office')).toBeNull();
    expect(matcherKind('what is this')).toBeNull();
  });
});

describe('GET /api/routing-presets', () => {
  it('lists the three built-ins read-only, then the own ones, in the editor shape', async () => {
    const made = await create({ name: 'office', rules: RULES });
    expect(made.statusCode, made.body).toBe(201);

    const res = await app.inject({ method: 'GET', url: '/api/routing-presets', headers: auth() });
    expect(res.statusCode).toBe(200);
    const { presets } = JSON.parse(res.body) as {
      presets: { id: string; name: string; builtIn: boolean; rules: { id: string; match: string[]; action: string; note: string }[] }[];
    };
    expect(presets.map((p) => [p.id, p.builtIn]).slice(0, 3)).toEqual([
      ['proxy-all', true],
      ['ru-split', true],
      ['cn-split', true],
    ]);
    expect(presets[1]!.rules[0]).toEqual({ id: 'ru-split:0', match: ['geosite:category-ads-all'], action: 'block', note: '' });
    const own = presets[3]!;
    expect(own).toMatchObject({ name: 'office', builtIn: false });
    expect(own.rules).toEqual([
      { id: `${own.id}:0`, match: ['geosite:google', 'domain:example.com'], action: 'direct', note: 'search' },
      { id: `${own.id}:1`, match: ['10.0.0.0/8', 'port:25'], action: 'block', note: '' },
    ]);
  });
});

describe('writes', () => {
  it('a built-in is neither changed nor deleted, refused in words on the server', async () => {
    for (const method of ['PUT', 'DELETE'] as const) {
      const res = await app.inject({
        method,
        url: '/api/routing-presets/ru-split',
        headers: auth(),
        ...(method === 'PUT' ? { payload: { name: 'mine' } } : {}),
      });
      expect(res.statusCode, method).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({ error: 'ROUTING_PRESET_BUILT_IN' });
      expect(JSON.parse(res.body).message).toContain('built-in');
    }
  });

  it('refuses warp, ext: sets and unreadable matchers, each by name', async () => {
    const warp = await create({ name: 'w', rules: [{ match: ['geosite:google'], action: 'warp' }] });
    expect(warp.statusCode).toBe(400);
    expect(warp.body).toContain('warp is a node egress');

    const ext = await create({ name: 'e', rules: [{ match: ['ext:corp:office', 'not a thing'], action: 'direct' }] });
    expect(ext.statusCode).toBe(400);
    expect(JSON.parse(ext.body)).toMatchObject({
      error: 'ROUTING_PRESET_ENTRY_UNKNOWN',
      entries: ['ext:corp:office', 'not a thing'],
    });
    expect(await prisma.routingPreset.count()).toBe(0);
  });

  it('checks geosite tags against the built-in set when it has a verified version', async () => {
    // No version yet: an unknown list refuses nothing.
    const before = await create({ name: 'early', rules: [{ match: ['geosite:no-such-tag'], action: 'direct' }] });
    expect(before.statusCode, before.body).toBe(201);

    await seedGeosite(['google', 'category-ru']);
    const bad = await create({ name: 'late', rules: [{ match: ['geosite:google', 'geosite:no-such-tag'], action: 'direct' }] });
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body)).toMatchObject({ error: 'ROUTING_PRESET_GEO_TAG_UNKNOWN', entries: ['geosite:no-such-tag'] });

    const ok = await create({ name: 'late', rules: [{ match: ['geosite:Google', 'geosite:category-ru@!cn'], action: 'direct' }] });
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it('a name is unique, and a built-in key is not a free name', async () => {
    expect((await create({ name: 'office', rules: [] })).statusCode).toBe(201);
    const dupe = await create({ name: 'office', rules: [] });
    expect(dupe.statusCode).toBe(409);
    expect(JSON.parse(dupe.body)).toMatchObject({ error: 'NAME_TAKEN', field: 'name' });
    const builtin = await create({ name: 'ru-split', rules: [] });
    expect(builtin.statusCode).toBe(409);
    expect(JSON.parse(builtin.body).message).toContain('built-in');
  });

  it('PUT changes what it is given and keeps what it is not', async () => {
    const made = JSON.parse((await create({ name: 'office', rules: RULES })).body) as { id: string };
    const renamed = await app.inject({ method: 'PUT', url: `/api/routing-presets/${made.id}`, headers: auth(), payload: { name: 'office-2' } });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(JSON.parse(renamed.body)).toMatchObject({ name: 'office-2' });
    expect(JSON.parse(renamed.body).rules).toHaveLength(2);

    const ruled = await app.inject({
      method: 'PUT', url: `/api/routing-presets/${made.id}`, headers: auth(),
      payload: { rules: [{ match: ['geoip:private'], action: 'direct' }] },
    });
    expect(JSON.parse(ruled.body)).toMatchObject({ name: 'office-2', rules: [{ match: ['geoip:private'], action: 'direct' }] });

    const missing = await app.inject({
      method: 'PUT', url: '/api/routing-presets/7b0d1c1e-0000-4000-8000-000000000000', headers: auth(), payload: { name: 'x' },
    });
    expect(missing.statusCode).toBe(404);
  });

  describe('dnsRules (stage 19.2)', () => {
    const DNS = [
      { match: ['domain:corp.example', 'full:a.corp.example'], server: 'tcp://10.0.0.1', note: 'office' },
      { match: ['geosite:google'], server: 'https://dns.example.com/dns-query', note: '' },
    ];
    const put = (id: string, payload: Record<string, unknown>) =>
      app.inject({ method: 'PUT', url: `/api/routing-presets/${id}`, headers: auth(), payload });

    it('saved and read back on POST, PUT and GET; built-ins have none; absent on create is empty', async () => {
      const made = await create({ name: 'office', rules: RULES, dnsRules: DNS });
      expect(made.statusCode, made.body).toBe(201);
      expect(JSON.parse(made.body).dnsRules).toEqual(DNS);
      const plain = JSON.parse((await create({ name: 'plain', rules: [] })).body);
      expect(plain.dnsRules).toEqual([]);

      const id = JSON.parse(made.body).id as string;
      const next = [{ match: ['corp.example'], server: '10.0.0.2', note: 'n' }];
      expect(JSON.parse((await put(id, { dnsRules: next })).body).dnsRules).toEqual(next);

      const { presets } = JSON.parse((await app.inject({ method: 'GET', url: '/api/routing-presets', headers: auth() })).body) as {
        presets: { name: string; builtIn: boolean; dnsRules: unknown[] }[];
      };
      expect(presets.filter((p) => p.builtIn).map((p) => p.dnsRules)).toEqual([[], [], []]);
      expect(presets.find((p) => p.name === 'office')!.dnsRules).toEqual(next);
    });

    it('PUT without the key keeps the saved rules; an empty list clears them', async () => {
      const id = JSON.parse((await create({ name: 'office', rules: RULES, dnsRules: DNS })).body).id as string;
      const renamed = await put(id, { name: 'office-2', rules: [] });
      expect(JSON.parse(renamed.body).dnsRules).toEqual(DNS);
      expect((await prisma.routingPreset.findUniqueOrThrow({ where: { id } })).dnsRules).toEqual(DNS);
      expect(JSON.parse((await put(id, { dnsRules: [] })).body).dnsRules).toEqual([]);
    });

    it('refuses a name or a server a DNS rule cannot carry, each with its code and the entries', async () => {
      for (const m of ['keyword:corp', 'regexp:^corp', '10.0.0.0/8', 'geoip:ru', 'port:53', 'ext:corp:office']) {
        const res = await create({ name: 'm', rules: [], dnsRules: [{ match: ['domain:ok.example', m], server: '10.0.0.1' }] });
        expect(res.statusCode, m).toBe(400);
        expect(JSON.parse(res.body), m).toMatchObject({ error: 'ROUTING_PRESET_DNS_MATCH_INVALID', entries: [m] });
      }
      for (const s of ['udp://10.0.0.1', '10.0.0.1:53', 'https://', 'dns.example.com', 'tcp://dns.example.com']) {
        const res = await create({ name: 's', rules: [], dnsRules: [{ match: ['corp.example'], server: s }] });
        expect(res.statusCode, s).toBe(400);
        expect(JSON.parse(res.body), s).toMatchObject({ error: 'ROUTING_PRESET_DNS_SERVER_INVALID', entries: [s] });
      }
      expect(await prisma.routingPreset.count()).toBe(0);
    });

    it('all four server kinds are accepted', async () => {
      const servers = ['10.0.0.1', 'tcp://10.0.0.1:5353', 'tls://dns.example.com', 'https://dns.example.com/dns-query'];
      const res = await create({ name: 'k', rules: [], dnsRules: servers.map((server) => ({ match: ['corp.example'], server })) });
      expect(res.statusCode, res.body).toBe(201);
    });

    it('a geosite tag the built-in set lacks is ROUTING_PRESET_GEO_TAG_UNKNOWN, on create and on PUT', async () => {
      await seedGeosite(['google']);
      const bad = await create({ name: 'g', rules: [], dnsRules: [{ match: ['geosite:no-such-tag'], server: '10.0.0.1' }] });
      expect(bad.statusCode).toBe(400);
      expect(JSON.parse(bad.body)).toMatchObject({ error: 'ROUTING_PRESET_GEO_TAG_UNKNOWN', entries: ['geosite:no-such-tag'] });
      const id = JSON.parse((await create({ name: 'g', rules: [] })).body).id as string;
      const bad2 = await put(id, { dnsRules: [{ match: ['geosite:no-such-tag'], server: '10.0.0.1' }] });
      expect(JSON.parse(bad2.body).error).toBe('ROUTING_PRESET_GEO_TAG_UNKNOWN');
      expect((await put(id, { dnsRules: [{ match: ['geosite:google'], server: '10.0.0.1' }] })).statusCode).toBe(200);
    });

    it('the 17th rule and the 65th name are refused', async () => {
      const rule = { match: ['corp.example'], server: '10.0.0.1' };
      expect((await create({ name: 'a', rules: [], dnsRules: Array.from({ length: 16 }, () => rule) })).statusCode).toBe(201);
      expect((await create({ name: 'b', rules: [], dnsRules: Array.from({ length: 17 }, () => rule) })).statusCode).toBe(400);
      const names = (n: number) => Array.from({ length: n }, (_, i) => `d${i}.example`);
      expect((await create({ name: 'c', rules: [], dnsRules: [{ ...rule, match: names(64) }] })).statusCode).toBe(201);
      expect((await create({ name: 'd', rules: [], dnsRules: [{ ...rule, match: names(65) }] })).statusCode).toBe(400);
    });
  });

  it('a preset in use is not deleted: 409 with the users and squads that hold it', async () => {
    const made = JSON.parse((await create({ name: 'office', rules: RULES })).body) as { id: string };
    const user = await app.inject({
      method: 'POST', url: '/api/users', headers: auth(), payload: { username: 'holder-1', customRoutingPresetId: made.id },
    });
    expect(user.statusCode, user.body).toBe(201);
    const squad = await app.inject({
      method: 'POST', url: '/api/squads', headers: auth(), payload: { name: 'holders', customRoutingPresetId: made.id },
    });
    expect(squad.statusCode, squad.body).toBe(201);

    const refused = await app.inject({ method: 'DELETE', url: `/api/routing-presets/${made.id}`, headers: auth() });
    expect(refused.statusCode).toBe(409);
    expect(JSON.parse(refused.body)).toMatchObject({
      error: 'ROUTING_PRESET_IN_USE',
      users: [{ username: 'holder-1' }],
      squads: [{ name: 'holders' }],
      userCount: 1,
      squadCount: 1,
    });
    expect(JSON.parse(refused.body).message).toContain('1 user(s) and 1 squad(s)');

    await app.inject({ method: 'PUT', url: `/api/squads/${JSON.parse(squad.body).id}`, headers: auth(), payload: { customRoutingPresetId: null } });
    // A soft-deleted holder does not keep the preset alive.
    await app.inject({ method: 'DELETE', url: `/api/users/${JSON.parse(user.body).id}`, headers: auth() });
    const gone = await app.inject({ method: 'DELETE', url: `/api/routing-presets/${made.id}`, headers: auth() });
    expect(gone.statusCode, gone.body).toBe(204);
    expect(await prisma.routingPreset.count()).toBe(0);
  });

  it('assigned between the in-use check and the delete: the same 409 with the holders read again, not a 500', async () => {
    const made = JSON.parse((await create({ name: 'office', rules: RULES })).body) as { id: string };
    const user = await app.inject({
      method: 'POST', url: '/api/users', headers: auth(), payload: { username: 'late-holder', customRoutingPresetId: made.id },
    });
    expect(user.statusCode, user.body).toBe(201);

    // The check reads nobody, as if the assignment came right after it.
    const spies = [
      vi.spyOn(prisma.user, 'findMany').mockResolvedValueOnce([] as never),
      vi.spyOn(prisma.user, 'count').mockResolvedValueOnce(0 as never),
      vi.spyOn(prisma.group, 'findMany').mockResolvedValueOnce([] as never),
      vi.spyOn(prisma.group, 'count').mockResolvedValueOnce(0 as never),
    ];
    try {
      const res = await app.inject({ method: 'DELETE', url: `/api/routing-presets/${made.id}`, headers: auth() });
      expect(spies.every((s) => s.mock.calls.length >= 1), 'the check was not the stand-in').toBe(true);
      expect(res.statusCode, res.body).toBe(409);
      expect(JSON.parse(res.body)).toMatchObject({
        error: 'ROUTING_PRESET_IN_USE',
        users: [{ username: 'late-holder' }],
        userCount: 1,
      });
    } finally {
      vi.restoreAllMocks();
    }
    expect(await prisma.routingPreset.count()).toBe(1);
  });
});

describe('19.10: the DNS rules go to the nodes of the preset', () => {
  const dns = (...rules: [string[], string][]) => rules.map(([match, server]) => ({ match, server, note: '' }));
  const carried = async (nodeId: string) => (await prisma.node.findUniqueOrThrow({ where: { id: nodeId }, select: { presetDnsRules: true } })).presetDnsRules;
  const put = (id: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: `/api/routing-presets/${id}`, headers: auth(), payload });

  /** Two squads, a preset each, one node shared and one apiece. */
  async function twoSquads() {
    const [a, shared, b] = [await makeNode(), await makeNode({ name: 'shared-node' }), await makeNode()];
    const pa = JSON.parse((await create({ name: 'Alpha', rules: [] })).body).id as string;
    const pb = JSON.parse((await create({ name: 'Beta', rules: [] })).body).id as string;
    await makeSquad([a.id, shared.id], { presetId: pa });
    await makeSquad([shared.id, b.id], { presetId: pb });
    return { a, shared, b, pa, pb };
  }

  it('saving the rules writes them to the nodes that serve the preset and queues a push to those only', async () => {
    const { a, shared, b, pa } = await twoSquads();
    await inboundSyncQueue.obliterate({ force: true });
    const res = await put(pa, { dnsRules: dns([['example.com'], '10.99.0.1']) });
    expect(res.statusCode, res.body).toBe(200);
    const expected = [{ presetId: pa, rules: [{ match: ['example.com'], server: '10.99.0.1' }] }];
    expect(await carried(a.id)).toEqual(expected);
    expect(await carried(shared.id)).toEqual(expected);
    expect(await carried(b.id)).toBeNull();
    expect(await inboundSyncQueue.getJob(`apply-${a.id}`)).toBeTruthy();
    expect(await inboundSyncQueue.getJob(`apply-${shared.id}`)).toBeTruthy();
    expect(await inboundSyncQueue.getJob(`apply-${b.id}`)).toBeUndefined();
    await inboundSyncQueue.obliterate({ force: true });
  });

  it('a DoT rule is saved on the preset but not carried to the node', async () => {
    const { a, pa } = await twoSquads();
    const res = await put(pa, { dnsRules: dns([['example.com'], 'tls://dns.example'], [['other.com'], '10.99.0.1']) });
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).dnsRules).toHaveLength(2);
    expect(await carried(a.id)).toEqual([{ presetId: pa, rules: [{ match: ['other.com'], server: '10.99.0.1' }] }]);
  });

  it('another server for the same name on the shared node is refused, naming the other preset and the node, and nothing is written', async () => {
    const { a, shared, b, pa, pb } = await twoSquads();
    expect((await put(pa, { dnsRules: dns([['example.com'], '10.99.0.1']) })).statusCode).toBe(200);
    const before = await carried(shared.id);
    await inboundSyncQueue.obliterate({ force: true });
    const res = await put(pb, { name: 'Beta2', dnsRules: dns([['domain:example.com'], '10.99.0.2']) });
    expect(res.statusCode, res.body).toBe(409);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ error: 'ROUTING_PRESET_DNS_CONFLICT', preset: 'Alpha', panel: false, node: 'shared-node', domain: expect.stringMatching(/example\.com$/) });
    expect(body.message).toContain('"Alpha"');
    expect(body.message).toContain('"shared-node"');
    const row = await prisma.routingPreset.findUniqueOrThrow({ where: { id: pb } });
    expect(row.name).toBe('Beta');
    expect(row.dnsRules).toEqual([]);
    expect(await carried(shared.id)).toEqual(before);
    expect(await carried(a.id)).toEqual(before);
    expect(await carried(b.id)).toBeNull();
    expect(await inboundSyncQueue.getJob(`apply-${b.id}`)).toBeUndefined();
    // The same server for the same name is no conflict, and a name on a node the other preset does not reach is none either.
    expect((await put(pb, { dnsRules: dns([['example.com'], '10.99.0.1'], [['other.com'], '10.99.0.2']) })).statusCode).toBe(200);
    await inboundSyncQueue.obliterate({ force: true });
  });

  it('removing a rule takes it off the nodes, and deleting the preset takes its rules off a node that still carries them', async () => {
    const { a, shared, pa, pb } = await twoSquads();
    await put(pa, { dnsRules: dns([['one.com'], '10.99.0.1'], [['two.com'], '10.99.0.1']) });
    await put(pb, { dnsRules: dns([['three.com'], '10.99.0.3']) });
    expect(((await carried(shared.id)) as unknown[]).length).toBe(2);
    expect((await put(pa, { dnsRules: dns([['one.com'], '10.99.0.1']) })).statusCode).toBe(200);
    expect(await carried(a.id)).toEqual([{ presetId: pa, rules: [{ match: ['one.com'], server: '10.99.0.1' }] }]);
    expect((await put(pa, { dnsRules: [] })).statusCode).toBe(200);
    expect(await carried(a.id)).toBeNull();
    expect(await carried(shared.id)).toEqual([{ presetId: pb, rules: [{ match: ['three.com'], server: '10.99.0.3' }] }]);

    // Delete: the squad let go of the preset (19.11 will recompute on that), the node still has the rules.
    await prisma.group.updateMany({ where: { customRoutingPresetId: pb }, data: { customRoutingPresetId: null } });
    expect(await carried(shared.id)).not.toBeNull();
    const del = await app.inject({ method: 'DELETE', url: `/api/routing-presets/${pb}`, headers: auth() });
    expect(del.statusCode, del.body).toBe(204);
    expect(await carried(shared.id)).toBeNull();
  });

  it('refuses a save that would put more than 16 servers on a node, naming the node', async () => {
    const node = await makeNode({ name: 'full-node', dns: { servers: Array.from({ length: 15 }, (_, i) => ({ address: `10.1.0.${i + 1}`, domains: [], expectIps: [], skipFallback: false })) } });
    const p = JSON.parse((await create({ name: 'Many', rules: [] })).body).id as string;
    await makeSquad([node.id], { presetId: p });
    const res = await put(p, { dnsRules: dns([['a.com'], '10.2.0.1'], [['b.com'], '10.2.0.2'], [['c.com'], '10.2.0.3']) });
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'ROUTING_PRESET_DNS_NODE_LIMIT', node: 'full-node', count: 18 });
    expect(await carried(node.id)).toBeNull();
  });
});

describe('19.12: GET /api/routing-presets/:id/nodes', () => {
  const dns = (...rules: [string[], string][]) => rules.map(([match, server]) => ({ match, server, note: '' }));
  const put = (id: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: `/api/routing-presets/${id}`, headers: auth(), payload });
  const nodesOf = async (id: string, status = 200) => {
    const res = await app.inject({ method: 'GET', url: `/api/routing-presets/${id}/nodes`, headers: auth() });
    expect(res.statusCode, res.body).toBe(status);
    return JSON.parse(res.body) as {
      scope: string;
      ruleCount: number;
      nodes: { id: string; name: string; state: string; carried: number; cores: { name: string; rendersDns?: boolean }[] | null; skipped: Record<string, unknown>[] }[];
    };
  };
  const presetNamed = async (name: string) => JSON.parse((await create({ name, rules: [] })).body).id as string;

  it('a preset nobody holds has no nodes', async () => {
    const id = await presetNamed('Lonely');
    await makeNode();
    expect(await nodesOf(id)).toEqual({ scope: 'preset', ruleCount: 0, nodes: [] });
  });

  it('two squads with a node in common: each node once, with the state of the transfer', async () => {
    const [a, shared, b] = [await makeNode({ name: 'a-node' }), await makeNode({ name: 'shared-node' }), await makeNode({ name: 'b-node' })];
    const pa = await presetNamed('Alpha');
    await makeSquad([a.id, shared.id], { presetId: pa });
    await makeSquad([shared.id, b.id], { presetId: pa });
    await inboundSyncQueue.obliterate({ force: true });
    expect((await put(pa, { dnsRules: dns([['example.com'], '10.99.0.1']) })).statusCode).toBe(200);
    await inboundSyncQueue.obliterate({ force: true });
    // The node that has taken its config is «sent»; the others wait for the push.
    await prisma.node.update({ where: { id: a.id }, data: { lastInboundSyncAt: new Date(), appliedRevision: 5, desiredRevision: 5 } });
    const list = await nodesOf(pa);
    expect(list.ruleCount).toBe(1);
    expect(list.nodes.map((n) => [n.name, n.state, n.carried])).toEqual([
      ['a-node', 'sent', 1],
      ['b-node', 'waiting', 1],
      ['shared-node', 'waiting', 1],
    ]);
  });

  it('gives the cores as the node reported them, none for a node that has not', async () => {
    const [x, y] = [await makeNode({ name: 'x-node' }), await makeNode({ name: 'y-node' })];
    await prisma.node.update({
      where: { id: x.id },
      data: { cores: { observedAt: new Date().toISOString(), cores: [{ name: 'xray', engine: 'xray', rendersDns: true }, { name: 'hysteria', engine: 'hysteria', rendersDns: false }] } },
    });
    const p = await presetNamed('Cores');
    await makeSquad([x.id, y.id], { presetId: p });
    const list = await nodesOf(p);
    expect(list.nodes[0]!.cores!.map((c) => [c.name, c.rendersDns])).toEqual([['xray', true], ['hysteria', false]]);
    expect(list.nodes[1]!.cores).toBeNull();
  });

  it('marks a rule the node\'s own DNS takes, a DoT rule, and a rule left out by a conflict, naming the other preset', async () => {
    const n = await makeNode({ name: 'own-dns', dns: { servers: [{ address: '9.9.9.9', domains: ['domain:example.com'] }] } });
    const pa = await presetNamed('Alpha');
    const pb = await presetNamed('Beta');
    await makeSquad([n.id], { presetId: pa });
    expect(
      (await put(pa, { dnsRules: dns([['example.com', 'other.org'], '10.99.0.1'], [['dot.example'], 'tls://dns.example'], [['clash.example'], '10.99.0.3']) })).statusCode,
    ).toBe(200);
    // 19.11 recorded that Beta's rule was left out for Alpha's.
    await prisma.node.update({
      where: { id: n.id },
      data: { presetDnsConflicts: [{ kind: 'conflict', presetId: pb, otherPresetId: pa, domain: 'clash.example', server: '10.99.0.9' }] },
    });
    await prisma.routingPreset.update({ where: { id: pb }, data: { dnsRules: dns([['clash.example'], '10.99.0.9']) } });
    await makeSquad([n.id], { presetId: pb });

    const alpha = (await nodesOf(pa)).nodes[0]!;
    expect(alpha.carried).toBe(2);
    expect(alpha.skipped).toEqual([
      { index: 0, kind: 'manual', names: ['example.com'] },
      { index: 1, kind: 'server-kind' },
    ]);
    expect((await nodesOf(pb)).nodes[0]!.skipped).toEqual([{ index: 0, kind: 'conflict', otherPreset: 'Alpha', names: ['clash.example'] }]);
  });

  it('a built-in preset has the panel-wide rules on every node', async () => {
    await makeNode({ name: 'one' });
    await makeNode({ name: 'two' });
    await prisma.appSetting.upsert({
      where: { key: 'subscriptionDnsRules' },
      update: { value: dns([['example.com'], '10.99.0.1']) },
      create: { key: 'subscriptionDnsRules', value: dns([['example.com'], '10.99.0.1']) },
    });
    const list = await nodesOf('ru-split');
    expect(list.scope).toBe('panel');
    expect(list.ruleCount).toBe(1);
    expect(list.nodes.map((n) => n.name)).toEqual(['one', 'two']);
  });

  it('refuses a missing or malformed preset', async () => {
    await nodesOf('00000000-0000-4000-8000-000000000099', 404);
    await nodesOf('not-a-uuid', 400);
  });
});
