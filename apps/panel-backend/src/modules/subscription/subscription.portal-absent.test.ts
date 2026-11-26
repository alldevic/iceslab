import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { registerBindingsCacheBust } from './subscription.bindings-cache.js';

/**
 * CLIENT_PORTAL_URL not set (the default): a browser gets the page and a client
 * the subscription, exactly as before the key existed. A file of its own,
 * because the file that sets the key cannot also test it unset (config is read
 * once at load), and an install that never sets it must see no difference.
 */

const BROWSER = { accept: 'text/html,application/xhtml+xml', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

let app: FastifyInstance;
let token: string;
let userId: string;

beforeAll(async () => {
  expect(process.env['CLIENT_PORTAL_URL']).toBeUndefined();
  registerBindingsCacheBust();
  app = await buildApp();
  await cleanDatabase();
  const admin = await registerAndLogin(app);
  const created = await app.inject({
    method: 'POST', url: '/api/users', headers: { authorization: `Bearer ${admin}` }, payload: { username: 'absent-user' },
  });
  expect(created.statusCode, created.body).toBe(201);
  token = JSON.parse(created.body).subscriptionToken;
  userId = JSON.parse(created.body).id;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await closeRedis();
});

const get = (headers: Record<string, string>, query = '') =>
  app.inject({ method: 'GET', url: `/sub/${token}${query}`, headers });

describe('no portal named', () => {
  it('a browser gets the page, not a redirect', async () => {
    const res = await get(BROWSER);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['location']).toBeUndefined();
  });

  it('a link with a tunnel preselection is the page too', async () => {
    const res = await get(BROWSER, '?node=abcd1234');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('a client gets the subscription', async () => {
    const res = await get({ 'user-agent': 'Happ/1.0' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
  });

  it('the browser of an expired subscription gets the page of refusal, 403', async () => {
    await prisma.user.update({ where: { id: userId }, data: { status: 'expired' } });
    const res = await get(BROWSER);
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain('text/html');
  });
});
