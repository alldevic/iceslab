import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AddUserRequest, AddUsersRequest, ApplyInboundsRequest } from '@iceslab/shared';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { deriveMtprotoSecret } from '../../lib/auth/credentials.js';
import { NodeRequestError, NodeTransport } from '../nodes/nodes.transport.js';
import { applyInboundsForNode, inboundSyncQueue } from '../inbounds/inbounds.queue.js';
import { syncAddUser } from './users.queue.js';

/**
 * The credentials a node is sent carry the user's own MTProto secret on every
 * path that sends credentials: adding a user, and applying a node's inbounds
 * (the roster). It goes to every node unconditionally, like the neighbouring
 * derived passwords; adapters that do not need it ignore it. A node that is
 * handed a user for the first time gets the roster with its first push
 * (syncBackfillNode sends nothing of its own).
 */
let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  token = await registerAndLogin(app);
  vi.spyOn(NodeTransport.prototype, 'listAssets').mockRejectedValue(new NodeRequestError('404', 404, null));
  vi.spyOn(inboundSyncQueue, 'add').mockResolvedValue({} as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

async function create(url: string, payload: unknown) {
  const res = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object });
  expect(res.statusCode, res.body).toBe(201);
  return JSON.parse(res.body) as { id: string };
}

async function world(engine: 'mtprotoproxy' | null) {
  const node = await prisma.node.create({
    data: {
      name: 'mt-node',
      address: 'mt.example.com',
      protocol: 'mtproto',
      status: 'online',
      heartbeatSecret: randomBytes(32),
      lastInboundSyncAt: new Date(),
    },
    select: { id: true },
  });
  const profile = await create('/api/profiles', {
    name: 'mt-profile',
    protocol: 'mtproto',
    ...(engine ? { engine } : {}),
    config: { domain: 'www.example.com' },
  });
  await create('/api/bindings', { profileId: profile.id, nodeId: node.id, port: 2443 });
  const user = await create('/api/users', { username: 'mt_user' });
  const u = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { xrayUuid: true } });
  return { nodeId: node.id, userId: user.id, secret: deriveMtprotoSecret(u.xrayUuid) };
}

function capture() {
  const rosters: AddUsersRequest[] = [];
  const adds: AddUserRequest[] = [];
  vi.spyOn(NodeTransport.prototype, 'applyInbounds').mockImplementation(async (req: ApplyInboundsRequest) => {
    return { applied: req.inbounds.length, skipped: 0 } as never;
  });
  vi.spyOn(NodeTransport.prototype, 'addUsers').mockImplementation(async (req: AddUsersRequest) => {
    rosters.push(req);
    return { results: req.users.map((u) => ({ userId: u.userId, ok: true })) };
  });
  vi.spyOn(NodeTransport.prototype, 'addUser').mockImplementation(async (req: AddUserRequest) => {
    adds.push(req);
  });
  return { rosters, adds };
}

describe('mtprotoSecret in the credentials a node is sent', () => {
  for (const engine of ['mtprotoproxy', null] as const) {
    it(`on a profile with engine ${engine}: adding a user and applying the node both carry it`, async () => {
      const { nodeId, userId, secret } = await world(engine);
      const sent = capture();

      await syncAddUser(userId);
      expect(sent.adds.length).toBeGreaterThan(0);
      for (const a of sent.adds) expect(a.credentials.mtprotoSecret).toBe(secret);

      await applyInboundsForNode(nodeId);
      const row = sent.rosters.flatMap((r) => r.users).find((u) => u.userId === userId);
      expect(row?.credentials.mtprotoSecret).toBe(secret);
    });
  }
});
