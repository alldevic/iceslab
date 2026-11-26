import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AddUserRequest, AddUsersRequest, ApplyInboundsRequest } from '@iceslab/shared';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { eventBus } from '../../lib/infra/event-bus.js';
import { NodeRequestError, NodeTransport } from '../nodes/nodes.transport.js';
import { applyInboundsForNode, inboundSyncQueue } from '../inbounds/inbounds.queue.js';
import { mtprotoBackstop } from './mtproto-backstop.js';
import { registerUserEventHandlers } from './users.events.js';
import { nodeUsersQueue, syncAddUser } from './users.queue.js';
import { resetTrafficForStrategy } from './users.cron.js';
import { resetUserTraffic, updateUser } from './users.service.js';

/**
 * The term and the traffic limit that reach a node for the mtprotoproxy
 * engine's own backstop: what is LEFT of the limit, on every path that sends
 * credentials (adding a user, applying a node's inbounds; a node handed a user
 * for the first time gets the roster with its first push, syncBackfillNode
 * sends nothing of its own), and the events that make the nodes hear a change.
 */
const GiB = 1024n ** 3n;

describe('mtprotoBackstop', () => {
  it('sends the remainder, not the limit', () => {
    const r = mtprotoBackstop({
      expireAt: new Date('2026-12-01T10:00:00.000Z'),
      trafficLimitBytes: 10n * GiB,
      traffic: { usedTrafficBytes: 3n * GiB },
    });
    expect(r).toEqual({ mtprotoExpiresAt: '2026-12-01T10:00:00.000Z', mtprotoQuotaBytes: Number(7n * GiB) });
  });

  it('gives a user with neither a limit nor a term no fields at all', () => {
    const r = mtprotoBackstop({ expireAt: null, trafficLimitBytes: null, traffic: { usedTrafficBytes: 5n } });
    expect(r).toEqual({});
    expect('mtprotoQuotaBytes' in r).toBe(false);
    expect('mtprotoExpiresAt' in r).toBe(false);
  });

  it('never sends a negative remainder: over the limit is 0, not unlimited', () => {
    const r = mtprotoBackstop({ expireAt: null, trafficLimitBytes: 5n, traffic: { usedTrafficBytes: 9n } });
    expect(r.mtprotoQuotaBytes).toBe(0);
    expect('mtprotoQuotaBytes' in r).toBe(true);
  });

  it('treats a user with no traffic row as having used nothing', () => {
    expect(mtprotoBackstop({ expireAt: null, trafficLimitBytes: 100n, traffic: null }).mtprotoQuotaBytes).toBe(100);
  });

  it('sends a term alone, and a limit alone', () => {
    expect(mtprotoBackstop({ expireAt: new Date(0), trafficLimitBytes: null })).toEqual({
      mtprotoExpiresAt: '1970-01-01T00:00:00.000Z',
    });
    expect(mtprotoBackstop({ expireAt: null, trafficLimitBytes: 0n })).toEqual({ mtprotoQuotaBytes: 0 });
  });
});

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

async function world(user: { expireAt?: Date; trafficLimitBytes?: bigint; usedTrafficBytes?: bigint }) {
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
    engine: 'mtprotoproxy',
    config: { domain: 'www.example.com' },
  });
  await create('/api/bindings', { profileId: profile.id, nodeId: node.id, port: 2443 });
  const made = await create('/api/users', { username: 'mt_user' });
  await prisma.user.update({
    where: { id: made.id },
    data: { expireAt: user.expireAt ?? null, trafficLimitBytes: user.trafficLimitBytes ?? null },
  });
  if (user.usedTrafficBytes !== undefined) {
    await prisma.userTraffic.upsert({
      where: { userId: made.id },
      create: { userId: made.id, usedTrafficBytes: user.usedTrafficBytes },
      update: { usedTrafficBytes: user.usedTrafficBytes },
    });
  }
  return { nodeId: node.id, userId: made.id };
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

async function credentialsOnBothPaths(w: { nodeId: string; userId: string }) {
  const sent = capture();
  await syncAddUser(w.userId);
  await applyInboundsForNode(w.nodeId);
  const added = sent.adds.map((a) => a.credentials);
  const roster = sent.rosters.flatMap((r) => r.users).filter((u) => u.userId === w.userId).map((u) => u.credentials);
  expect(added.length).toBeGreaterThan(0);
  expect(roster.length).toBeGreaterThan(0);
  return [...added, ...roster];
}

describe('the term and the remainder in the credentials a node is sent', () => {
  it('carry the remainder and the term on adding a user and on applying the node', async () => {
    const expireAt = new Date(Date.now() + 5 * 86_400_000);
    const w = await world({ expireAt, trafficLimitBytes: 10n * GiB, usedTrafficBytes: 4n * GiB });
    for (const c of await credentialsOnBothPaths(w)) {
      expect(c.mtprotoQuotaBytes).toBe(Number(6n * GiB));
      expect(c.mtprotoExpiresAt).toBe(expireAt.toISOString());
    }
  });

  it('give a user with no limit and no term no fields', async () => {
    const w = await world({});
    for (const c of await credentialsOnBothPaths(w)) {
      expect('mtprotoQuotaBytes' in c).toBe(false);
      expect('mtprotoExpiresAt' in c).toBe(false);
    }
  });

  it('send 0, not a negative number, for a user over the limit', async () => {
    // Status stays active here on purpose: the cron that flips it has not run.
    const w = await world({ trafficLimitBytes: 1n * GiB, usedTrafficBytes: 3n * GiB });
    for (const c of await credentialsOnBothPaths(w)) expect(c.mtprotoQuotaBytes).toBe(0);
  });
});

describe('what makes the nodes hear a new term or remainder', () => {
  let added: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    added = vi.spyOn(nodeUsersQueue, 'add').mockResolvedValue({} as never);
    registerUserEventHandlers();
  });
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 300));
  const addUserJobs = (userId: string) =>
    added.mock.calls.filter((c) => c[0] === 'addUser' && (c[1] as { userId: string }).userId === userId).length;

  it('rolls the user out again when the limit or the term is edited', async () => {
    const w = await world({ trafficLimitBytes: 10n * GiB });
    added.mockClear();
    await updateUser(w.userId, { trafficLimitGb: 20 });
    await settle();
    expect(addUserJobs(w.userId)).toBeGreaterThan(0);

    added.mockClear();
    await updateUser(w.userId, { expireAt: new Date(Date.now() + 86_400_000).toISOString() });
    await settle();
    expect(addUserJobs(w.userId)).toBeGreaterThan(0);
  });

  it('rolls an active user with a limit out again on a traffic reset, the on-demand one and the strategy one', async () => {
    const w = await world({ trafficLimitBytes: 10n * GiB, usedTrafficBytes: 4n * GiB });
    await prisma.user.update({ where: { id: w.userId }, data: { trafficLimitStrategy: 'day' } });
    added.mockClear();
    await resetUserTraffic(w.userId);
    await settle();
    expect(addUserJobs(w.userId)).toBeGreaterThan(0);

    added.mockClear();
    await resetTrafficForStrategy('day');
    await settle();
    expect(addUserJobs(w.userId)).toBeGreaterThan(0);
  });

  it('does not roll out a user without a limit on a traffic reset', async () => {
    const w = await world({});
    added.mockClear();
    eventBus.emit('user.traffic-reset', { userId: w.userId, previousUsedBytes: 0n });
    await settle();
    expect(addUserJobs(w.userId)).toBe(0);
  });
});
