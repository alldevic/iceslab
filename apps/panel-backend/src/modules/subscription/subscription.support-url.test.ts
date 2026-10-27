import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { invalidateSubscriptionSettingsCache } from '../settings/settings.service.js';
import { headerSafeUrl } from '../../lib/util/header-url.js';

/**
 * A-168: a Support-URL with non-ASCII characters took /sub down for every
 * user. The schema let it through, the subscription put it into a header as
 * it was, and Node refuses such a header (ERR_INVALID_CHAR) before the route
 * answers anything.
 */
const RAW = 'https://поддержка.рф/путь?q=привет';
const SAFE = 'https://xn--80ahaefyxhn.xn--p1ai/%D0%BF%D1%83%D1%82%D1%8C?q=%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82';

describe('headerSafeUrl', () => {
  it('punycodes the host and percent-encodes path and query', () => {
    expect(headerSafeUrl(RAW)).toBe(SAFE);
  });

  it('leaves an ASCII URL as the browser would, and refuses what is no URL', () => {
    expect(headerSafeUrl('https://t.me/support')).toBe('https://t.me/support');
    expect(headerSafeUrl('not a url')).toBeNull();
    expect(headerSafeUrl(null)).toBeNull();
  });
});

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

async function subscriber(): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/users', headers: auth(), payload: { username: 'support_user' } });
  expect(res.statusCode, res.body).toBe(201);
  return JSON.parse(res.body).subscriptionToken as string;
}

describe('Support-URL on /sub', () => {
  it('is saved normalised, and /sub answers 200 with an ASCII header', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: auth(),
      payload: { subscriptionSupportUrl: RAW },
    });
    expect(put.statusCode, put.body).toBe(200);
    const row = await prisma.appSetting.findUniqueOrThrow({ where: { key: 'subscriptionSupportUrl' } });
    expect(row.value).toBe(SAFE);

    const res = await app.inject({ method: 'GET', url: `/sub/${await subscriber()}?format=plain` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['support-url']).toBe(SAFE);
  });

  it('a raw value stored before the fix does not take /sub down', async () => {
    await prisma.appSetting.upsert({
      where: { key: 'subscriptionSupportUrl' },
      create: { key: 'subscriptionSupportUrl', value: RAW },
      update: { value: RAW },
    });
    invalidateSubscriptionSettingsCache();
    const res = await app.inject({ method: 'GET', url: `/sub/${await subscriber()}?format=plain` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['support-url']).toBe(SAFE);
  });
});
