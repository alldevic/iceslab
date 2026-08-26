// Enrolling in 2FA, and turning it off again.
//
// Measured before writing: the suite of 1542 stayed green with `enableTotp`
// skipping its code check, and green again with `disableTotp` skipping its own.
// Both of those are the promises the module is FOR, and they are written down
// in its source:
//
//   * enable confirms a code first, "so a broken/mis-scanned secret can never
//     lock the admin out" - without it, an admin who mis-scans the QR is locked
//     out of their own panel at the next login and nothing can let them back in;
//   * disable "requires a current code so a hijacked session can't silently
//     turn 2FA off" - without it, a stolen JWT is enough to remove the second
//     factor, which is the whole reason the second factor exists.
//
// Exercised through the routes rather than the service, because the session
// check is part of the guard: all four are behind requireAuth, and an attacker
// with a stolen token is exactly who these tests stand against.

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin, DEFAULT_ADMIN } from '../../../tests/helpers/auth.js';
import { generateTotp } from '../../lib/totp.js';

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

function post(url: string, payload?: unknown) {
  return app.inject({ method: 'POST', url, headers: auth(), payload: payload ?? {} });
}

async function setup(): Promise<string> {
  const res = await post('/api/auth/2fa/setup');
  expect(res.statusCode, res.body).toBe(200);
  return JSON.parse(res.body).secret as string;
}

function codeFor(secret: string, atSec = Math.floor(Date.now() / 1000)): string {
  return generateTotp(secret, atSec);
}

/** Log in with the shared admin credentials, optionally with a code. */
function login(totpCode?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { ...DEFAULT_ADMIN, ...(totpCode ? { totpCode } : {}) },
  });
}

async function enabledInDb(): Promise<{ enabled: boolean; hasSecret: boolean }> {
  const row = await prisma.adminUser.findFirstOrThrow({ where: { username: DEFAULT_ADMIN.username } });
  return { enabled: row.totpEnabled, hasSecret: row.totpSecret !== null };
}

describe('all four 2FA routes need a session', () => {
  // A route that let an anonymous caller reach it could turn 2FA off for
  // whoever happens to be the only admin.
  it('answers 401 without a token', async () => {
    for (const [method, url] of [
      ['GET', '/api/auth/2fa/status'],
      ['POST', '/api/auth/2fa/setup'],
      ['POST', '/api/auth/2fa/enable'],
      ['POST', '/api/auth/2fa/disable'],
    ] as const) {
      const res = await app.inject({ method, url, payload: { code: '123456' } });
      expect(res.statusCode, `${method} ${url} answered ${res.statusCode}`).toBe(401);
    }
  });
});

describe('enrolling', () => {
  it('hands back a secret and a QR uri that carries it', async () => {
    const res = await post('/api/auth/2fa/setup');
    expect(res.statusCode).toBe(200);
    const { secret, uri } = JSON.parse(res.body);

    expect(secret, 'a base32 secret is what an authenticator app expects').toMatch(/^[A-Z2-7]{16,}$/);
    // The uri IS the enrollment: an app scans it and nothing else. So the
    // parameters it carries have to be the ones the panel then verifies with.
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    const params = new URL(uri.replace('otpauth://', 'https://')).searchParams;
    expect(params.get('secret')).toBe(secret);
    expect(params.get('algorithm')).toBe('SHA1');
    expect(params.get('digits')).toBe('6');
    expect(params.get('period')).toBe('30');
    expect(decodeURIComponent(uri.split('?')[0]!)).toContain(DEFAULT_ADMIN.username);
  });

  // The whole point of the two-step enrollment. Between setup and enable the
  // admin may discover their authenticator never got the secret; until they
  // prove otherwise, nothing changes about how they log in.
  it('does not enforce anything until a code confirms the secret', async () => {
    await setup();

    expect((await enabledInDb()).enabled, 'setup alone must not switch enforcement on').toBe(false);
    const status = await app.inject({ method: 'GET', url: '/api/auth/2fa/status', headers: auth() });
    expect(JSON.parse(status.body)).toEqual({ enabled: false });

    // And the admin can still get in the ordinary way.
    expect((await login()).statusCode).toBe(200);
  });

  it('refuses a wrong code and leaves 2FA off', async () => {
    const secret = await setup();
    // A code from far outside the +/-1 step window - i.e. someone typing what
    // their app showed for a different secret.
    const res = await post('/api/auth/2fa/enable', { code: codeFor(secret, 0) });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('INVALID_TOTP');
    expect(
      (await enabledInDb()).enabled,
      'a mis-scanned secret must not be able to lock the admin out',
    ).toBe(false);
    expect((await login()).statusCode, 'the ordinary login still works').toBe(200);
  });

  it('turns enforcement on once a real code confirms it', async () => {
    const secret = await setup();
    const res = await post('/api/auth/2fa/enable', { code: codeFor(secret) });
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, enabled: true });
    expect((await enabledInDb()).enabled).toBe(true);

    // Observed where it matters: the login path now demands the code.
    const bare = await login();
    expect(bare.statusCode).toBe(401);
    const body = JSON.parse(bare.body);
    expect(body.error).toBe('TOTP_REQUIRED');
    expect(body.requires2fa, 'the SPA shows the code field off this flag').toBe(true);
  });

  it('refuses to enable twice', async () => {
    const secret = await setup();
    await post('/api/auth/2fa/enable', { code: codeFor(secret) });
    const again = await post('/api/auth/2fa/enable', { code: codeFor(secret) });
    expect(again.statusCode).toBe(409);
    expect(JSON.parse(again.body).error).toBe('CONFLICT');
  });

  it('refuses to enable what was never set up', async () => {
    const res = await post('/api/auth/2fa/enable', { code: '123456' });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('NOT_SETUP');
  });

  // Re-running setup rotates the pending secret. The admin who scans twice
  // keeps only the second QR, so the first one must stop working - otherwise a
  // secret they believe they discarded still opens the panel.
  it('rotates the pending secret when setup runs again', async () => {
    const first = await setup();
    const second = await setup();
    expect(second).not.toBe(first);

    const stale = await post('/api/auth/2fa/enable', { code: codeFor(first) });
    expect(stale.statusCode, 'the abandoned secret still enabled 2FA').toBe(401);

    const fresh = await post('/api/auth/2fa/enable', { code: codeFor(second) });
    expect(fresh.statusCode).toBe(200);
  });

  it('rejects anything that is not six digits before it reaches the verifier', async () => {
    await setup();
    for (const code of ['', '12345', '1234567', 'abcdef', '12 34 56']) {
      const res = await post('/api/auth/2fa/enable', { code });
      expect(res.statusCode, `code ${JSON.stringify(code)} was not rejected`).toBe(400);
    }
  });
});

describe('turning it off', () => {
  async function enable(): Promise<string> {
    const secret = await setup();
    const res = await post('/api/auth/2fa/enable', { code: codeFor(secret) });
    expect(res.statusCode, res.body).toBe(200);
    return secret;
  }

  // The guard that gives the second factor its value. A stolen session token is
  // exactly the attacker this stands against: they hold the JWT, they do not
  // hold the phone.
  it('refuses a wrong code and leaves 2FA ON', async () => {
    const secret = await enable();
    const res = await post('/api/auth/2fa/disable', { code: codeFor(secret, 0) });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('INVALID_TOTP');
    const state = await enabledInDb();
    expect(state.enabled, 'a session alone must not be enough to remove the second factor').toBe(true);
    expect(state.hasSecret, 'the secret must survive a refused disable').toBe(true);
    // And enforcement is still live on the login path, not merely in the row.
    expect(JSON.parse((await login()).body).error).toBe('TOTP_REQUIRED');
  });

  it('turns it off with a current code, and forgets the secret', async () => {
    const secret = await enable();
    const res = await post('/api/auth/2fa/disable', { code: codeFor(secret) });
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, enabled: false });

    const state = await enabledInDb();
    expect(state.enabled).toBe(false);
    expect(
      state.hasSecret,
      'the secret must be dropped, not just unenforced: a captured one would otherwise ' +
        'come back live the moment 2FA is switched on again',
    ).toBe(false);

    expect((await login()).statusCode, 'the ordinary login works again').toBe(200);
  });

  it('refuses to disable what is not enabled', async () => {
    const res = await post('/api/auth/2fa/disable', { code: '123456' });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('NOT_SETUP');
  });

  // Set up but never confirmed is not enabled, and disable must say so rather
  // than quietly clearing the pending secret.
  it('refuses to disable a secret that was only pending', async () => {
    const secret = await setup();
    const res = await post('/api/auth/2fa/disable', { code: codeFor(secret) });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('NOT_SETUP');
  });
});

describe('status follows the lifecycle', () => {
  it('reports off, then on, then off again', async () => {
    const read = async () => {
      const res = await app.inject({ method: 'GET', url: '/api/auth/2fa/status', headers: auth() });
      expect(res.statusCode).toBe(200);
      return JSON.parse(res.body).enabled as boolean;
    };

    expect(await read()).toBe(false);
    const secret = await setup();
    expect(await read(), 'pending is not enabled').toBe(false);
    await post('/api/auth/2fa/enable', { code: codeFor(secret) });
    expect(await read()).toBe(true);
    await post('/api/auth/2fa/disable', { code: codeFor(secret) });
    expect(await read()).toBe(false);
  });
});
