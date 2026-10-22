import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { generateTotp } from '../../lib/auth/totp.js';
import { config } from '../../config.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';

/**
 * A-169: a wrong 2FA code from a signed-in admin answered 401, and the panel
 * reads any 401 as an expired session: one mistyped digit while enabling or
 * disabling 2FA signed the admin out and lost the setup. It is 400 now, with
 * the same INVALID_TOTP, and the session goes on.
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

const post = (url: string, payload?: unknown) =>
  app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${session}` },
    ...(payload !== undefined ? { payload } : {}),
  });

/** A code that is not the current one: the right one with its last digit moved. */
function wrongCode(secret: string): string {
  const right = generateTotp(secret, Math.floor(Date.now() / 1000));
  return right.slice(0, 5) + String((Number(right[5]) + 5) % 10);
}

async function sessionStillWorks(): Promise<void> {
  const res = await app.inject({
    method: 'GET',
    url: '/api/auth/2fa/status',
    headers: { authorization: `Bearer ${session}` },
  });
  expect(res.statusCode).toBe(200);
}

/** Set up and enable 2FA; the code that confirmed it, and the secret. */
async function enabled(): Promise<{ secret: string; code: string }> {
  const setup = await post('/api/auth/2fa/setup');
  const { secret } = JSON.parse(setup.body) as { secret: string };
  const code = generateTotp(secret, Math.floor(Date.now() / 1000));
  const ok = await post('/api/auth/2fa/enable', { code });
  expect(ok.statusCode, ok.body).toBe(200);
  return { secret, code };
}

// A-123, second half: the login's lockout and replay guard on enable and disable.
describe('2FA codes on enable and disable', () => {
  it('lock the admin out after as many wrong codes as the login allows, even for the right code', async () => {
    const { secret } = await enabled();
    for (let i = 0; i < config.LOGIN_LOCKOUT_FAILURES; i++) {
      const res = await post('/api/auth/2fa/disable', { code: wrongCode(secret) });
      expect(res.statusCode, `attempt ${i + 1}`).toBe(400);
    }
    const right = generateTotp(secret, Math.floor(Date.now() / 1000) + 30);
    const locked = await post('/api/auth/2fa/disable', { code: right });
    expect(locked.statusCode, locked.body).toBe(429);
    const body = JSON.parse(locked.body) as { error: string; retryAfterSeconds: number };
    expect(body.error).toBe('ACCOUNT_LOCKED');
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(locked.headers['retry-after']).toBe(String(body.retryAfterSeconds));
    expect((await prisma.adminUser.findFirstOrThrow()).totpEnabled).toBe(true);
  });

  it('spend a code once: the code that enabled 2FA neither disables it nor signs in again', async () => {
    const { code } = await enabled();
    const again = await post('/api/auth/2fa/disable', { code });
    expect(again.statusCode, again.body).toBe(400);
    expect(JSON.parse(again.body).error).toBe('INVALID_TOTP');
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'password123', totpCode: code },
    });
    expect(login.statusCode, login.body).toBe(401);
    expect(JSON.parse(login.body).error).toBe('INVALID_TOTP');
    expect((await prisma.adminUser.findFirstOrThrow()).totpEnabled).toBe(true);
  });
});

describe('a wrong 2FA code from a signed-in admin', () => {
  it('is 400 INVALID_TOTP on enable, 2FA stays off and the session goes on', async () => {
    const setup = await post('/api/auth/2fa/setup');
    const { secret } = JSON.parse(setup.body) as { secret: string };
    const res = await post('/api/auth/2fa/enable', { code: wrongCode(secret) });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('INVALID_TOTP');
    expect((await prisma.adminUser.findFirstOrThrow()).totpEnabled).toBe(false);
    await sessionStillWorks();
  });

  it('is 400 INVALID_TOTP on disable, 2FA stays on and the session goes on', async () => {
    const setup = await post('/api/auth/2fa/setup');
    const { secret } = JSON.parse(setup.body) as { secret: string };
    const ok = await post('/api/auth/2fa/enable', { code: generateTotp(secret, Math.floor(Date.now() / 1000)) });
    expect(ok.statusCode).toBe(200);
    const res = await post('/api/auth/2fa/disable', { code: wrongCode(secret) });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('INVALID_TOTP');
    expect((await prisma.adminUser.findFirstOrThrow()).totpEnabled).toBe(true);
    await sessionStillWorks();
  });
});
