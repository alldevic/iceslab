import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { invalidateSrrCache } from './srr.service.js';

let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  invalidateSrrCache(); // the service caches compiled rules; reset between tests
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

describe('POST /api/srr', () => {
  it('creates a rule and returns 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/srr',
      headers: auth(),
      payload: {
        name: 'Hiddify',
        uaPattern: 'Hiddify',
        format: 'singbox',
        priority: 10,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.id).toBeDefined();
    expect(body.name).toBe('Hiddify');
    expect(body.priority).toBe(10);
    expect(body.enabled).toBe(true);
  });

  it('returns 400 on invalid regex', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/srr',
      headers: auth(),
      payload: { name: 'bad', uaPattern: '[unclosed(', format: 'plain' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 on invalid format', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/srr',
      headers: auth(),
      payload: { name: 'x', uaPattern: '.*', format: 'mihomo-json' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 409 on duplicate name', async () => {
    await prisma.subscriptionResponseRule.create({
      data: { name: 'Hiddify', uaPattern: 'Hiddify', format: 'singbox' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/srr',
      headers: auth(),
      payload: { name: 'Hiddify', uaPattern: '.*', format: 'plain' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('returns 401 without a token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/srr',
      payload: { name: 'x', uaPattern: '.*', format: 'plain' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/srr', () => {
  it('returns rules sorted by priority ASC', async () => {
    await prisma.subscriptionResponseRule.createMany({
      data: [
        { name: 'last',  uaPattern: 'b', format: 'plain', priority: 999 },
        { name: 'first', uaPattern: 'a', format: 'clash', priority: 10 },
        { name: 'mid',   uaPattern: 'c', format: 'singbox', priority: 100 },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/api/srr', headers: auth() });
    expect(res.statusCode).toBe(200);
    const { rules } = JSON.parse(res.body);
    expect(rules.map((r: { name: string }) => r.name)).toEqual(['first', 'mid', 'last']);
  });
});

describe('PUT /api/srr/:id', () => {
  it('updates priority and enabled flag', async () => {
    const created = await prisma.subscriptionResponseRule.create({
      data: { name: 'Hiddify', uaPattern: 'Hiddify', format: 'singbox', priority: 100 },
    });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/srr/${created.id}`,
      headers: auth(),
      payload: { priority: 5, enabled: false },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.priority).toBe(5);
    expect(body.enabled).toBe(false);
  });

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/srr/00000000-0000-0000-0000-000000000000',
      headers: auth(),
      payload: { priority: 5 },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /api/srr/:id', () => {
  it('deletes a rule and returns 204', async () => {
    const created = await prisma.subscriptionResponseRule.create({
      data: { name: 'temp', uaPattern: '.*', format: 'plain' },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/srr/${created.id}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(204);
    expect(await prisma.subscriptionResponseRule.count()).toBe(0);
  });

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/srr/00000000-0000-0000-0000-000000000000',
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/srr/test', () => {
  it('returns the matching format for a UA', async () => {
    await prisma.subscriptionResponseRule.create({
      data: { name: 'Hiddify', uaPattern: 'Hiddify', format: 'singbox', priority: 10 },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/srr/test',
      headers: auth(),
      payload: { userAgent: 'Hiddify/2.5' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).format).toBe('singbox');
  });

  it('returns null format when no rule matches', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/srr/test',
      headers: auth(),
      payload: { userAgent: 'curl/8' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).format).toBeNull();
  });
});

describe('the wg flavour of a rule (12.4)', () => {
  const send = (method: 'POST' | 'PUT', url: string, payload: object) =>
    app.inject({ method, url, headers: auth(), payload });

  it('is stored on a wgconf rule and listed', async () => {
    const res = await send('POST', '/api/srr', { name: 'WG', uaPattern: 'wg', format: 'wgconf', proto: 'wireguard' });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).proto).toBe('wireguard');
    const list = await app.inject({ method: 'GET', url: '/api/srr', headers: auth() });
    expect(JSON.parse(list.body).rules[0].proto).toBe('wireguard');
  });

  it('is refused on create for another format', async () => {
    const res = await send('POST', '/api/srr', { name: 'X', uaPattern: 'x', format: 'clash', proto: 'wireguard' });
    expect(res.statusCode).toBe(400);
  });

  it('is refused on update when the merged rule is not wgconf, either way round', async () => {
    const wg = await prisma.subscriptionResponseRule.create({
      data: { name: 'WG', uaPattern: 'wg', format: 'wgconf', proto: 'wireguard' },
    });
    // The format alone moves away from the stored flavour.
    const a = await send('PUT', `/api/srr/${wg.id}`, { format: 'clash' });
    expect(a.statusCode).toBe(400);
    expect(JSON.parse(a.body).field).toBe('proto');
    // Moving the format and clearing the flavour together is fine.
    const b = await send('PUT', `/api/srr/${wg.id}`, { format: 'clash', proto: null });
    expect(b.statusCode).toBe(200);
    // The flavour alone onto a rule that is not wgconf.
    const c = await send('PUT', `/api/srr/${wg.id}`, { proto: 'amneziawg' });
    expect(c.statusCode).toBe(400);
  });

  it('shows in the User-Agent check', async () => {
    await prisma.subscriptionResponseRule.create({
      data: { name: 'WG', uaPattern: 'wg', format: 'wgconf', proto: 'wireguard' },
    });
    const res = await send('POST', '/api/srr/test', { userAgent: 'wg/1' });
    expect(JSON.parse(res.body)).toMatchObject({ format: 'wgconf', proto: 'wireguard' });
  });
});
