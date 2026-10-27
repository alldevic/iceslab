import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { fetchEnabledInbounds } from '../inbounds/inbounds.queue.js';
import { reachOfUsers } from '../users/user-reach.js';
import { adapterSlotConflicts } from './node-adapter-slot.js';
import { nodeUserScopeGaps } from './node-user-scope.js';

/**
 * A-259: one profile on one node on two ports. Each binding is its own
 * inbound on the wire, its users go onto both, and the reports that read the
 * node's bindings tell the two apart by binding, not by profile.
 */
let app: FastifyInstance;
let token: string;
let seq = 0;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  token = await registerAndLogin(app);
  seq = 0;
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

async function post(url: string, payload: unknown) {
  const res = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

async function node(): Promise<string> {
  seq += 1;
  const r = await post('/api/nodes', { name: `mp-${seq}`, address: `mp-${seq}.test`, protocol: 'xray' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

async function profile(protocol: string, config: unknown): Promise<string> {
  seq += 1;
  const r = await post('/api/profiles', { name: `mp-p-${seq}`, protocol, config });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

async function bind(profileId: string, nodeId: string, port: number): Promise<string> {
  const r = await post('/api/bindings', { profileId, nodeId, port });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

const VLESS = {
  security: 'reality',
  realityDest: 'www.microsoft.com:443',
  realityServerNames: ['www.microsoft.com'],
  realityPrivateKey: 'k'.repeat(43),
  realityPublicKey: 'p'.repeat(43),
  realityShortIds: ['0123abcd'],
  network: 'raw',
};

describe('one xray profile on two ports of a node', () => {
  it('goes out as two inbounds, each its own id, and a user of the profile is put on both', async () => {
    const n = await node();
    const p = await profile('xray', VLESS);
    const a = await bind(p, n, 443);
    const b = await bind(p, n, 2048);

    const xray = (await fetchEnabledInbounds(n)).filter((i) => i.protocol === 'xray');
    expect(xray.map((i) => [i.id, i.port])).toEqual([
      [a, 443],
      [b, 2048],
    ]);
    // The id the agent tags the inbound by: one per binding, never the profile's.
    expect(xray.map((i) => (i.config as { inboundId?: string }).inboundId)).toEqual([a, b]);

    const squad = await post('/api/squads', { name: 'mp', profileIds: [p] });
    const user = await post('/api/users', { username: 'mp_user', groupIds: [squad.body.id] });
    const reach = await reachOfUsers([user.body.id as string]);
    expect([...(reach.get(user.body.id)?.get(n) ?? [])].sort()).toEqual([a, b].sort());
  });
});

describe('the node reports with two bindings of one profile', () => {
  it('a slot conflict names both bindings of the profile, and the one the node serves', async () => {
    // Two bindings of one native shadowsocks profile, as data that stood before
    // the slot refusal could see them: written past the API.
    const n = await node();
    const p = await profile('shadowsocks', { method: '2022-blake3-aes-256-gcm' });
    const low = await prisma.profileNodeBinding.create({ data: { nodeId: n, profileId: p, port: 8388, transport: 'tcp' } });
    const high = await prisma.profileNodeBinding.create({ data: { nodeId: n, profileId: p, port: 8389, transport: 'tcp' } });

    const conflicts = await adapterSlotConflicts(n);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.bindings.map((x) => x.bindingId)).toEqual([low.id, high.id]);
    expect(conflicts[0]!.servedBindingId).toBe(high.id);
  });

  it('a user-scope gap is said per binding, two mieru of one profile two rows', async () => {
    const n = await node();
    const p = await profile('mieru', { mtu: 1400 });
    const a = await bind(p, n, 2012);
    const b = await bind(p, n, 2013);
    const gaps = await nodeUserScopeGaps(n);
    expect(gaps.map((g) => [g.bindingId, g.profileId, g.port])).toEqual([
      [a, p, 2012],
      [b, p, 2013],
    ]);
  });

  it('and one mieru binding alone is no gap, the slot counted by binding', async () => {
    const n = await node();
    await bind(await profile('mieru', { mtu: 1400 }), n, 2012);
    expect(await nodeUserScopeGaps(n)).toEqual([]);
  });
});
