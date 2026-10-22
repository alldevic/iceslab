import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddUserRequest } from '@iceslab/shared';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { NodeTransport, NodeRequestError } from '../nodes/nodes.transport.js';
import { observedCores } from '../nodes/nodes.cron.js';
import { reachOfUsers } from './user-reach.js';
import { syncAddUser } from './users.queue.js';
import { applyInboundsForNode } from '../inbounds/inbounds.queue.js';

/**
 * A-022: a user is rolled out only onto the nodes and inbounds their squads
 * reach, by the subscription's own rule. A-164: with the AmneziaWG addresses
 * of the node, so a new or returning user has AWG without waiting for a push.
 */
let app: FastifyInstance;
let token: string;
let seq = 0;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  token = await registerAndLogin(app);
  seq = 0;
  vi.spyOn(NodeTransport.prototype, 'listAssets').mockRejectedValue(new NodeRequestError('404', 404, null));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

const auth = () => ({ authorization: `Bearer ${token}` });
async function post(url: string, payload: unknown) {
  const res = await app.inject({ method: 'POST', url, headers: auth(), payload });
  expect(res.statusCode, res.body).toBeLessThan(300);
  return JSON.parse(res.body);
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
const awg = (subnet: string) => ({ serverPrivateKey: 'a'.repeat(44), serverPublicKey: 'b'.repeat(44), subnet, obfuscation: {} });

async function node(pushed = true): Promise<string> {
  seq += 1;
  const n = await post('/api/nodes', { name: `reach-${seq}`, address: `reach-${seq}.test`, protocol: 'xray' });
  if (pushed) await prisma.node.update({ where: { id: n.id }, data: { lastInboundSyncAt: new Date() } });
  return n.id as string;
}
async function profile(protocol: string, config: unknown, extra: Record<string, unknown> = {}): Promise<string> {
  seq += 1;
  return (await post('/api/profiles', { name: `reach-p-${seq}`, protocol, config, ...extra })).id as string;
}
async function host(profileId: string, nodeId: string, port: number, remark = 'Default'): Promise<{ id: string; bindingId: string }> {
  const h = await post('/api/hosts', { profileId, nodeId, port, remark });
  return { id: h.id, bindingId: h.bindingId };
}
async function user(name: string, groupIds: string[]): Promise<string> {
  return (await post('/api/users', { username: name, groupIds })).id as string;
}

function capture() {
  const added: { node: string; req: AddUserRequest }[] = [];
  const removed: string[] = [];
  vi.spyOn(NodeTransport.prototype, 'addUser').mockImplementation(async function (this: { node?: { name?: string } }, req) {
    added.push({ node: (this as unknown as { node: { name: string } }).node?.name ?? '', req });
    return { ok: true };
  });
  vi.spyOn(NodeTransport.prototype, 'removeUser').mockImplementation(async function (this: unknown) {
    removed.push((this as { node: { name: string } }).node?.name ?? '');
    return { ok: true };
  });
  return { added, removed };
}

describe('reachOfUsers', () => {
  it('follows profiles granted by squads and narrows by host rows', async () => {
    const a = await node();
    const b = await node();
    const p = await profile('xray', VLESS);
    const onA = await host(p, a, 443, 'A');
    const onB = await host(p, b, 443, 'B');
    const all = await post('/api/squads', { name: 'all-hosts', profileIds: [p] });
    const narrow = await post('/api/squads', { name: 'only-a', profileIds: [p], hostIds: [onA.id] });
    const u1 = await user('reach_all', [all.id]);
    const u2 = await user('reach_narrow', [narrow.id]);
    const none = await post('/api/squads', { name: 'nothing', profileIds: [] });
    const u3 = await user('reach_none', [none.id]);
    const r = await reachOfUsers([u1, u2, u3]);
    expect(r.get(u1)).toEqual(new Map([[a, [onA.bindingId]], [b, [onB.bindingId]]]));
    expect(r.get(u2)).toEqual(new Map([[a, [onA.bindingId]]]));
    expect(r.get(u3)).toBeUndefined();
  });
});

describe('rolling a user out (syncAddUser)', () => {
  it('adds on the reached node with its inbounds, removes elsewhere, skips a node never pushed', async () => {
    const a = await node();
    const b = await node();
    const fresh = await node(false);
    const p = await profile('xray', VLESS);
    const onA = await host(p, a, 443, 'A');
    await host(p, fresh, 443, 'F');
    const sq = await post('/api/squads', { name: 'sq', profileIds: [p] });
    const u = await user('rollout_user', [sq.id]);
    const { added, removed } = capture();
    await syncAddUser(u);
    expect(added.map((x) => [x.node, x.req.inboundIds])).toEqual([[`reach-1`, [onA.bindingId]]]);
    expect(removed).toEqual([`reach-2`]);
    void b;
  });

  it('carries the AmneziaWG addresses of both generations without a push (A-164)', async () => {
    const n = await node();
    await prisma.node.update({
      where: { id: n },
      data: {
        cores: observedCores(
          [{ name: 'amneziawg', engine: 'amneziawg', running: true, installed: true, awgProtocol: 3, awgGenerations: [1, 3] }],
          new Date().toISOString(),
        ) as unknown as object,
      },
    });
    const one = await profile('amneziawg', awg('10.66.66.0/24'));
    const three = await profile('amneziawg', awg('10.67.67.0/24'), { awgProtocol: 3 });
    await host(one, n, 51820);
    await host(three, n, 51830);
    const sq = await post('/api/squads', { name: 'awg', profileIds: [one, three] });
    const u = await user('awg_user', [sq.id]);
    const { added } = capture();
    await syncAddUser(u);
    expect(added).toHaveLength(1);
    expect(added[0]!.req.credentials.amneziawgAllowedIp).toMatch(/^10\.66\.66\./);
    expect(added[0]!.req.credentials.amneziawgAllowedIp3).toMatch(/^10\.67\.67\./);
  });

  it('a returning user (expired -> active by an extension) is rolled out the same way', async () => {
    const n = await node();
    const p = await profile('xray', VLESS);
    const h = await host(p, n, 443);
    const sq = await post('/api/squads', { name: 'back', profileIds: [p] });
    const u = await user('back_user', [sq.id]);
    await prisma.user.update({ where: { id: u }, data: { status: 'expired', expireAt: new Date(Date.now() - 86400_000) } });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/users/${u}`,
      headers: auth(),
      payload: { expireAt: new Date(Date.now() + 30 * 86400_000).toISOString() },
    });
    expect(res.statusCode, res.body).toBe(200);
    const { added } = capture();
    await syncAddUser(u);
    expect(added.map((x) => x.req.inboundIds)).toEqual([[h.bindingId]]);
  });
});

describe('the push hands users out by reach', () => {
  it('a reaching user gets the node inbounds, a member of another squad an empty list', async () => {
    const n = await node();
    const p = await profile('xray', VLESS);
    const h = await host(p, n, 443);
    const sq = await post('/api/squads', { name: 'in', profileIds: [p] });
    const other = await post('/api/squads', { name: 'out', profileIds: [] });
    const inside = await user('push_in', [sq.id]);
    const outside = await user('push_out', [other.id]);
    vi.spyOn(NodeTransport.prototype, 'applyInbounds').mockResolvedValue({ ok: true, applied: 1, skipped: 0 });
    const { added } = capture();
    await applyInboundsForNode(n);
    const byUser = new Map(added.map((x) => [x.req.userId, x.req.inboundIds]));
    expect(byUser.get(inside)).toEqual([h.bindingId]);
    expect(byUser.get(outside)).toEqual([]);
  });
});
