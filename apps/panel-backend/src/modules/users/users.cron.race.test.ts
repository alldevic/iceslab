import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { eventBus } from '../../lib/infra/event-bus.js';
import { nodeUsersQueue } from './users.queue.js';
import { findExceededTrafficUsers, findExpiredUsers } from './users.cron.js';

/**
 * A-132: the expiry and quota crons write their condition, not a list of ids
 * picked a moment before. An operator's edit that lands between the two used
 * to be overwritten: an extended user went out as expired.
 *
 * The race is made, not hoped for: the operator's edit holds the row lock in
 * an open transaction while the cron's statement runs into it; the edit
 * commits, and the cron's UPDATE re-reads the row (READ COMMITTED) and finds
 * the condition no longer true.
 */

let app: FastifyInstance;
let token: string;
let queued: string[];
let events: { userId: string; to: string }[];

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  token = await registerAndLogin(app);
  queued = [];
  events = [];
  vi.spyOn(nodeUsersQueue, 'addBulk').mockImplementation(async (jobs) => {
    queued.push(...jobs.map((j) => (j.data as { userId: string }).userId));
    return [] as never;
  });
  vi.spyOn(eventBus, 'emit').mockImplementation(((name: string, p: { userId: string; to: string }) => {
    if (name === 'user.status-changed') events.push({ userId: p.userId, to: p.to });
    return true;
  }) as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

async function user(username: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/users', headers: { authorization: `Bearer ${token}` }, payload: { username } });
  expect(res.statusCode, res.body).toBe(201);
  return JSON.parse(res.body).id as string;
}

const statusOf = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

/** The operator's edit, holding the row until the cron is blocked on it. */
async function editDuringCron<T>(id: string, data: Record<string, unknown>, cron: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let cronRun!: Promise<T>;
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id }, data });
    cronRun = cron();
    // Long enough for the cron's UPDATE to reach the locked row.
    setTimeout(release, 400);
    await held;
  }, { timeout: 10_000 });
  return cronRun;
}

describe('the expiry cron', () => {
  it('flips an expired active user, and queues and announces exactly what it flipped', async () => {
    const a = await user('exp-a');
    const b = await user('exp-b');
    await prisma.user.update({ where: { id: a }, data: { expireAt: new Date(Date.now() - 60_000) } });
    await prisma.user.update({ where: { id: b }, data: { expireAt: new Date(Date.now() - 60_000), status: 'disabled' } });
    expect(await findExpiredUsers()).toBe(1);
    expect(await statusOf(a)).toBe('expired');
    expect(await statusOf(b)).toBe('disabled');
    expect(queued).toEqual([a]);
    expect(events).toEqual([{ userId: a, to: 'expired' }]);
  });

  it('a user extended while the cron runs stays active, and nothing goes to the queue', async () => {
    const a = await user('exp-race');
    await prisma.user.update({ where: { id: a }, data: { expireAt: new Date(Date.now() - 60_000) } });
    const n = await editDuringCron(a, { expireAt: new Date(Date.now() + 30 * 86_400_000) }, findExpiredUsers);
    expect(n).toBe(0);
    expect(await statusOf(a)).toBe('active');
    expect(queued).toEqual([]);
    expect(events).toEqual([]);
  });

  it('a user disabled while the cron runs stays disabled', async () => {
    const a = await user('exp-off');
    await prisma.user.update({ where: { id: a }, data: { expireAt: new Date(Date.now() - 60_000) } });
    await editDuringCron(a, { status: 'disabled' }, findExpiredUsers);
    expect(await statusOf(a)).toBe('disabled');
  });

  it('stamps updated_at, which the orphan reconcile windows by', async () => {
    const a = await user('exp-stamp');
    const old = new Date(Date.now() - 86_400_000);
    await prisma.$executeRaw`UPDATE users SET expire_at = now() - interval '1 minute', updated_at = ${old} WHERE id = ${a}::uuid`;
    await findExpiredUsers();
    const row = await prisma.user.findUniqueOrThrow({ where: { id: a }, select: { updatedAt: true } });
    expect(row.updatedAt.getTime()).toBeGreaterThan(old.getTime() + 60_000);
  });
});

describe('the quota cron', () => {
  it('a quota raised while the cron runs keeps the user active', async () => {
    const a = await user('cap-race');
    await prisma.user.update({ where: { id: a }, data: { trafficLimitBytes: 100n } });
    await prisma.userTraffic.update({ where: { userId: a }, data: { usedTrafficBytes: 200n } });
    const n = await editDuringCron(a, { trafficLimitBytes: 10_000n }, findExceededTrafficUsers);
    expect(n).toBe(0);
    expect(await statusOf(a)).toBe('active');
    expect(queued).toEqual([]);
  });

  it('flips a user over the quota, and only them', async () => {
    const a = await user('cap-over');
    const b = await user('cap-under');
    await prisma.user.updateMany({ where: { id: { in: [a, b] } }, data: { trafficLimitBytes: 100n } });
    await prisma.userTraffic.update({ where: { userId: a }, data: { usedTrafficBytes: 100n } });
    await prisma.userTraffic.update({ where: { userId: b }, data: { usedTrafficBytes: 99n } });
    expect(await findExceededTrafficUsers()).toBe(1);
    expect(await statusOf(a)).toBe('limited');
    expect(await statusOf(b)).toBe('active');
    expect(events).toEqual([{ userId: a, to: 'limited' }]);
  });
});
