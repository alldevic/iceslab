import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { subscriptionOrigin } from '../../config.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { invalidateSubscriptionSettingsCache } from '../settings/settings.service.js';

/**
 * A-171: the copy-paste subscription link in the users list and the drawer is
 * built from /api/auth/status. It gave the environment's origin only, so after
 * the operator moved /sub to its own host in the panel settings, the page and
 * the endpoint list printed the new host and the copied link the old one.
 */

let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  invalidateSubscriptionSettingsCache();
  token = await registerAndLogin(app);
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

async function statusUrl(): Promise<string> {
  const res = await app.inject({ method: 'GET', url: '/api/auth/status' });
  expect(res.statusCode).toBe(200);
  return (JSON.parse(res.body) as { panel: { publicUrl: string } }).panel.publicUrl;
}

describe('/api/auth/status publicUrl', () => {
  it('is the host set in the panel once there is one', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { subscriptionPublicHost: 'nw.example.com' },
    });
    expect(put.statusCode, put.body).toBe(200);
    invalidateSubscriptionSettingsCache();
    expect(await statusUrl()).toBe('https://nw.example.com');
  });

  it('is the environment origin while none is set, as before', async () => {
    expect(await statusUrl()).toBe(subscriptionOrigin());
  });
});
