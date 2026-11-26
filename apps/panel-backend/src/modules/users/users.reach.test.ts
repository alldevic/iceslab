import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { inflateSync } from 'node:zlib';
import type { AddUserRequest } from '@iceslab/shared';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { NodeTransport, NodeRequestError } from '../nodes/nodes.transport.js';
import { observedCores } from '../nodes/nodes.cron.js';
import { reachOfUsers } from './user-reach.js';
import { nodeUsersQueue, syncAddUser } from './users.queue.js';
import { registerUserEventHandlers } from './users.events.js';
import { applyInboundsForNode } from '../inbounds/inbounds.queue.js';
import { registerInboundEventHandlers } from '../inbounds/inbounds.events.js';
import { generateSubscription } from '../subscription/subscription.service.js';
import { getLogger } from '../../lib/infra/logger.js';
import { WG_TEST_PRIVATE_KEY, WG_TEST_PUBLIC_KEY } from '../../../tests/helpers/wg-keys.js';

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
const awg = (subnet: string) => ({ serverPrivateKey: WG_TEST_PRIVATE_KEY, serverPublicKey: WG_TEST_PUBLIC_KEY, subnet, obfuscation: {} });

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
  // A-112: the roster after a push goes over /addUsers; each entry is
  // recorded exactly as one /addUser.
  vi.spyOn(NodeTransport.prototype, 'addUsers').mockImplementation(async function (this: unknown, batch) {
    const node = (this as { node?: { name?: string } }).node?.name ?? '';
    for (const req of batch.users) added.push({ node, req });
    return { results: batch.users.map((u) => ({ userId: u.userId, ok: true })) };
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

describe('a host change moves the reach, and the node is pushed (A-215)', () => {
  it('a squad narrowed to H2: creating H2 on the existing binding queues the push, and the push puts the user on', async () => {
    registerInboundEventHandlersOnce();
    const n = await node();
    const p = await profile('xray', VLESS);
    const h1 = await host(p, n, 443, 'H1');
    const before = (await prisma.node.findUniqueOrThrow({ where: { id: n } })).desiredRevision;

    // The squad narrowed to a host that does not exist yet is created after it;
    // first H2 on the same binding, then the squad naming it.
    const h2 = await post('/api/hosts', { bindingId: h1.bindingId, remark: 'H2' });
    await expect
      .poll(async () => (await prisma.node.findUniqueOrThrow({ where: { id: n } })).desiredRevision, { timeout: 5000 })
      .toBeGreaterThan(before);

    const sq = await post('/api/squads', { name: 'h2-only', profileIds: [p], hostIds: [h2.id] });
    const u = await user('h2_user', [sq.id]);
    vi.spyOn(NodeTransport.prototype, 'applyInbounds').mockResolvedValue({ ok: true, applied: 1, skipped: 0 });
    const { added } = capture();
    await applyInboundsForNode(n);
    expect(added.find((x) => x.req.userId === u)?.req.inboundIds).toEqual([h1.bindingId]);

    // H2 switched off: the user reaches nothing there, the node is pushed again.
    const mid = (await prisma.node.findUniqueOrThrow({ where: { id: n } })).desiredRevision;
    const off = await app.inject({ method: 'PUT', url: `/api/hosts/${h2.id}`, headers: auth(), payload: { enabled: false } });
    expect(off.statusCode, off.body).toBe(200);
    await expect
      .poll(async () => (await prisma.node.findUniqueOrThrow({ where: { id: n } })).desiredRevision, { timeout: 5000 })
      .toBeGreaterThan(mid);
    added.length = 0;
    await applyInboundsForNode(n);
    expect(added.find((x) => x.req.userId === u)?.req.inboundIds).toEqual([]);
  });
});

describe('a cascade switched off for a squad on a hysteria entry (A-116)', () => {
  it('its members are not put on the entry inbound and get no host; a second squad that keeps it brings both back', async () => {
    seq += 1;
    const entry = (await post('/api/nodes', { name: `hy-entry-${seq}`, address: `hy-entry-${seq}.test`, protocol: 'hysteria' }))
      .id as string;
    await prisma.node.update({ where: { id: entry }, data: { lastInboundSyncAt: new Date() } });
    const exit = await node();
    const p = await profile('hysteria', { obfsPassword: 'salt' });
    const h = await host(p, entry, 443, 'HY');
    const c = await prisma.cascade.create({ data: { name: 'hy-c', enabled: true, mode: 'chain' }, select: { id: true } });
    await prisma.cascadePosition.create({
      data: { cascadeId: c.id, position: 0, entryProtocol: 'hysteria', nodes: { create: [{ nodeId: entry }] } },
    });
    await prisma.cascadeDirection.create({
      data: { cascadeId: c.id, tag: 1, countryCode: 'NL', nodes: { create: [{ nodeId: exit }] } },
    });

    const off = await post('/api/squads', { name: 'hy-off', profileIds: [p], exitAcl: [{ cascadeId: c.id, directionIds: [] }] });
    const u = await user('hy_off_user', [off.id]);
    const hyHosts = async () => {
      const token = (await prisma.user.findUniqueOrThrow({ where: { id: u }, select: { subscriptionToken: true } }))
        .subscriptionToken;
      const sub = await generateSubscription(token, { ip: '127.0.0.1', userAgent: '' });
      return sub.endpoints.filter((e) => e.protocol === 'hysteria').length;
    };

    vi.spyOn(NodeTransport.prototype, 'applyInbounds').mockResolvedValue({ ok: true, applied: 1, skipped: 0 });
    const { added } = capture();
    await applyInboundsForNode(entry);
    expect(added.find((x) => x.req.userId === u)?.req.inboundIds).toEqual([]);
    expect((await reachOfUsers([u])).get(u)?.get(entry)).toBeUndefined();
    expect(await hyHosts()).toBe(0);

    // The same user in a second squad that grants the profile and keeps the
    // cascade on: the union reaches the entry again.
    const on = await post('/api/squads', { name: 'hy-on', profileIds: [p] });
    await prisma.groupMember.create({ data: { userId: u, groupId: on.id } });
    added.length = 0;
    await applyInboundsForNode(entry);
    expect(added.find((x) => x.req.userId === u)?.req.inboundIds).toEqual([h.bindingId]);
    expect(await hyHosts()).toBe(1);
  });
});

let handlersOn = false;
function registerInboundEventHandlersOnce(): void {
  if (handlersOn) return;
  handlersOn = true;
  registerInboundEventHandlers();
}
describe('plain WireGuard credentials (9.2)', () => {
  const wg = (subnet: string) => ({ serverPrivateKey: WG_TEST_PRIVATE_KEY, serverPublicKey: WG_TEST_PUBLIC_KEY, subnet });

  it('the push carries wireguardPublicKey/wireguardAllowedIp only for a user reaching a wireguard binding, and its inbound with the port', async () => {
    const n = await node();
    const w = await profile('wireguard', wg('10.77.77.0/24'));
    const x = await profile('xray', VLESS);
    const onW = await host(w, n, 51830);
    await host(x, n, 443);
    const withWg = await post('/api/squads', { name: 'wg', profileIds: [w] });
    const withoutWg = await post('/api/squads', { name: 'no-wg', profileIds: [x] });
    const a = await user('wg_user', [withWg.id]);
    const b = await user('xray_user', [withoutWg.id]);
    const sent: { inbounds?: { protocol: string; config: Record<string, unknown> }[] }[] = [];
    vi.spyOn(NodeTransport.prototype, 'applyInbounds').mockImplementation(async (req) => {
      sent.push(req as never);
      return { ok: true, applied: 2, skipped: 0 };
    });
    const { added } = capture();
    await applyInboundsForNode(n);

    const byUser = new Map(added.map((r) => [r.req.userId, r.req.credentials]));
    const key = (await prisma.user.findUniqueOrThrow({ where: { id: a }, select: { amneziawgPublicKey: true } }))
      .amneziawgPublicKey;
    expect(byUser.get(a)).toMatchObject({ wireguardPublicKey: key });
    expect(byUser.get(a)!.wireguardAllowedIp).toMatch(/^10\.77\.77\./);
    // The AmneziaWG address is not the plain one, and there is none here.
    expect(byUser.get(a)!.amneziawgAllowedIp).toBeUndefined();
    expect(byUser.get(b)!.wireguardPublicKey).toBeUndefined();
    expect(byUser.get(b)!.wireguardAllowedIp).toBeUndefined();
    expect(JSON.stringify(byUser.get(b))).not.toContain('wireguard');

    // The pushed inbound: the binding's port and id injected, no obfuscation.
    const ib = sent[0]!.inbounds!.find((i) => i.protocol === 'wireguard')!;
    expect(ib.config).toEqual({
      ...wg('10.77.77.0/24'),
      listenPort: 51830,
      inboundId: onW.bindingId,
    });
  });

  it('a user rolled out without a push (syncAddUser) gets the plain address too, beside the AmneziaWG one', async () => {
    const n = await node();
    const w = await profile('wireguard', wg('10.77.77.0/24'));
    const one = await profile('amneziawg', awg('10.66.66.0/24'));
    await host(w, n, 51830);
    await host(one, n, 51820);
    const sq = await post('/api/squads', { name: 'both', profileIds: [w, one] });
    const u = await user('both_user', [sq.id]);
    const { added } = capture();
    await syncAddUser(u);
    expect(added).toHaveLength(1);
    const c = added[0]!.req.credentials;
    expect(c.wireguardAllowedIp).toMatch(/^10\.77\.77\./);
    expect(c.amneziawgAllowedIp).toMatch(/^10\.66\.66\./);
    expect(c.wireguardPublicKey).toBe(c.amneziawgPublicKey);
    // The same address on every node of the profile: it is keyed on the profile
    // and the device (9.4: the user's three devices, device 1 the single field).
    const peers = await prisma.amneziawgPeer.findMany({ where: { profileId: w, userId: u } });
    expect(peers).toHaveLength(3);
    expect(c.amneziawgPeers).toHaveLength(3);
    expect(c.amneziawgPeers!.map((p) => p.wireguardAllowedIp).sort()).toEqual(peers.map((p) => p.ip).sort());
    expect(c.amneziawgPeers![0]!.wireguardAllowedIp).toBe(c.wireguardAllowedIp);
  });

  it('a node without a wireguard binding gets a user request equal to the base: no wireguard key at all', async () => {
    const n = await node();
    const one = await profile('amneziawg', awg('10.66.66.0/24'));
    await host(one, n, 51820);
    const sq = await post('/api/squads', { name: 'awg-only', profileIds: [one] });
    const u = await user('awg_only', [sq.id]);
    const { added } = capture();
    await syncAddUser(u);
    expect(Object.keys(added[0]!.req.credentials).filter((k) => k.startsWith('wireguard'))).toEqual([]);
  });
});

describe('WireGuard devices in the roster (9.4)', () => {
  const wg = (subnet: string) => ({ serverPrivateKey: WG_TEST_PRIVATE_KEY, serverPublicKey: WG_TEST_PUBLIC_KEY, subnet });

  async function wgNode() {
    const n = await node();
    vi.spyOn(NodeTransport.prototype, 'applyInbounds').mockResolvedValue({ ok: true, applied: 3, skipped: 0 } as never);
    await prisma.node.update({
      where: { id: n },
      data: {
        cores: observedCores(
          [
            { name: 'amneziawg', engine: 'amneziawg', running: true, installed: true, awgProtocol: 3, awgGenerations: [1, 3] },
            { name: 'wireguard', engine: 'wireguard', running: true, installed: true },
            { name: 'xray', engine: 'xray', running: true, installed: true },
          ],
          new Date().toISOString(),
        ) as unknown as object,
      },
    });
    const one = await profile('amneziawg', awg('10.66.66.0/24'));
    const three = await profile('amneziawg', awg('10.67.67.0/24'), { awgProtocol: 3 });
    const plain = await profile('wireguard', wg('10.77.77.0/24'));
    await host(one, n, 51820);
    await host(three, n, 51830);
    await host(plain, n, 51840);
    const sq = await post('/api/squads', { name: 'all-wg', profileIds: [one, three, plain] });
    return { n, sq };
  }

  it('the push carries a peer per device, each with its address on every interface, and device 1 in the single fields', async () => {
    const { n, sq } = await wgNode();
    const a = await user('dev_user', [sq.id]);
    const { added } = capture();
    await applyInboundsForNode(n);

    const c = added.find((r) => r.req.userId === a)!.req.credentials;
    const own = await prisma.user.findUniqueOrThrow({ where: { id: a }, select: { amneziawgPublicKey: true } });
    expect(c.amneziawgPeers).toHaveLength(3);
    const peers = c.amneziawgPeers!;
    expect(new Set(peers.map((p) => p.publicKey)).size).toBe(3);
    for (const [i, p] of peers.entries()) {
      expect(p.allowedIp).toBe(`10.66.66.${i + 2}`);
      expect(p.allowedIp3).toBe(`10.67.67.${i + 2}`);
      expect(p.wireguardAllowedIp).toBe(`10.77.77.${i + 2}`);
    }
    // For an agent older than the list: device 1, which is the user's own key.
    expect(peers[0]!.publicKey).toBe(own.amneziawgPublicKey);
    expect(c).toMatchObject({
      amneziawgPublicKey: own.amneziawgPublicKey,
      amneziawgAllowedIp: '10.66.66.2',
      amneziawgAllowedIp3: '10.67.67.2',
      wireguardPublicKey: own.amneziawgPublicKey,
      wireguardAllowedIp: '10.77.77.2',
    });
  });

  it("rolling one user out sends the same peers as the push (the number is the user's limit)", async () => {
    const { n, sq } = await wgNode();
    const two = await post('/api/users', { username: 'two_dev', groupIds: [sq.id], hwidDeviceLimit: 2 });
    const unlimited = await post('/api/users', { username: 'zero_dev', groupIds: [sq.id], hwidDeviceLimit: 0 });
    const viaPush = capture();
    await applyInboundsForNode(n);
    const pushed = new Map(viaPush.added.map((r) => [r.req.userId as string, r.req.credentials.amneziawgPeers]));
    expect(pushed.get(two.id)).toHaveLength(2);
    expect(pushed.get(unlimited.id)).toHaveLength(3);

    vi.restoreAllMocks();
    vi.spyOn(NodeTransport.prototype, 'listAssets').mockRejectedValue(new NodeRequestError('404', 404, null));
    const viaRollout = capture();
    await syncAddUser(two.id);
    await syncAddUser(unlimited.id);
    const rolled = new Map(viaRollout.added.map((r) => [r.req.userId as string, r.req.credentials.amneziawgPeers]));
    expect(rolled.get(two.id)).toEqual(pushed.get(two.id));
    expect(rolled.get(unlimited.id)).toEqual(pushed.get(unlimited.id));
  });

  it('a user who reaches no WireGuard binding gets no peer list at all (nothing to change for the agent)', async () => {
    const { n } = await wgNode();
    const x = await profile('xray', VLESS);
    await host(x, n, 443);
    const sq = await post('/api/squads', { name: 'xray-only', profileIds: [x] });
    const b = await user('no_wg', [sq.id]);
    const { added } = capture();
    await applyInboundsForNode(n);
    const c = added.find((r) => r.req.userId === b)!.req.credentials;
    expect(c.amneziawgPeers).toBeUndefined();
    expect(c.amneziawgAllowedIp).toBeUndefined();
    expect(await prisma.wgDevice.count({ where: { userId: b } })).toBe(0);
  });

  it('reissuing the credentials reissues every active device, keeps their number and addresses, and device 1 is the new user key', async () => {
    const { n, sq } = await wgNode();
    const a = await user('reissue_dev', [sq.id]);
    const first = capture();
    await applyInboundsForNode(n);
    const before = first.added.find((r) => r.req.userId === a)!.req.credentials.amneziawgPeers!;
    expect(before).toHaveLength(3);

    const res = await app.inject({ method: 'POST', url: `/api/users/${a}/reissue-credentials`, headers: auth() });
    expect(res.statusCode, res.body).toBeLessThan(300);
    vi.restoreAllMocks();
    vi.spyOn(NodeTransport.prototype, 'listAssets').mockRejectedValue(new NodeRequestError('404', 404, null));
    const second = capture();
    await syncAddUser(a);
    const after = second.added.find((r) => r.req.userId === a)!.req.credentials.amneziawgPeers!;
    expect(after).toHaveLength(3);
    for (const [i, p] of after.entries()) {
      expect(p.publicKey).not.toBe(before[i]!.publicKey);
      expect(p.allowedIp).toBe(before[i]!.allowedIp);
      expect(p.allowedIp3).toBe(before[i]!.allowedIp3);
      expect(p.wireguardAllowedIp).toBe(before[i]!.wireguardAllowedIp);
    }
    const own = await prisma.user.findUniqueOrThrow({ where: { id: a }, select: { amneziawgPublicKey: true } });
    expect(after[0]!.publicKey).toBe(own.amneziawgPublicKey);
    expect(await prisma.wgDevice.count({ where: { userId: a } })).toBe(3);
  });
});

describe('a revoked WireGuard device reaches the nodes (9.6)', () => {
  const wg = (subnet: string) => ({ serverPrivateKey: WG_TEST_PRIVATE_KEY, serverPublicKey: WG_TEST_PUBLIC_KEY, subnet });

  it('revoking queues a rollout of the user, after which the revoked peer is gone and its replacement is there', async () => {
    const n = await node();
    vi.spyOn(NodeTransport.prototype, 'applyInbounds').mockResolvedValue({ ok: true, applied: 1, skipped: 0 } as never);
    const p = await profile('wireguard', wg('10.77.77.0/24'));
    await host(p, n, 51840);
    const sq = await post('/api/squads', { name: 'wg-only', profileIds: [p] });
    const u = await user('revoke_flow', [sq.id]);
    const first = capture();
    await syncAddUser(u);
    const before = first.added.at(-1)!.req.credentials.amneziawgPeers!;
    expect(before).toHaveLength(3);
    const gone = await prisma.wgDevice.findFirstOrThrow({ where: { publicKey: before[1]!.publicKey } });

    vi.restoreAllMocks();
    vi.spyOn(NodeTransport.prototype, 'listAssets').mockRejectedValue(new NodeRequestError('404', 404, null));
    const queued = vi.spyOn(nodeUsersQueue, 'add').mockResolvedValue({} as never);
    registerUserEventHandlers();
    const res = await app.inject({ method: 'DELETE', url: `/api/wg-devices/${gone.id}`, headers: auth() });
    expect(res.statusCode).toBe(204);
    await new Promise((r) => setTimeout(r, 300));
    expect(queued.mock.calls.filter((c) => c[0] === 'addUser' && (c[1] as { userId: string }).userId === u)).toHaveLength(1);

    // What that job sends: the revoked key off, a newly issued one on, and the
    // devices that stayed unchanged.
    const second = capture();
    await syncAddUser(u);
    const after = second.added.at(-1)!.req.credentials.amneziawgPeers!;
    expect(after).toHaveLength(3);
    const keys = after.map((x) => x.publicKey);
    expect(keys).not.toContain(gone.publicKey);
    expect(keys).toContain(before[0]!.publicKey);
    expect(keys).toContain(before[2]!.publicKey);
    expect(await prisma.wgDevice.count({ where: { userId: u, revokedAt: null } })).toBe(3);
  });

  it('a device issued by a subscription render queues a rollout too', async () => {
    const n = await node();
    const p = await profile('wireguard', wg('10.77.77.0/24'));
    await host(p, n, 51840);
    const sq = await post('/api/squads', { name: 'wg-sub', profileIds: [p] });
    const u = await user('issue_flow', [sq.id]);
    const queued = vi.spyOn(nodeUsersQueue, 'add').mockResolvedValue({} as never);
    registerUserEventHandlers();
    const sub = (await prisma.user.findUniqueOrThrow({ where: { id: u }, select: { subscriptionToken: true } })).subscriptionToken;
    await app.inject({ method: 'GET', url: `/sub/${sub}` });
    await new Promise((r) => setTimeout(r, 300));
    expect(queued.mock.calls.some((c) => c[0] === 'addUser' && (c[1] as { userId: string }).userId === u)).toBe(true);
  });
});

describe('a preshared key per device (9.5)', () => {
  const wgCfg = (subnet: string, extra: object = {}) => ({
    serverPrivateKey: WG_TEST_PRIVATE_KEY,
    serverPublicKey: WG_TEST_PUBLIC_KEY,
    subnet,
    ...extra,
  });
  const awgCfg = (subnet: string, extra: object = {}) => ({ ...awg(subnet), ...extra });

  /** One node with an AmneziaWG 1.x, a 3.1 and a plain WireGuard binding; each profile's flag as given. */
  async function pskNode(flags: { one?: boolean; three?: boolean; plain?: boolean }) {
    const n = await node();
    vi.spyOn(NodeTransport.prototype, 'applyInbounds').mockResolvedValue({ ok: true, applied: 3, skipped: 0 } as never);
    await prisma.node.update({
      where: { id: n },
      data: {
        cores: observedCores(
          [
            { name: 'amneziawg', engine: 'amneziawg', running: true, installed: true, awgProtocol: 3, awgGenerations: [1, 3] },
            { name: 'wireguard', engine: 'wireguard', running: true, installed: true },
          ],
          new Date().toISOString(),
        ) as unknown as object,
      },
    });
    const flag = (v?: boolean) => (v === undefined ? {} : { presharedKey: v });
    const one = await profile('amneziawg', awgCfg('10.66.66.0/24', flag(flags.one)));
    const three = await profile('amneziawg', awgCfg('10.67.67.0/24', flag(flags.three)), { awgProtocol: 3 });
    const plain = await profile('wireguard', wgCfg('10.77.77.0/24', flag(flags.plain)));
    await host(one, n, 51820);
    await host(three, n, 51830);
    await host(plain, n, 51840);
    const sq = await post('/api/squads', { name: 'psk-wg', profileIds: [one, three, plain] });
    return { n, sq, one, three, plain };
  }

  const confOf = async (userId: string, query: string): Promise<string> => {
    const t = (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { subscriptionToken: true } })).subscriptionToken;
    const res = await app.inject({ method: 'GET', url: `/sub/${t}?format=wgconf&${query}`, remoteAddress: `10.79.0.${++seq}` });
    expect(res.statusCode, res.body).toBe(200);
    return res.body;
  };
  const line = (conf: string, name: string) => new RegExp(`^${name} = (.+)$`, 'm').exec(conf)?.[1];

  it('flag off (the default): no key in any peer, no key field on the wire, and the profile stores none', async () => {
    const { n, sq, one } = await pskNode({});
    const a = await user('psk_off', [sq.id]);
    const { added } = capture();
    await applyInboundsForNode(n);
    const c = added.find((r) => r.req.userId === a)!.req.credentials;
    expect(c.amneziawgPeers).toHaveLength(3);
    expect(JSON.stringify(c)).not.toMatch(/resharedKey/);
    // The devices hold their keys all the same: turning the flag on later needs no pass over the table.
    expect((await prisma.wgDevice.findMany({ where: { userId: a } })).every((d) => !!d.presharedKey)).toBe(true);
    expect(JSON.stringify((await prisma.profile.findUniqueOrThrow({ where: { id: one } })).config)).not.toContain('presharedKey');
    for (const q of ['', 'protocols=wireguard']) expect(await confOf(a, q)).not.toContain('PresharedKey');
  });

  it('flag on: the device key is in the peer, in the client conf and in the AmneziaVPN key, and it is one value; two devices differ', async () => {
    const { n, sq } = await pskNode({ one: true, three: true, plain: true });
    const a = await user('psk_on', [sq.id]);
    const { added } = capture();
    await applyInboundsForNode(n);
    const peers = added.find((r) => r.req.userId === a)!.req.credentials.amneziawgPeers!;
    expect(peers).toHaveLength(3);
    const devices = await prisma.wgDevice.findMany({ where: { userId: a }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    for (const [i, p] of peers.entries()) {
      expect(p.publicKey).toBe(devices[i]!.publicKey);
      expect(p.presharedKey).toBe(devices[i]!.presharedKey);
      expect(p.presharedKey3).toBe(devices[i]!.presharedKey);
      expect(p.wireguardPresharedKey).toBe(devices[i]!.presharedKey);
    }
    expect(new Set(peers.map((p) => p.presharedKey)).size).toBe(3);

    // The client's side: the same value, for the AmneziaWG conf, the plain conf and the AmneziaVPN key.
    for (const [i, p] of peers.entries()) {
      expect(line(await confOf(a, `device=${i + 1}`), 'PresharedKey')).toBe(p.presharedKey);
      expect(line(await confOf(a, `protocols=wireguard&device=${i + 1}`), 'PresharedKey')).toBe(p.wireguardPresharedKey);
    }
    const t = (await prisma.user.findUniqueOrThrow({ where: { id: a }, select: { subscriptionToken: true } })).subscriptionToken;
    const link = await app.inject({ method: 'GET', url: `/sub/${t}?format=amneziavpn&device=2`, remoteAddress: '10.79.9.9' });
    expect(link.statusCode, link.body).toBe(200);
    const key = link.body.trim().replace(/^vpn:\/\//, '');
    const envelope = JSON.parse(inflateSync(Buffer.from(key, 'base64url').subarray(4)).toString('utf8'));
    expect(JSON.parse(envelope.containers[0].awg.last_config).psk_key).toBe(peers[1]!.presharedKey);
  });

  it('is per profile: only the interfaces whose profile has the flag carry it, in the peer and in the conf alike', async () => {
    const { n, sq } = await pskNode({ one: false, three: true, plain: true });
    const a = await user('psk_mixed', [sq.id]);
    const { added } = capture();
    await applyInboundsForNode(n);
    const peers = added.find((r) => r.req.userId === a)!.req.credentials.amneziawgPeers!;
    for (const p of peers) {
      expect(p.presharedKey).toBeUndefined();
      expect(p.presharedKey3).toBeTruthy();
      expect(p.wireguardPresharedKey).toBeTruthy();
    }
    expect(await confOf(a, '')).not.toContain('PresharedKey'); // the 1.x tunnel is the first AmneziaWG one
    expect(line(await confOf(a, 'protocols=wireguard'), 'PresharedKey')).toBe(peers[0]!.wireguardPresharedKey);
  });

  it('only the profile with the flag gives a key', async () => {
    const { n, sq } = await pskNode({ plain: true });
    const a = await user('psk_wg_only', [sq.id]);
    const { added } = capture();
    await applyInboundsForNode(n);
    for (const p of added.find((r) => r.req.userId === a)!.req.credentials.amneziawgPeers!) {
      expect(p.presharedKey).toBeUndefined();
      expect(p.presharedKey3).toBeUndefined();
      expect(p.wireguardPresharedKey).toBeTruthy();
    }
  });

  it('turning the flag on or off reaches the node with the next push, as a changed peer list (no new device, no extra step)', async () => {
    const { n, sq, plain } = await pskNode({});
    const a = await user('psk_toggle', [sq.id]);
    const off = capture();
    await applyInboundsForNode(n);
    const before = off.added.find((r) => r.req.userId === a)!.req.credentials.amneziawgPeers!;

    const res = await app.inject({ method: 'GET', url: `/api/profiles/${plain}`, headers: auth() });
    const prof = JSON.parse(res.body);
    const put = await app.inject({
      method: 'PUT',
      url: `/api/profiles/${plain}`,
      headers: auth(),
      payload: { name: prof.name, protocol: 'wireguard', config: wgCfg('10.77.77.0/24', { presharedKey: true }) },
    });
    expect(put.statusCode, put.body).toBeLessThan(300);

    vi.restoreAllMocks();
    vi.spyOn(NodeTransport.prototype, 'listAssets').mockRejectedValue(new NodeRequestError('404', 404, null));
    vi.spyOn(NodeTransport.prototype, 'applyInbounds').mockResolvedValue({ ok: true, applied: 3, skipped: 0 } as never);
    const on = capture();
    await applyInboundsForNode(n);
    const after = on.added.find((r) => r.req.userId === a)!.req.credentials.amneziawgPeers!;
    expect(after.map((p) => p.publicKey)).toEqual(before.map((p) => p.publicKey));
    expect(after.map((p) => p.allowedIp)).toEqual(before.map((p) => p.allowedIp));
    expect(before.every((p) => p.wireguardPresharedKey === undefined)).toBe(true);
    expect(after.every((p) => !!p.wireguardPresharedKey)).toBe(true);
    // Rolling the one user out sends the same list as the push.
    vi.restoreAllMocks();
    vi.spyOn(NodeTransport.prototype, 'listAssets').mockRejectedValue(new NodeRequestError('404', 404, null));
    const rolled = capture();
    await syncAddUser(a);
    expect(rolled.added.find((r) => r.req.userId === a)!.req.credentials.amneziawgPeers).toEqual(after);
  });

  it('reissuing the credentials changes the keys of every device along with their pairs', async () => {
    const { n, sq } = await pskNode({ plain: true });
    const a = await user('psk_reissue', [sq.id]);
    const first = capture();
    await applyInboundsForNode(n);
    const before = first.added.find((r) => r.req.userId === a)!.req.credentials.amneziawgPeers!;
    const res = await app.inject({ method: 'POST', url: `/api/users/${a}/reissue-credentials`, headers: auth() });
    expect(res.statusCode, res.body).toBeLessThan(300);
    vi.restoreAllMocks();
    vi.spyOn(NodeTransport.prototype, 'listAssets').mockRejectedValue(new NodeRequestError('404', 404, null));
    const second = capture();
    await syncAddUser(a);
    const after = second.added.find((r) => r.req.userId === a)!.req.credentials.amneziawgPeers!;
    for (const [i, p] of after.entries()) {
      expect(p.wireguardPresharedKey).toBeTruthy();
      expect(p.wireguardPresharedKey).not.toBe(before[i]!.wireguardPresharedKey);
    }
  });

  it('no key reaches a log of the panel, on the push or on the subscription', async () => {
    const { n, sq } = await pskNode({ one: true, three: true, plain: true });
    const a = await user('psk_log', [sq.id]);
    const log = getLogger();
    const seen: string[] = [];
    for (const level of ['info', 'warn', 'error', 'debug', 'fatal', 'trace'] as const) {
      vi.spyOn(log, level).mockImplementation(((...args: unknown[]) => {
        seen.push(args.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
      }) as never);
    }
    for (const m of ['log', 'warn', 'error', 'info', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void seen.push(args.map(String).join(' ')));
    }
    capture();
    await applyInboundsForNode(n);
    await syncAddUser(a);
    await confOf(a, '');
    const keys = (await prisma.wgDevice.findMany({ where: { userId: a } })).map((d) => d.presharedKey!);
    expect(keys).toHaveLength(3);
    const all = seen.join('\n');
    for (const k of keys) expect(all).not.toContain(k);
  });
});
