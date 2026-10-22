import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { generateTotp } from '../../lib/auth/totp.js';
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
