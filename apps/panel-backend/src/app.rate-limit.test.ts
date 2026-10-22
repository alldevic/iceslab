import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { prisma } from './prisma.js';
import { closeRedis } from './lib/infra/redis.js';
import { cleanDatabase } from '../tests/helpers/db.js';

/**
 * The A-168 tail: a 429 RATE_LIMITED says how long to wait in its body, as
 * ACCOUNT_LOCKED does with retryAfterSeconds. The rate-limit plugin put the
 * wait only in the Retry-After header.
 */

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('429 RATE_LIMITED', () => {
  it('carries retryAfterSeconds in the body, the same number as Retry-After', async () => {
    // The login route allows five a minute per address (auth.routes.ts).
    let res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'nobody', password: 'wrong-password' } });
    for (let i = 0; i < 10 && res.statusCode !== 429; i++) {
      res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'nobody', password: 'wrong-password' } });
    }
    expect(res.statusCode, res.body).toBe(429);
    const body = JSON.parse(res.body) as { error: string; retryAfterSeconds?: number };
    expect(body.error).toBe('RATE_LIMITED');
    expect(body.retryAfterSeconds).toBe(Number(res.headers['retry-after']));
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
  });
});
