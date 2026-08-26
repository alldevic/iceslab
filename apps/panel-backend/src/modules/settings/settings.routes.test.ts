// The settings table has two doors, and only one of them is locked.
//
// `/api/settings/public` is deliberately unauthenticated: the SPA reads the
// brand name before anyone has logged in. Everything else in that table is
// operator configuration - support URLs, announce templates, routing rules,
// custom domain lists - and it is separated from the public half by a single
// `where: { isPublic: true }`.
//
// Measured before writing: the suite of 1542 stayed green with that filter
// removed, i.e. with the whole settings table served to anyone who asks. So
// both halves are pinned here: the public door stays open, and it stays narrow.

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

async function put(payload: Record<string, unknown>) {
  const res = await app.inject({ method: 'PUT', url: '/api/settings', headers: auth(), payload });
  expect(res.statusCode, res.body).toBeLessThan(300);
  return JSON.parse(res.body);
}

const readPublic = () => app.inject({ method: 'GET', url: '/api/settings/public' });

describe('the public door stays open', () => {
  // The login screen renders the brand before there is a session to check, so
  // an accidental `requireAuth` here is an empty page for every visitor.
  it('answers without a token', async () => {
    await put({ brandName: 'Iceslab Lab' });
    const res = await readPublic();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).brandName).toBe('Iceslab Lab');
  });

  it('answers an empty object before anything is configured', async () => {
    const res = await readPublic();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({});
  });
});

describe('the public door stays narrow', () => {
  // Everything written here through the admin route in one go; only the brand
  // is on the public list.
  it('serves the public keys and none of the operator ones', async () => {
    await put({
      brandName: 'Iceslab Lab',
      subscriptionSupportUrl: 'https://support.internal.example.com',
      subscriptionAnnounceTemplate: 'internal notice {{DAYS_LEFT}}',
      subscriptionProfileTitle: 'Internal profile title',
      subscriptionEntryPoolSize: 3,
    });

    const body = JSON.parse((await readPublic()).body);

    expect(body).toEqual({ brandName: 'Iceslab Lab' });
    for (const leaked of [
      'subscriptionSupportUrl',
      'subscriptionAnnounceTemplate',
      'subscriptionProfileTitle',
      'subscriptionEntryPoolSize',
    ]) {
      expect(body, `${leaked} reached an unauthenticated caller`).not.toHaveProperty(leaked);
    }
  });

  // The filter is on the column, not on a list consulted at read time. A row
  // written by a migration, a fixture or a future writer is judged by its own
  // flag - so a key nobody thought about is private by default.
  it('hides a row that was never marked public, whatever it is called', async () => {
    await prisma.appSetting.create({
      data: { key: 'someFutureSecret', value: 'do-not-publish', isPublic: false },
    });
    await prisma.appSetting.create({
      data: { key: 'someFutureBanner', value: 'publish-me', isPublic: true },
    });

    const body = JSON.parse((await readPublic()).body);
    expect(body).not.toHaveProperty('someFutureSecret');
    expect(body.someFutureBanner, 'the flag is what decides, in both directions').toBe('publish-me');
  });
});

describe('the admin door stays locked', () => {
  it('refuses to read or write the whole table without a session', async () => {
    await put({ brandName: 'Iceslab Lab', subscriptionSupportUrl: 'https://s.example.com' });

    const read = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(read.statusCode).toBe(401);

    const write = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { brandName: 'hijacked' },
    });
    expect(write.statusCode).toBe(401);

    // And the refused write changed nothing.
    const after = JSON.parse((await readPublic()).body);
    expect(after.brandName).toBe('Iceslab Lab');
  });

  it('serves the whole table to an authenticated admin', async () => {
    await put({ brandName: 'Iceslab Lab', subscriptionSupportUrl: 'https://s.example.com' });
    const res = await app.inject({ method: 'GET', url: '/api/settings', headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.brandName).toBe('Iceslab Lab');
    expect(
      body.subscriptionSupportUrl,
      'the admin view is the one place the operator settings are readable',
    ).toBe('https://s.example.com');
  });

  it('reports exactly the keys it wrote', async () => {
    const body = await put({ brandName: 'Iceslab Lab', subscriptionUpdateIntervalHours: 12 });
    expect(body.ok).toBe(true);
    expect([...body.updated].sort()).toEqual(['brandName', 'subscriptionUpdateIntervalHours']);
  });

  it('refuses a value the schema does not accept', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: auth(),
      payload: { subscriptionUpdateIntervalHours: 0 },
    });
    expect(res.statusCode, 'a poll interval of zero would make every client hammer /sub').toBe(400);
  });
});

/**
 * And the half that decides which door a key goes through, on a panel that has
 * already been running.
 *
 * `isPublic` is written only in the `create` branch of the upsert. The comment
 * above PUBLIC_KEYS says "future keys land in the same table; flip `isPublic`
 * per key", which reads as though editing that set were enough — and it is,
 * exactly once, on an install where the row does not exist yet. For every panel
 * that has already written the key, the visibility it was born with is the
 * visibility it keeps, and no amount of editing the code changes it.
 *
 * Both directions cost something real. A key taken OUT of PUBLIC_KEYS because
 * it turned out to leak keeps leaking on every existing install after the fix
 * ships. A key put IN never becomes readable, so the unauthenticated SPA that
 * needs it silently renders without it.
 */
describe('a setting that already exists follows the code, not the row it was born as', () => {
  it('stops serving a key that is no longer public', async () => {
    // An install from before the key was made private: the row exists and is
    // marked public. `brandName` is the only public key today, so any other key
    // standing in that state is one the code says must not be served.
    await prisma.appSetting.create({
      data: { key: 'subscriptionSupportUrl', value: 'https://old.example.com', isPublic: true },
    });

    // The operator saves settings, which is the only moment the panel has to
    // reconcile the row with the code.
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: auth(),
      payload: { subscriptionSupportUrl: 'https://support.example.com' },
    });
    expect(put.statusCode).toBe(200);

    const pub = await app.inject({ method: 'GET', url: '/api/settings/public' });
    const body = JSON.parse(pub.body);
    // The control: the write did land, so this is about visibility and not
    // about a PUT that quietly did nothing.
    const all = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/settings', headers: auth() })).body,
    );
    expect(all.subscriptionSupportUrl).toBe('https://support.example.com');

    expect(
      body,
      'an operator support URL is served to anyone who asks, on every panel that wrote the key before it was made private',
    ).not.toHaveProperty('subscriptionSupportUrl');
  });

  it('starts serving a key that has become public', async () => {
    // The mirror: an install predating brandName being public. The SPA reads it
    // before anyone has logged in, so a row stuck private renders the panel
    // unbranded with nothing to explain it.
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

    const body = JSON.parse((await app.inject({ method: 'GET', url: '/api/settings/public' })).body);
    expect(body.brandName).toBe('New Brand');
  });
});
