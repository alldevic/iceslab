import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { eventBus } from '../../lib/infra/event-bus.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { statusAfterEdit } from './users.service.js';

/**
 * A-048 + A-060 (server side): an edit that clears what holds a user back
 * brings them back by itself, on every path (PUT, bulk extend, API token);
 * and `active` asked for a user the facts still hold back is not taken.
 */
const GB = 1024n ** 3n;
const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-10-22T12:00:00Z');
const past = new Date(now.getTime() - DAY);
const future = new Date(now.getTime() + 30 * DAY);

describe('statusAfterEdit', () => {
  const user = (status: string, over: Partial<{ expireAt: Date | null; limit: bigint | null; used: bigint }> = {}) => ({
    status,
    expireAt: over.expireAt === undefined ? null : over.expireAt,
    trafficLimitBytes: over.limit === undefined ? null : over.limit,
    traffic: { usedTrafficBytes: over.used ?? 0n },
  });

  it('expired + a date in the future: active', () => {
    expect(statusAfterEdit(user('expired', { expireAt: past }), { expireAt: future.toISOString() }, now)).toBe('active');
  });

  it('expired + no date at all: active', () => {
    expect(statusAfterEdit(user('expired', { expireAt: past }), { expireAt: null }, now)).toBe('active');
  });

  it('expired + a date still past: no change', () => {
    const earlier = new Date(now.getTime() - 2 * DAY).toISOString();
    expect(statusAfterEdit(user('expired', { expireAt: past }), { expireAt: earlier }, now)).toBeUndefined();
  });

  it('expired + a future date but the quota is spent: limited, not active', () => {
    const u = user('expired', { expireAt: past, limit: 10n * GB, used: 11n * GB });
    expect(statusAfterEdit(u, { expireAt: future.toISOString() }, now)).toBe('limited');
  });

  it('limited + a quota above what is used: active', () => {
    const u = user('limited', { limit: 10n * GB, used: 11n * GB });
    expect(statusAfterEdit(u, { trafficLimitGb: 20 }, now)).toBe('active');
  });

  it('limited + the quota removed: active', () => {
    const u = user('limited', { limit: 10n * GB, used: 11n * GB });
    expect(statusAfterEdit(u, { trafficLimitGb: null }, now)).toBe('active');
  });

  it('limited + a quota still below what is used: no change', () => {
    const u = user('limited', { limit: 10n * GB, used: 11n * GB });
    expect(statusAfterEdit(u, { trafficLimitGb: 11 }, now)).toBeUndefined();
  });

  it('limited + a new date only: no change, the quota still holds', () => {
    const u = user('limited', { limit: 10n * GB, used: 11n * GB });
    expect(statusAfterEdit(u, { expireAt: future.toISOString() }, now)).toBeUndefined();
  });

  it('`active` asked for an expired user whose date has passed lands on expired (A-060)', () => {
    expect(statusAfterEdit(user('expired', { expireAt: past }), { status: 'active' }, now)).toBe('expired');
  });

  it('`active` asked for a limited user whose quota is spent lands on limited (A-060)', () => {
    const u = user('limited', { limit: 10n * GB, used: 11n * GB });
    expect(statusAfterEdit(u, { status: 'active' }, now)).toBe('limited');
  });

  it('`disabled` is taken as said, and `active` re-enables a sound user', () => {
    expect(statusAfterEdit(user('active'), { status: 'disabled' }, now)).toBe('disabled');
    expect(statusAfterEdit(user('disabled', { expireAt: future }), { status: 'active' }, now)).toBe('active');
  });

  it('an edit that touches neither date nor quota moves nobody', () => {
    expect(statusAfterEdit(user('expired', { expireAt: past }), {}, now)).toBeUndefined();
    expect(statusAfterEdit(user('active'), { expireAt: past.toISOString() }, now)).toBeUndefined();
  });
});

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

const auth = (bearer = token) => ({ authorization: `Bearer ${bearer}` });

async function expiredUser(name: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/users', headers: auth(), payload: { username: name } });
  expect(res.statusCode, res.body).toBe(201);
  const id = JSON.parse(res.body).id as string;
  await prisma.user.update({ where: { id }, data: { status: 'expired', expireAt: new Date(Date.now() - DAY) } });
  return id;
}

function statusEvents(): { to: string }[] {
  const seen: { to: string }[] = [];
  eventBus.on('user.status-changed', (e) => {
    seen.push({ to: e.to });
  });
  return seen;
}

const statusOf = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id } })).status;

describe('every path that extends brings the user back', () => {
  it('PUT with a new date', async () => {
    const id = await expiredUser('put-extend');
    const res = await app.inject({
      method: 'PUT',
      url: `/api/users/${id}`,
      headers: auth(),
      payload: { expireAt: new Date(Date.now() + 30 * DAY).toISOString() },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await statusOf(id)).toBe('active');
    expect(JSON.parse(res.body).status).toBe('active');
  });

  it('bulk extend', async () => {
    const id = await expiredUser('bulk-extend');
    const res = await app.inject({
      method: 'POST',
      url: '/api/users/bulk',
      headers: auth(),
      payload: { userIds: [id], action: 'extend', expireDays: 30 },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await statusOf(id)).toBe('active');
  });

  it('through an API token, the way an operator bot extends after payment', async () => {
    const minted = await app.inject({ method: 'POST', url: '/api/api-tokens', headers: auth(), payload: { name: 'bot' } });
    const bot = JSON.parse(minted.body).token as string;
    const id = await expiredUser('api-extend');
    const res = await app.inject({
      method: 'PUT',
      url: `/api/users/${id}`,
      headers: auth(bot),
      payload: { expireAt: new Date(Date.now() + 30 * DAY).toISOString() },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await statusOf(id)).toBe('active');
  });

  it('a description edit that carries `active` leaves an expired user expired and moves nothing', async () => {
    const id = await expiredUser('desc-edit');
    const seen = statusEvents();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/users/${id}`,
      headers: auth(),
      payload: { status: 'active', description: 'paid by card' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await statusOf(id)).toBe('expired');
    expect(seen).toEqual([]);
  });
});
