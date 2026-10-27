import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { ConsumptionMultiplierSchema } from './nodes.schemas.js';

/**
 * A-143 (decisions.md 2026-10-22): the consumption multiplier is 0 to 100 in
 * steps of 0.1, 0 a free node; stored in whole tenths, answered as a number.
 */

describe('ConsumptionMultiplierSchema', () => {
  it('takes 0, 0.5, 1 and 100', () => {
    for (const v of [0, 0.5, 1, 2.3, 100]) expect(ConsumptionMultiplierSchema.safeParse(v).success, String(v)).toBe(true);
  });

  it('refuses 100.1, -0.1 and 1.25 (off the step is a refusal, not a rounding)', () => {
    for (const v of [100.1, -0.1, 1.25]) expect(ConsumptionMultiplierSchema.safeParse(v).success, String(v)).toBe(false);
  });
});

describe('the multiplier through the API', () => {
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

  const auth = () => ({ authorization: `Bearer ${token}` });

  it('defaults to 1, stores tenths, answers a number, and takes 0 and 0.5 on edit', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/nodes', headers: auth(), payload: { name: 'm1', address: 'm1.test' } });
    expect(created.statusCode, created.body).toBe(201);
    const node = JSON.parse(created.body) as { id: string; consumptionMultiplier: unknown };
    expect(node.consumptionMultiplier).toBe(1);
    expect((await prisma.node.findUniqueOrThrow({ where: { id: node.id } })).consumptionMultiplierTenths).toBe(10);

    for (const [sent, tenths] of [[0.5, 5], [0, 0], [100, 1000]] as const) {
      const res = await app.inject({ method: 'PUT', url: `/api/nodes/${node.id}`, headers: auth(), payload: { consumptionMultiplier: sent } });
      expect(res.statusCode, res.body).toBe(200);
      expect(JSON.parse(res.body).consumptionMultiplier).toBe(sent);
      expect((await prisma.node.findUniqueOrThrow({ where: { id: node.id } })).consumptionMultiplierTenths).toBe(tenths);
    }

    const bad = await app.inject({ method: 'PUT', url: `/api/nodes/${node.id}`, headers: auth(), payload: { consumptionMultiplier: 1.25 } });
    expect(bad.statusCode).toBe(400);
  });
});
