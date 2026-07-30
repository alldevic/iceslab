import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
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

describe('POST /api/users', () => {
  it('creates a user with default values', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: auth(),
      payload: { username: 'alice' },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.username).toBe('alice');
    expect(body.status).toBe('active');
    expect(body.trafficLimitStrategy).toBe('no_reset');
    expect(body.trafficLimitBytes).toBeNull();
    expect(body.expireAt).toBeNull();

    // Public DTO must not leak protocol secrets
    expect(body).not.toHaveProperty('hysteriaPassword');
    expect(body).not.toHaveProperty('amneziawgPrivateKey');
    expect(body).not.toHaveProperty('xrayUuid');
  });

  it('returns 401 without a token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      payload: { username: 'noauth' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 409 when username is already taken', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: auth(),
      payload: { username: 'dup' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: auth(),
      payload: { username: 'dup' },
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('CONFLICT');
  });

  it('returns 400 for invalid traffic strategy', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: auth(),
      payload: { username: 'badstrat', trafficLimitStrategy: 'invalid' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/users', () => {
  it('returns paginated list', async () => {
    for (const username of ['user_a', 'user_b', 'user_c']) {
      await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: auth(),
        payload: { username },
      });
    }

    const res = await app.inject({
      method: 'GET',
      url: '/api/users?page=1&limit=10',
      headers: auth(),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(3);
    expect(body.users).toHaveLength(3);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(10);
  });

  // R3 - a per-user routing override lives in a collapsed Advanced block on one
  // user's page, so without a filter nobody can answer "who did we pin". These
  // pin the three shapes of the query.
  describe('routingPreset filter', () => {
    async function seed() {
      for (const [username, routingPreset] of [
        ['pinned_ru', 'ru-split'],
        ['pinned_all', 'proxy-all'],
        ['inherits', null],
      ] as const) {
        await app.inject({
          method: 'POST',
          url: '/api/users',
          headers: auth(),
          payload: { username, ...(routingPreset ? { routingPreset } : {}) },
        });
      }
    }

    const list = async (qs: string) => {
      const res = await app.inject({ method: 'GET', url: `/api/users?${qs}`, headers: auth() });
      expect(res.statusCode).toBe(200);
      return JSON.parse(res.body).users.map((u: { username: string }) => u.username).sort();
    };

    it('keeps only users pinned to one preset', async () => {
      await seed();
      expect(await list('routingPreset=ru-split')).toEqual(['pinned_ru']);
    });

    it('`any` keeps everyone carrying an override', async () => {
      await seed();
      expect(await list('routingPreset=any')).toEqual(['pinned_all', 'pinned_ru']);
    });

    it('`none` keeps the ones that inherit', async () => {
      await seed();
      expect(await list('routingPreset=none')).toEqual(['inherits']);
    });

    it('rejects a preset that does not exist rather than returning everyone', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/users?routingPreset=not-a-preset',
        headers: auth(),
      });
      expect(res.statusCode).toBe(400);
    });
  });
});

describe('GET /api/users/:id', () => {
  it('returns the user by id', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: auth(),
      payload: { username: 'findme' },
    });
    const { id } = JSON.parse(created.body);

    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${id}`,
      headers: auth(),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).username).toBe('findme');
  });

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/users/00000000-0000-0000-0000-000000000000',
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('PUT /api/users/:id', () => {
  it('updates editable fields', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: auth(),
      payload: { username: 'editme' },
    });
    const { id } = JSON.parse(created.body);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/users/${id}`,
      headers: auth(),
      payload: { description: 'updated', tag: 'vip', status: 'disabled' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.description).toBe('updated');
    expect(body.tag).toBe('vip');
    expect(body.status).toBe('disabled');
  });

  it('rejects status values reserved for cron', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: auth(),
      payload: { username: 'badstatus' },
    });
    const { id } = JSON.parse(created.body);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/users/${id}`,
      headers: auth(),
      payload: { status: 'expired' },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('VALIDATION_ERROR');
  });
});

describe('DELETE /api/users/:id', () => {
  it('soft-deletes the user', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: auth(),
      payload: { username: 'goner' },
    });
    const { id } = JSON.parse(created.body);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/users/${id}`,
      headers: auth(),
    });
    expect(del.statusCode).toBe(204);

    const get = await app.inject({
      method: 'GET',
      url: `/api/users/${id}`,
      headers: auth(),
    });
    expect(get.statusCode).toBe(404);
  });

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/users/00000000-0000-0000-0000-000000000000',
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });
});
