import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { config } from '../../config.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';

/**
 * A-148: a user's device limit in three meanings (decisions.md 2026-10-22):
 * null as the squads say, 0 an explicit no-limit over a squad limit, N the
 * limit. 0 was refused by the schema, and null inherited the squad's, so a
 * user could not be given no limit inside a limited squad at all.
 */

let app: FastifyInstance;
let session: string;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  session = await registerAndLogin(app);
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

const auth = () => ({ authorization: `Bearer ${session}` });

async function userInSquadLimitedTo(limit: number): Promise<{ id: string; token: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/users', headers: auth(), payload: { username: `u${Date.now()}` } });
  expect(res.statusCode, res.body).toBe(201);
  const user = JSON.parse(res.body) as { id: string; subscriptionToken: string };
  const member = await prisma.groupMember.findFirstOrThrow({ where: { userId: user.id } });
  await prisma.group.update({ where: { id: member.groupId }, data: { hwidDeviceLimit: limit } });
  return { id: user.id, token: user.subscriptionToken };
}

const fetchAs = (token: string, hwid: string) =>
  app.inject({ method: 'GET', url: `${config.SUBSCRIPTION_PATH_PREFIX}/${token}`, headers: { 'x-hwid': hwid } });

describe("a user's device limit", () => {
  it('takes 0 on save, as an explicit no-limit', async () => {
    const { id } = await userInSquadLimitedTo(3);
    const res = await app.inject({ method: 'PUT', url: `/api/users/${id}`, headers: auth(), payload: { hwidDeviceLimit: 0 } });
    expect(res.statusCode, res.body).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id } })).hwidDeviceLimit).toBe(0);
  });

  it('null inherits the squad limit: the fourth device of a squad at 3 is refused', async () => {
    const { token } = await userInSquadLimitedTo(3);
    for (const d of ['d1', 'd2', 'd3']) expect((await fetchAs(token, d)).statusCode, d).not.toBe(403);
    expect((await fetchAs(token, 'd4')).statusCode).toBe(403);
  });

  it('0 lets the fourth device through in the same squad', async () => {
    const { id, token } = await userInSquadLimitedTo(3);
    await prisma.user.update({ where: { id }, data: { hwidDeviceLimit: 0 } });
    for (const d of ['d1', 'd2', 'd3', 'd4']) {
      const res = await fetchAs(token, d);
      expect(res.statusCode, d).not.toBe(403);
      expect(res.headers['x-hwid-active']).toBe('0/unlimited');
    }
  });
});

describe('what a client says about itself', () => {
  it('keeps platform, OS, model and user agent on its device row, and a fetch without them erases nothing', async () => {
    const { id, token } = await userInSquadLimitedTo(3);
    const fetchWith = (headers: Record<string, string>) =>
      app.inject({ method: 'GET', url: `${config.SUBSCRIPTION_PATH_PREFIX}/${token}`, headers: { 'x-hwid': 'phone', ...headers } });
    await fetchWith({ 'x-device-os': 'iOS', 'x-ver-os': '18.1', 'x-device-model': 'iPhone15,2', 'user-agent': 'Happ/3.9' });
    await fetchWith({ 'user-agent': 'Happ/3.10' });
    const row = await prisma.hwidUserDevice.findFirstOrThrow({ where: { userId: id, hwid: 'phone' } });
    expect(row).toMatchObject({ platform: 'iOS', osVersion: '18.1', deviceModel: 'iPhone15,2', userAgent: 'Happ/3.10' });
  });
});
