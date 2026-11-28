import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { presetUpdateData } from './routing-presets.assign.js';
import { makeNode, makeSquad, makeUser } from '../../../tests/helpers/preset-nodes.js';
import { inboundSyncQueue } from '../inbounds/inbounds.queue.js';

/**
 * A-229 part 1: a user or a squad holds at most one routing preset, a built-in
 * key or an own one. Refused both at once, a value on one side clears the
 * other, an absent key is no edit; the database says the same underneath.
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
const MISSING = '7b0d1c1e-0000-4000-8000-000000000000';

async function ownPreset(name = 'own-1'): Promise<string> {
  const row = await prisma.routingPreset.create({
    data: { name, rules: [{ match: ['geosite:google'], action: 'direct', note: '' }] },
  });
  return row.id;
}

describe('presetUpdateData', () => {
  it('writes what was given, clears the other side on a value, leaves absent keys alone', () => {
    expect(presetUpdateData({})).toEqual({});
    expect(presetUpdateData({ routingPreset: 'ru-split' })).toEqual({ routingPreset: 'ru-split', customRoutingPresetId: null });
    expect(presetUpdateData({ customRoutingPresetId: 'x' })).toEqual({ customRoutingPresetId: 'x', routingPreset: null });
    expect(presetUpdateData({ routingPreset: null })).toEqual({ routingPreset: null });
    expect(presetUpdateData({ customRoutingPresetId: null })).toEqual({ customRoutingPresetId: null });
    expect(presetUpdateData({ routingPreset: null, customRoutingPresetId: 'x' })).toEqual({ routingPreset: null, customRoutingPresetId: 'x' });
  });
});

describe('a user', () => {
  it('refuses both presets at once, on create and on edit, in words', async () => {
    const own = await ownPreset();
    const create = await app.inject({
      method: 'POST', url: '/api/users', headers: auth(),
      payload: { username: 'both-1', routingPreset: 'ru-split', customRoutingPresetId: own },
    });
    expect(create.statusCode).toBe(400);
    expect(create.body).toContain('both set');

    const ok = await app.inject({ method: 'POST', url: '/api/users', headers: auth(), payload: { username: 'both-2' } });
    const id = JSON.parse(ok.body).id as string;
    const edit = await app.inject({
      method: 'PUT', url: `/api/users/${id}`, headers: auth(),
      payload: { routingPreset: 'ru-split', customRoutingPresetId: own },
    });
    expect(edit.statusCode).toBe(400);
    expect(edit.body).toContain('both set');
  });

  it('refuses an own preset that does not exist, with a code and the field', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/users', headers: auth(),
      payload: { username: 'ghost-1', customRoutingPresetId: MISSING },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'ROUTING_PRESET_NOT_FOUND', field: 'customRoutingPresetId' });
  });

  it('a value on one side clears the other, null clears its own, an absent key keeps both', async () => {
    const own = await ownPreset();
    const created = await app.inject({
      method: 'POST', url: '/api/users', headers: auth(),
      payload: { username: 'swap-1', customRoutingPresetId: own },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = JSON.parse(created.body).id as string;
    expect(JSON.parse(created.body)).toMatchObject({ customRoutingPresetId: own, routingPreset: null });

    const put = async (payload: Record<string, unknown>) => {
      const r = await app.inject({ method: 'PUT', url: `/api/users/${id}`, headers: auth(), payload });
      expect(r.statusCode, r.body).toBe(200);
      return JSON.parse(r.body) as { routingPreset: string | null; customRoutingPresetId: string | null };
    };

    expect(await put({ description: 'unrelated' })).toMatchObject({ customRoutingPresetId: own, routingPreset: null });
    expect(await put({ routingPreset: 'ru-split' })).toMatchObject({ routingPreset: 'ru-split', customRoutingPresetId: null });
    expect(await put({ customRoutingPresetId: own })).toMatchObject({ customRoutingPresetId: own, routingPreset: null });
    expect(await put({ routingPreset: null })).toMatchObject({ customRoutingPresetId: own, routingPreset: null });
    expect(await put({ customRoutingPresetId: null })).toMatchObject({ customRoutingPresetId: null, routingPreset: null });
  });
});

describe('a squad', () => {
  it('refuses both presets at once and an own preset that does not exist', async () => {
    const own = await ownPreset();
    const both = await app.inject({
      method: 'POST', url: '/api/squads', headers: auth(),
      payload: { name: 'sq-both', routingPreset: 'cn-split', customRoutingPresetId: own },
    });
    expect(both.statusCode).toBe(400);
    expect(both.body).toContain('both set');

    const ghost = await app.inject({
      method: 'POST', url: '/api/squads', headers: auth(),
      payload: { name: 'sq-ghost', customRoutingPresetId: MISSING },
    });
    expect(ghost.statusCode).toBe(400);
    expect(JSON.parse(ghost.body)).toMatchObject({ error: 'ROUTING_PRESET_NOT_FOUND', field: 'customRoutingPresetId' });
    expect(await prisma.group.count({ where: { name: 'sq-ghost' } })).toBe(0);
  });

  it('a value on one side clears the other, an absent key keeps both', async () => {
    const own = await ownPreset();
    const created = await app.inject({
      method: 'POST', url: '/api/squads', headers: auth(),
      payload: { name: 'sq-swap', routingPreset: 'ru-split' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = JSON.parse(created.body).id as string;

    const put = async (payload: Record<string, unknown>) => {
      const r = await app.inject({ method: 'PUT', url: `/api/squads/${id}`, headers: auth(), payload });
      expect(r.statusCode, r.body).toBe(200);
      return JSON.parse(r.body) as { routingPreset: string | null; customRoutingPresetId: string | null };
    };

    expect(await put({ customRoutingPresetId: own })).toMatchObject({ customRoutingPresetId: own, routingPreset: null });
    expect(await put({ description: 'unrelated' })).toMatchObject({ customRoutingPresetId: own, routingPreset: null });
    expect(await put({ routingPreset: 'cn-split' })).toMatchObject({ routingPreset: 'cn-split', customRoutingPresetId: null });
  });
});

describe('a preset deleted between the check and the write', () => {
  // The check is passed by a stand-in that says the row exists; the write then
  // meets the database without it, as after a delete in between.
  let spy: ReturnType<typeof vi.spyOn> | undefined;
  const passCheckOnce = () => {
    spy?.mockRestore();
    spy = vi.spyOn(prisma.routingPreset, 'findUnique').mockResolvedValueOnce({ id: MISSING } as never);
  };
  afterEach(() => vi.restoreAllMocks());

  it('is the same 400 ROUTING_PRESET_NOT_FOUND, not a 500, on every write of a user and a squad', async () => {
    const expectGone = (res: { statusCode: number; body: string }, what: string) => {
      // The stand-in answered the check, so this refusal came from the write.
      expect(spy!.mock.calls.length, `${what}: the check was not the stand-in`).toBe(1);
      expect(res.statusCode, `${what}: ${res.body}`).toBe(400);
      expect(JSON.parse(res.body), what).toMatchObject({ error: 'ROUTING_PRESET_NOT_FOUND', field: 'customRoutingPresetId' });
    };

    passCheckOnce();
    expectGone(
      await app.inject({ method: 'POST', url: '/api/users', headers: auth(), payload: { username: 'race-1', customRoutingPresetId: MISSING } }),
      'user create',
    );

    const user = await app.inject({ method: 'POST', url: '/api/users', headers: auth(), payload: { username: 'race-2' } });
    passCheckOnce();
    expectGone(
      await app.inject({ method: 'PUT', url: `/api/users/${JSON.parse(user.body).id}`, headers: auth(), payload: { customRoutingPresetId: MISSING } }),
      'user edit',
    );

    passCheckOnce();
    expectGone(
      await app.inject({ method: 'POST', url: '/api/squads', headers: auth(), payload: { name: 'race-sq', customRoutingPresetId: MISSING } }),
      'squad create',
    );

    const squad = await app.inject({ method: 'POST', url: '/api/squads', headers: auth(), payload: { name: 'race-sq-2' } });
    passCheckOnce();
    expectGone(
      await app.inject({ method: 'PUT', url: `/api/squads/${JSON.parse(squad.body).id}`, headers: auth(), payload: { customRoutingPresetId: MISSING } }),
      'squad edit',
    );
  });
});

describe('the database underneath', () => {
  it('refuses a row holding both, and the deletion of a preset in use', async () => {
    const own = await ownPreset();
    const user = await app.inject({
      method: 'POST', url: '/api/users', headers: auth(),
      payload: { username: 'db-1', customRoutingPresetId: own },
    });
    const id = JSON.parse(user.body).id as string;

    await expect(
      prisma.$executeRawUnsafe(`UPDATE "users" SET "routing_preset" = 'ru-split' WHERE "id" = $1::uuid`, id),
    ).rejects.toThrow(/users_one_routing_preset/);
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "groups" SET "routing_preset" = 'ru-split', "custom_routing_preset_id" = $1::uuid WHERE "name" = 'All'`,
        own,
      ),
    ).rejects.toThrow(/groups_one_routing_preset/);
    await expect(prisma.routingPreset.delete({ where: { id: own } })).rejects.toThrow();
    expect(await prisma.routingPreset.count()).toBe(1);
  });
});

describe('19.11: an assignment moves the carried DNS rules', () => {
  const rule = (match: string, server: string) => ({ match: [match], server, note: '' });
  const preset = async (name: string, ...rules: ReturnType<typeof rule>[]) =>
    (await prisma.routingPreset.create({ data: { name, dnsRules: rules }, select: { id: true } })).id;
  const carried = async (nodeId: string) => (await prisma.node.findUniqueOrThrow({ where: { id: nodeId }, select: { presetDnsRules: true } })).presetDnsRules;
  const queued = async (nodeId: string) => !!(await inboundSyncQueue.getJob(`apply-${nodeId}`));
  const rows = (id: string, match = 'example.com', server = '10.99.0.1') => [{ presetId: id, rules: [{ match: [match], server }] }];
  const putSquad = (id: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: `/api/squads/${id}`, headers: auth(), payload });
  const putUser = (id: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: `/api/users/${id}`, headers: auth(), payload });

  beforeEach(() => inboundSyncQueue.obliterate({ force: true }));
  afterEach(() => inboundSyncQueue.obliterate({ force: true }));

  it('a squad given a preset carries its rules to its nodes; another preset replaces them; none takes them off', async () => {
    const [n1, n2, out] = [await makeNode(), await makeNode(), await makeNode()];
    const pa = await preset('Alpha', rule('example.com', '10.99.0.1'));
    const pb = await preset('Beta', rule('other.com', '10.99.0.2'));
    const squad = await makeSquad([n1.id, n2.id]);

    let res = await putSquad(squad.id, { customRoutingPresetId: pa });
    expect(res.statusCode, res.body).toBe(200);
    expect(await carried(n1.id)).toEqual(rows(pa));
    expect(await carried(n2.id)).toEqual(rows(pa));
    expect(await carried(out.id)).toBeNull();
    expect(await queued(n1.id)).toBe(true);
    expect(await queued(out.id)).toBe(false);

    res = await putSquad(squad.id, { customRoutingPresetId: pb });
    expect(res.statusCode, res.body).toBe(200);
    expect(await carried(n1.id)).toEqual(rows(pb, 'other.com', '10.99.0.2'));

    res = await putSquad(squad.id, { routingPreset: 'ru-split' });
    expect(res.statusCode, res.body).toBe(200);
    expect(await carried(n1.id)).toBeNull();
    expect(await carried(n2.id)).toBeNull();
  });

  it('a squad created with a preset carries its rules to the nodes of its profiles', async () => {
    const n = await makeNode();
    const pa = await preset('Alpha', rule('example.com', '10.99.0.1'));
    const { profileId } = await makeSquad([n.id]);
    const res = await app.inject({
      method: 'POST', url: '/api/squads', headers: auth(),
      payload: { name: 'with-preset', profileIds: [profileId], customRoutingPresetId: pa },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(await carried(n.id)).toEqual(rows(pa));
    expect(await queued(n.id)).toBe(true);
  });

  it('a squad assignment that gives one name two servers on a shared node is refused with the field, naming the other preset and the node; nothing is written', async () => {
    const shared = await makeNode({ name: 'shared-node' });
    const pa = await preset('Alpha', rule('example.com', '10.99.0.1'));
    const pb = await preset('Beta', rule('domain:example.com', '10.99.0.2'));
    await makeSquad([shared.id], { presetId: pa });
    const other = await makeSquad([shared.id]);
    await prisma.node.update({ where: { id: shared.id }, data: { presetDnsRules: rows(pa) } });
    await inboundSyncQueue.obliterate({ force: true });

    const res = await putSquad(other.id, { customRoutingPresetId: pb });
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({
      error: 'ROUTING_PRESET_DNS_CONFLICT', field: 'customRoutingPresetId', preset: 'Alpha', node: 'shared-node',
    });
    expect((await prisma.group.findUniqueOrThrow({ where: { id: other.id } })).customRoutingPresetId).toBeNull();
    expect(await carried(shared.id)).toEqual(rows(pa));
    expect(await queued(shared.id)).toBe(false);

    const created = await app.inject({
      method: 'POST', url: '/api/squads', headers: auth(),
      payload: { name: 'refused', profileIds: [other.profileId], customRoutingPresetId: pb },
    });
    expect(created.statusCode, created.body).toBe(409);
    expect(await prisma.group.findUnique({ where: { name: 'refused' } })).toBeNull();
  });

  it('a user given a preset carries it to the nodes of their squads; the same refusal on a conflict, nothing written', async () => {
    const [n1, shared] = [await makeNode(), await makeNode({ name: 'shared-node' })];
    const pa = await preset('Alpha', rule('example.com', '10.99.0.1'));
    const pb = await preset('Beta', rule('example.com', '10.99.0.2'));
    const pc = await preset('Gamma', rule('example.com', '10.99.0.1'));
    const squad = await makeSquad([n1.id, shared.id]);
    const user = await makeUser({ squadId: squad.id });
    await makeSquad([shared.id], { presetId: pa });
    await prisma.node.update({ where: { id: shared.id }, data: { presetDnsRules: rows(pa) } });
    await inboundSyncQueue.obliterate({ force: true });

    let res = await putUser(user.id, { customRoutingPresetId: pb });
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'ROUTING_PRESET_DNS_CONFLICT', field: 'customRoutingPresetId', preset: 'Alpha', node: 'shared-node' });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).customRoutingPresetId).toBeNull();
    expect(await carried(n1.id)).toBeNull();

    // The same server for the name is no conflict: both presets are carried on the shared node.
    res = await putUser(user.id, { customRoutingPresetId: pc });
    expect(res.statusCode, res.body).toBe(200);
    expect(await carried(n1.id)).toEqual(rows(pc));
    expect(await carried(shared.id)).toEqual([...rows(pa), ...rows(pc)]);
    expect(await queued(n1.id)).toBe(true);

    // Taking the preset off takes its rules off both nodes, and leaves the squad's preset on the shared one.
    res = await putUser(user.id, { customRoutingPresetId: null });
    expect(res.statusCode, res.body).toBe(200);
    expect(await carried(n1.id)).toBeNull();
    expect(await carried(shared.id)).toEqual(rows(pa));
  });

  it('a user created with a preset carries it to the nodes of their squads', async () => {
    const n = await makeNode();
    const pa = await preset('Alpha', rule('example.com', '10.99.0.1'));
    const squad = await makeSquad([n.id]);
    const res = await app.inject({
      method: 'POST', url: '/api/users', headers: auth(),
      payload: { username: 'carrier', groupIds: [squad.id], customRoutingPresetId: pa },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(await carried(n.id)).toEqual(rows(pa));
    expect(await queued(n.id)).toBe(true);
  });
});

describe('19.15: the default preset follows a squad taking or leaving a preset of its own', () => {
  const rule = (match: string, server: string) => ({ match: [match], server, note: '' });
  const carried = async (nodeId: string) => (await prisma.node.findUniqueOrThrow({ where: { id: nodeId }, select: { presetDnsRules: true } })).presetDnsRules;
  const queued = async (nodeId: string) => !!(await inboundSyncQueue.getJob(`apply-${nodeId}`));
  beforeEach(() => inboundSyncQueue.obliterate({ force: true }));
  afterEach(() => inboundSyncQueue.obliterate({ force: true }));

  it('a squad given a preset of its own loses the default rules on its nodes; one that lets go gets them back; the changed nodes are pushed', async () => {
    const [n1, n2] = [await makeNode(), await makeNode()];
    const d = (await prisma.routingPreset.create({ data: { name: 'Default', dnsRules: [rule('d.com', '10.99.0.1')] }, select: { id: true } })).id;
    const q = (await prisma.routingPreset.create({ data: { name: 'Own', dnsRules: [rule('q.com', '10.99.0.2')] }, select: { id: true } })).id;
    const s1 = await makeSquad([n1.id]);
    await makeSquad([n2.id]);
    let res = await app.inject({ method: 'PUT', url: '/api/settings', headers: auth(), payload: { subscriptionDefaultPresetId: d } });
    expect(res.statusCode, res.body).toBe(200);
    expect(await carried(n1.id)).toEqual([{ presetId: d, rules: [{ match: ['d.com'], server: '10.99.0.1' }] }]);
    expect(await queued(n1.id) && (await queued(n2.id))).toBe(true);
    await inboundSyncQueue.obliterate({ force: true });

    res = await app.inject({ method: 'PUT', url: `/api/squads/${s1.id}`, headers: auth(), payload: { customRoutingPresetId: q } });
    expect(res.statusCode, res.body).toBe(200);
    expect(await carried(n1.id)).toEqual([{ presetId: q, rules: [{ match: ['q.com'], server: '10.99.0.2' }] }]);
    expect(await carried(n2.id)).toEqual([{ presetId: d, rules: [{ match: ['d.com'], server: '10.99.0.1' }] }]);
    expect(await queued(n1.id)).toBe(true);
    expect(await queued(n2.id)).toBe(false);

    res = await app.inject({ method: 'PUT', url: `/api/squads/${s1.id}`, headers: auth(), payload: { customRoutingPresetId: null } });
    expect(res.statusCode, res.body).toBe(200);
    expect(await carried(n1.id)).toEqual([{ presetId: d, rules: [{ match: ['d.com'], server: '10.99.0.1' }] }]);
  });

  it('changing the default recomputes and pushes only the nodes whose rules changed', async () => {
    const [bare, held] = [await makeNode(), await makeNode()];
    const [d1, d2] = [
      (await prisma.routingPreset.create({ data: { name: 'D1', dnsRules: [rule('one.com', '10.99.0.1')] }, select: { id: true } })).id,
      (await prisma.routingPreset.create({ data: { name: 'D2', dnsRules: [rule('two.com', '10.99.0.2')] }, select: { id: true } })).id,
    ];
    const q = (await prisma.routingPreset.create({ data: { name: 'Own' }, select: { id: true } })).id;
    await makeSquad([bare.id]);
    await makeSquad([held.id], { presetId: q });
    const put = (v: string | null) => app.inject({ method: 'PUT', url: '/api/settings', headers: auth(), payload: { subscriptionDefaultPresetId: v } });
    expect((await put(d1)).statusCode).toBe(200);
    await inboundSyncQueue.obliterate({ force: true });
    expect((await put(d2)).statusCode).toBe(200);
    expect(await carried(bare.id)).toEqual([{ presetId: d2, rules: [{ match: ['two.com'], server: '10.99.0.2' }] }]);
    expect(await queued(bare.id)).toBe(true);
    expect(await queued(held.id)).toBe(false);
    // The same value again changes nothing and pushes nothing.
    await inboundSyncQueue.obliterate({ force: true });
    expect((await put(d2)).statusCode).toBe(200);
    expect(await queued(bare.id)).toBe(false);
  });
});
