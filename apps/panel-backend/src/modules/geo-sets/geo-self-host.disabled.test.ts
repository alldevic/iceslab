import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { selfHostedGeo } from './geo-self-host.js';

/** GEO_SELF_HOST off, the default: nothing is claimed, and the subscription formats get null (the base). */
afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('selfHostedGeo with the flag off', () => {
  it('is null', async () => {
    expect(await selfHostedGeo()).toBeNull();
  });
});
