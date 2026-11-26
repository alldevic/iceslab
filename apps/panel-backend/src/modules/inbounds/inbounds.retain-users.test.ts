import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddUserRequest } from '@iceslab/shared';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { NodeTransport, NodeRequestError } from '../nodes/nodes.transport.js';
import { applyInboundsForNode } from './inbounds.queue.js';

/**
 * 9.7: a full push ends with the ids of the users who should be on the node
 * (/retainUsers), so a user deleted while the node was unreachable is taken off.
 * Never after a partial or failed push, nor on the node's first push.
 */
let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  token = await registerAndLogin(app);
  vi.spyOn(NodeTransport.prototype, 'applyInbounds').mockResolvedValue({ applied: 1, skipped: 0 } as never);
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

async function nodeWithUser(): Promise<{ nodeId: string; userId: string }> {
  const n = await post('/api/nodes', { name: 'de-01', address: 'de-01.test', protocol: 'xray' });
  const p = await post('/api/profiles', { name: 'vless-de', protocol: 'xray', config: VLESS });
  await post('/api/hosts', { profileId: p.id, nodeId: n.id, port: 443, remark: 'Default' });
  const sq = await post('/api/squads', { name: 'de', profileIds: [p.id] });
  const u = await post('/api/users', { username: 'new_user', groupIds: [sq.id] });
  return { nodeId: n.id as string, userId: u.id as string };
}

function roster(): AddUserRequest[] {
  const sent: AddUserRequest[] = [];
  vi.spyOn(NodeTransport.prototype, 'addUsers').mockImplementation(async (batch) => {
    sent.push(...batch.users);
    return { results: batch.users.map((u) => ({ userId: u.userId, ok: true })) };
  });
  vi.spyOn(NodeTransport.prototype, 'addUser').mockImplementation(async (req) => {
    sent.push(req);
  });
  return sent;
}



async function landed(nodeId: string) {
  // A push that landed once: the node is no longer on its first.
  await prisma.node.update({ where: { id: nodeId }, data: { lastInboundSyncAt: new Date() } });
}

function retainSpy() {
  const sets: string[][] = [];
  const spy = vi.spyOn(NodeTransport.prototype, 'retainUsers').mockImplementation(async (req) => {
    sets.push(req.userIds);
    return { ok: true, reconciled: 0 };
  });
  return { sets, spy };
}

describe('user reconcile at the end of a push', () => {
  it('is called after a full push with the active users of the node from the database', async () => {
    const { nodeId, userId } = await nodeWithUser();
    // Reaches the node by squad but is disabled: not wanted on it.
    const sq = await prisma.group.findFirstOrThrow();
    const gone = await post('/api/users', { username: 'gone_user', groupIds: [sq.id] });
    await prisma.user.update({ where: { id: gone.id }, data: { status: 'disabled' } });
    await landed(nodeId);
    roster();
    const { sets } = retainSpy();
    await applyInboundsForNode(nodeId);
    expect(sets).toEqual([[userId]]);
    expect(sets[0]).not.toContain(gone.id);
  });

  it('a user created while the roster was going out is in the set', async () => {
    const { nodeId, userId } = await nodeWithUser();
    await landed(nodeId);
    const sq = await prisma.group.findFirstOrThrow();
    let late = '';
    vi.spyOn(NodeTransport.prototype, 'addUsers').mockImplementation(async (batch) => {
      late = (await post('/api/users', { username: 'late_user', groupIds: [sq.id] })).id;
      return { results: batch.users.map((u) => ({ userId: u.userId, ok: true })) };
    });
    const { sets } = retainSpy();
    await applyInboundsForNode(nodeId);
    expect(late).not.toBe('');
    expect([...sets[0]!].sort()).toEqual([userId, late].sort());
  });

  it('a user deleted while the roster was going out is not in the set', async () => {
    const { nodeId, userId } = await nodeWithUser();
    await landed(nodeId);
    vi.spyOn(NodeTransport.prototype, 'addUsers').mockImplementation(async (batch) => {
      await prisma.user.update({ where: { id: userId }, data: { deletedAt: new Date() } });
      return { results: batch.users.map((u) => ({ userId: u.userId, ok: true })) };
    });
    const { sets } = retainSpy();
    await applyInboundsForNode(nodeId);
    expect(sets).toEqual([[]]);
  });

  it('is not called when a roster batch failed', async () => {
    const { nodeId } = await nodeWithUser();
    await landed(nodeId);
    vi.spyOn(NodeTransport.prototype, 'addUsers').mockRejectedValue(new Error('connect ECONNRESET'));
    const { spy } = retainSpy();
    await applyInboundsForNode(nodeId);
    expect(spy).not.toHaveBeenCalled();
  });

  it('is not called when a user was refused', async () => {
    const { nodeId } = await nodeWithUser();
    await landed(nodeId);
    vi.spyOn(NodeTransport.prototype, 'addUsers').mockImplementation(async (batch) => ({
      results: batch.users.map((u) => ({ userId: u.userId, ok: false, error: 'no' })),
    }));
    const { spy } = retainSpy();
    await applyInboundsForNode(nodeId);
    expect(spy).not.toHaveBeenCalled();
  });

  it('is not called after a partial push (ADAPTER_FAILED)', async () => {
    const { nodeId } = await nodeWithUser();
    await landed(nodeId);
    vi.spyOn(NodeTransport.prototype, 'applyInbounds').mockRejectedValue(
      new NodeRequestError('500: x', 500, { error: 'ADAPTER_FAILED', message: 'x' }),
    );
    roster();
    const { spy } = retainSpy();
    await expect(applyInboundsForNode(nodeId)).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it('is not called on the first push to a node', async () => {
    const { nodeId } = await nodeWithUser();
    roster();
    const { spy } = retainSpy();
    await applyInboundsForNode(nodeId);
    expect(spy).not.toHaveBeenCalled();
  });

  it('an older agent (404) does not fail the push', async () => {
    const { nodeId } = await nodeWithUser();
    await landed(nodeId);
    roster();
    vi.spyOn(NodeTransport.prototype, 'retainUsers').mockRejectedValue(new NodeRequestError('404', 404, null));
    await expect(applyInboundsForNode(nodeId)).resolves.toBeUndefined();
  });

  it('another failure of the reconcile does not fail the push either', async () => {
    const { nodeId } = await nodeWithUser();
    await landed(nodeId);
    roster();
    vi.spyOn(NodeTransport.prototype, 'retainUsers').mockRejectedValue(new Error('timeout'));
    await expect(applyInboundsForNode(nodeId)).resolves.toBeUndefined();
  });
});
