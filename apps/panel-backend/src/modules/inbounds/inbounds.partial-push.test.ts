import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddUserRequest } from '@iceslab/shared';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { NodeTransport, NodeRequestError } from '../nodes/nodes.transport.js';
import { applyInboundsForNode, enqueueNodePush, inboundSyncQueue } from './inbounds.queue.js';

/**
 * A-275, stand 26.10 on aeza-de-01: mieru refused its first push ("no user
 * found") and the whole push failed, so the roster never went out and the new
 * users of the node's xray and mtproto never arrived. ADAPTER_FAILED is the
 * agent's answer after it applied every core it could; the roster goes to
 * what applied, and the push still counts as failed.
 */
let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  token = await registerAndLogin(app);
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

const MIERU_REFUSAL =
  '1/2 inbounds failed to apply: mieru-de (mieru): mita start: exit status 1 ' +
  '(start mita server proxy failed: rpc error: code = Unknown desc = no user found)';

describe('a push one core refused (ADAPTER_FAILED)', () => {
  it('still hands the roster to the cores that applied, and the push stays failed', async () => {
    const { nodeId, userId } = await nodeWithUser();
    await enqueueNodePush(nodeId);
    await inboundSyncQueue.obliterate({ force: true });
    vi.spyOn(NodeTransport.prototype, 'applyInbounds').mockRejectedValue(
      new NodeRequestError(`Node de-01.test returned 500: ${MIERU_REFUSAL}`, 500, {
        error: 'ADAPTER_FAILED',
        message: MIERU_REFUSAL,
      }),
    );
    const sent = roster();

    // Still fails: the error stays on the node and BullMQ retries the push.
    await expect(applyInboundsForNode(nodeId)).rejects.toThrow(/no user found/);
    expect(sent.map((u) => u.userId)).toContain(userId);

    const n = await prisma.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect((n.lastInboundSyncError as { message: string }).message).toContain('mieru-de (mieru)');
    expect(n.lastInboundSyncAt).toBeNull();
    expect(n.appliedRevision).toBe(0n);
  });

  it('a push that never reached the agent sends no roster', async () => {
    const { nodeId } = await nodeWithUser();
    vi.spyOn(NodeTransport.prototype, 'applyInbounds').mockRejectedValue(new Error('connect ECONNREFUSED'));
    const sent = roster();
    await expect(applyInboundsForNode(nodeId)).rejects.toThrow(/ECONNREFUSED/);
    expect(sent).toEqual([]);
  });

  it('a refusal before applying (another 4xx/5xx code) sends no roster', async () => {
    const { nodeId } = await nodeWithUser();
    vi.spyOn(NodeTransport.prototype, 'applyInbounds').mockRejectedValue(
      new NodeRequestError('Node de-01.test returned 409: GEO_MISSING', 409, { error: 'GEO_MISSING', message: 'x' }),
    );
    const sent = roster();
    await expect(applyInboundsForNode(nodeId)).rejects.toThrow();
    expect(sent).toEqual([]);
  });
});
