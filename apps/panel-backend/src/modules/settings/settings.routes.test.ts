// A setting that already exists follows the code, not the row it was born as.
//
// `isPublic` was written only in the `create` branch of the settings upsert.
// The comment above PUBLIC_KEYS says "flip `isPublic` per key", which reads as
// though editing that set were enough - and it is, exactly once, on an install
// where the row does not exist yet. For every panel that has already written
// the key, the visibility it was born with is the visibility it keeps.
//
// Both directions cost something real, and `/api/settings/public` is
// deliberately unauthenticated: a key taken OUT of PUBLIC_KEYS because it leaked
// keeps being served; a key put IN never becomes readable by the SPA that needs
// it before anyone has logged in. The tests seed a row in the wrong state, which
// is what an upgraded install looks like.

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
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

describe('a setting that already exists follows the code, not the row it was born as', () => {
  it('stops serving a key that is no longer public', async () => {
    // `brandName` is the only public key, so any other key standing marked
    // public is one the code says must not be served.
    await prisma.appSetting.create({
      data: { key: 'subscriptionSupportUrl', value: 'https://old.example.com', isPublic: true },
    });

    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: auth(),
      payload: { subscriptionSupportUrl: 'https://support.example.com/help' },
    });
    expect(put.statusCode).toBe(200);

    // The control: the write did land, so this is about visibility and not
    // about a PUT that quietly did nothing.
    const all = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/settings', headers: auth() })).body,
    );
    expect(all.subscriptionSupportUrl).toBe('https://support.example.com/help');

    const pub = JSON.parse((await app.inject({ method: 'GET', url: '/api/settings/public' })).body);
    expect(
      pub,
      'an operator support URL is served to anyone who asks, on every panel that wrote the key before it was made private',
    ).not.toHaveProperty('subscriptionSupportUrl');
  });

  it('starts serving a key that has become public', async () => {
    await prisma.appSetting.create({
      data: { key: 'brandName', value: 'Old Brand', isPublic: false },
    });

    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: auth(),
      payload: { brandName: 'New Brand' },
    });
    expect(put.statusCode).toBe(200);

    const pub = JSON.parse((await app.inject({ method: 'GET', url: '/api/settings/public' })).body);
    expect(pub.brandName).toBe('New Brand');
  });
});
