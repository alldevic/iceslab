import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';

/**
 * A-166: a sort with ties still pages through every user once. The list is
 * ordered by the chosen key and then by id, so equal keys (0 traffic, no
 * expiry, the same import second) come in one order on every page.
 */

let app: FastifyInstance;
let token: string;
const N = 120;

beforeAll(async () => {
  app = await buildApp();
  await cleanDatabase();
  token = await registerAndLogin(app);
  // One through the API, the rest as copies of its row (the create route is
  // rate-limited): the same 0 traffic, no expiry and one creation second for
  // all, as an import gives.
  const res = await app.inject({
    method: 'POST', url: '/api/users', headers: { authorization: `Bearer ${token}` },
    payload: { username: 'tie-000', createdAt: '2025-01-01T00:00:00.000Z' },
  });
  expect(res.statusCode, res.body).toBe(201);
  const first = await prisma.user.findUniqueOrThrow({ where: { id: JSON.parse(res.body).id as string } });
  const { id: _id, updatedAt: _u, ...row } = first;
  for (let i = 1; i < N; i++) {
    const n = String(i).padStart(3, '0');
    await prisma.user.create({
      data: { ...row, username: `tie-${n}`, shortId: `tie${n}xx`, subscriptionToken: `tie-token-${n}-0000000000000000`, traffic: { create: {} } } as never,
    });
  }
}, 120_000);

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await closeRedis();
});

describe('paging a sort with ties', () => {
  for (const sort of ['traffic', 'lifetimeTraffic', 'lastOnline', 'firstConnected', 'expireAt', 'createdAt']) {
    it(`${sort}: three pages of 50 hold the ${N} users once each`, async () => {
      const ids: string[] = [];
      for (const page of [1, 2, 3]) {
        const res = await app.inject({
          method: 'GET', url: `/api/users?sort=${sort}&order=desc&limit=50&page=${page}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode, res.body).toBe(200);
        ids.push(...(JSON.parse(res.body) as { users: { id: string }[] }).users.map((u) => u.id));
      }
      expect(ids).toHaveLength(N);
      expect(new Set(ids).size).toBe(N);
      // And in id order, the tie-breaker.
      expect(ids).toEqual([...ids].sort());
    });
  }
});
