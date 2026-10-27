import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { generateTotp } from '../../lib/auth/totp.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';

/**
 * A-123: 2FA is managed from an admin session only. A full API token carries
 * the issuing admin, so before this it could call setup, compute a code from
 * the secret it got back, enable 2FA, and lock the owner out of the panel at
 * the next password login.
 */

let app: FastifyInstance;
let session: string;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  session = await registerAndLogin(app);
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

async function fullToken(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/api-tokens',
    headers: { authorization: `Bearer ${session}` },
    payload: { name: 'bot' },
  });
  expect(res.statusCode).toBe(201);
  const row = await prisma.apiToken.findFirstOrThrow({ where: { name: 'bot' } });
  // The case that mattered: a full token WITH an issuing admin, so
  // requireAuth sets request.admin from it.
  expect(row.createdByAdminId).not.toBeNull();
  expect(row.scopes).toEqual([]);
  return JSON.parse(res.body).token as string;
}

const call = (url: string, bearer: string, payload?: unknown) =>
  app.inject({
    method: url.endsWith('/status') ? 'GET' : 'POST',
    url,
    headers: { authorization: `Bearer ${bearer}` },
    ...(payload !== undefined ? { payload } : {}),
  });

describe('2FA routes refuse an API token', () => {
  it('a full token gets 403 on status, setup, enable and disable, and 2FA stays off', async () => {
    const token = await fullToken();
    for (const [url, body] of [
      ['/api/auth/2fa/status', undefined],
      ['/api/auth/2fa/setup', undefined],
      ['/api/auth/2fa/enable', { code: '000000' }],
      ['/api/auth/2fa/disable', { code: '000000' }],
    ] as const) {
      const res = await call(url, token, body);
      expect(res.statusCode, url).toBe(403);
      expect(JSON.parse(res.body).error).toBe('FORBIDDEN');
    }
    const admin = await prisma.adminUser.findFirstOrThrow();
    expect(admin.totpEnabled).toBe(false);
    expect(admin.totpSecret).toBeNull();
  });

  it('the attack end to end: the token cannot enroll, so the password login still lets the owner in', async () => {
    const token = await fullToken();
    const setup = await call('/api/auth/2fa/setup', token);
    expect(setup.statusCode).toBe(403);
    expect(JSON.parse(setup.body).secret).toBeUndefined();

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'password123' },
    });
    expect(login.statusCode).toBe(200);
  });

  it('a session still enrolls and confirms', async () => {
    const setup = await call('/api/auth/2fa/setup', session);
    expect(setup.statusCode).toBe(200);
    const { secret } = JSON.parse(setup.body) as { secret: string };
    const code = generateTotp(secret, Math.floor(Date.now() / 1000));
    const enable = await call('/api/auth/2fa/enable', session, { code });
    expect(enable.statusCode).toBe(200);
    expect((await prisma.adminUser.findFirstOrThrow()).totpEnabled).toBe(true);
  });
});
