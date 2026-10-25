import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { sourceIdSha256 } from './erased-sources.js';

/**
 * A-268 tombstone, as importers see it: POST /api/users with the source id of
 * a user that was erased answers 409 SOURCE_ID_ERASED, field sourceId, in
 * words. That body is the contract an importer reads to skip the row.
 * erased_user_sources is not in cleanDatabase's list: this file clears it.
 */
let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  await prisma.erasedUserSource.deleteMany({});
  token = await registerAndLogin(app);
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.erasedUserSource.deleteMany({});
  await prisma.$disconnect();
  await closeRedis();
});

const post = (payload: object) =>
  app.inject({ method: 'POST', url: '/api/users', headers: { authorization: `Bearer ${token}` }, payload });

describe('POST /api/users with the source id of an erased user', () => {
  it('answers 409 SOURCE_ID_ERASED on the sourceId field, in words, and creates nothing', async () => {
    const sourceId = `rw-${randomUUID()}`;
    await prisma.erasedUserSource.create({ data: { sourceIdSha256: sourceIdSha256(sourceId) } });

    const res = await post({ username: 'came_back', sourceId });
    expect(res.statusCode, res.body).toBe(409);
    const body = JSON.parse(res.body) as { error: string; field: string; message: string };
    expect(body).toMatchObject({ error: 'SOURCE_ID_ERASED', field: 'sourceId' });
    expect(body.message).toContain('erased');
    expect(await prisma.user.count({ where: { username: 'came_back' } })).toBe(0);
  });

  it('another source id and no source id are created as before', async () => {
    await prisma.erasedUserSource.create({ data: { sourceIdSha256: sourceIdSha256(`rw-${randomUUID()}`) } });
    expect((await post({ username: 'other_source', sourceId: `rw-${randomUUID()}` })).statusCode).toBe(201);
    expect((await post({ username: 'by_hand' })).statusCode).toBe(201);
  });
});
