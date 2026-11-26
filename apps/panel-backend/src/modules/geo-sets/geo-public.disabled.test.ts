import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { geoArtifactToken } from './geo-public-url.js';

/** GEO_SELF_HOST off, the default: /geo/ is a 404 whatever the token (milestone 10.4). */
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp();
  await cleanDatabase();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await closeRedis();
});

describe('the flag is off', () => {
  it('the right token and an existing set answer 404, as any path the panel does not have', async () => {
    const set = await prisma.geoSet.create({ data: { name: 'geoip', kind: 'geoip', sourceType: 'builtin' } });
    expect(set.id).toBeTruthy();
    const geo = await app.inject({ method: 'GET', url: `/geo/${geoArtifactToken()}/geoip.dat` });
    const other = await app.inject({ method: 'GET', url: '/nothing/here' });
    expect(geo.statusCode).toBe(404);
    // The panel's own 404, not the route's: the same shape as a path it never had.
    expect(JSON.parse(geo.body)).toMatchObject({ error: 'Not Found', statusCode: 404 });
    expect(JSON.parse(other.body)).toMatchObject({ error: 'Not Found', statusCode: 404 });
  });
});
