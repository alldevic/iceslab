// Regions are a small table, and the reason to test them is not the CRUD.
//
// Measured before writing: the whole suite stayed green with `requireAuth`
// removed from all four routes. Every other module's routes are exercised by
// something that would notice; this one was exercised by nothing, so the panel
// could have shipped an unauthenticated write endpoint and no test would have
// said a word.
//
// The other thing worth pinning is what DELETE does to the nodes in a region.
// The FK is ON DELETE SET NULL and the route relies on it - a region that took
// its nodes with it would delete the fleet's addresses, bindings and history in
// one click on a screen that looks like a labelling tool.

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';

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

async function createRegion(name: string, code: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/regions',
    headers: auth(),
    payload: { name, code },
  });
  expect(res.statusCode, res.body).toBe(201);
  return JSON.parse(res.body);
}

describe('every region route is behind auth', () => {
  // Written as one table so a route added later without `auth` is a missing
  // row here, not an invisible omission.
  it('refuses all four verbs without a token', async () => {
    const region = await createRegion('Frankfurt', 'de-fra');

    const calls = [
      { method: 'GET' as const, url: '/api/regions' },
      { method: 'POST' as const, url: '/api/regions', payload: { name: 'x', code: 'x' } },
      { method: 'PUT' as const, url: `/api/regions/${region.id}`, payload: { name: 'y' } },
      { method: 'DELETE' as const, url: `/api/regions/${region.id}` },
    ];

    for (const call of calls) {
      const res = await app.inject(call);
      expect(res.statusCode, `${call.method} ${call.url} answered ${res.statusCode} with no token`).toBe(401);
    }

    // And the unauthenticated attempts changed nothing.
    expect(await prisma.region.count()).toBe(1);
  });

  it('refuses a token that is not ours', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/regions',
      headers: { authorization: 'Bearer not.a.real.token' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('deleting a region', () => {
  // The failure this guards is the one that cannot be undone from the UI.
  it('releases its nodes instead of deleting them', async () => {
    const region = await createRegion('Frankfurt', 'de-fra');
    const node = await prisma.node.create({
      data: {
        name: 'n-fra-1',
        address: 'n-fra-1.example.com:1337',
        heartbeatSecret: Buffer.alloc(32),
        regionId: region.id,
      },
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/regions/${region.id}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(204);

    const after = await prisma.node.findUnique({ where: { id: node.id } });
    expect(
      after,
      'deleting a region must not delete the nodes in it: that is the fleet, its bindings ' +
        'and its history, removed from a screen that labels machines',
    ).not.toBeNull();
    expect(after!.regionId, 'the node should simply be regionless again').toBeNull();
  });

  it('answers 404 for a region that is not there', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/regions/11111111-1111-4111-8111-111111111111',
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('names and codes stay unique', () => {
  // A duplicate code is not a server fault, and reporting it as one sends an
  // operator looking for a broken panel instead of at the name they reused.
  it('answers 409, not 500, on a duplicate name or code', async () => {
    await createRegion('Frankfurt', 'de-fra');

    const sameName = await app.inject({
      method: 'POST',
      url: '/api/regions',
      headers: auth(),
      payload: { name: 'Frankfurt', code: 'de-fra-2' },
    });
    expect(sameName.statusCode).toBe(409);

    const sameCode = await app.inject({
      method: 'POST',
      url: '/api/regions',
      headers: auth(),
      payload: { name: 'Frankfurt 2', code: 'de-fra' },
    });
    expect(sameCode.statusCode).toBe(409);

    expect(await prisma.region.count()).toBe(1);
  });

  it('answers 409 when a rename collides, and leaves the row alone', async () => {
    await createRegion('Frankfurt', 'de-fra');
    const helsinki = await createRegion('Helsinki', 'fi-hel');

    const res = await app.inject({
      method: 'PUT',
      url: `/api/regions/${helsinki.id}`,
      headers: auth(),
      payload: { code: 'de-fra' },
    });
    expect(res.statusCode).toBe(409);

    const row = await prisma.region.findUniqueOrThrow({ where: { id: helsinki.id } });
    expect(row.code, 'a refused rename must not half-apply').toBe('fi-hel');
  });

  it('answers 404 when renaming a region that is not there', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/regions/11111111-1111-4111-8111-111111111111',
      headers: auth(),
      payload: { name: 'ghost' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('the list', () => {
  // nodeCount is the only computed field on the screen, and an operator uses it
  // to decide whether a region is safe to remove.
  it('counts the nodes in each region', async () => {
    const fra = await createRegion('Frankfurt', 'de-fra');
    const hel = await createRegion('Helsinki', 'fi-hel');
    for (const [i, regionId] of [fra.id, fra.id, hel.id].entries()) {
      await prisma.node.create({
        data: {
          name: `n-${i}`,
          address: `n-${i}.example.com:1337`,
          heartbeatSecret: Buffer.alloc(32),
          regionId,
        },
      });
    }

    const res = await app.inject({ method: 'GET', url: '/api/regions', headers: auth() });
    expect(res.statusCode).toBe(200);
    const { regions } = JSON.parse(res.body);

    // Sorted by name, so Frankfurt comes before Helsinki.
    expect(regions.map((r: { name: string }) => r.name)).toEqual(['Frankfurt', 'Helsinki']);
    expect(regions[0].nodeCount).toBe(2);
    expect(regions[1].nodeCount).toBe(1);
  });
});
