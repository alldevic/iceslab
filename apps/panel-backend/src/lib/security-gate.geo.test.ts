// The geo-block, switched ON.
//
// It lives in its own file because the allowlist is read from the environment
// when `config.ts` is first imported, and the sibling file covers the shipped
// default (empty allowlist, layer inert). Here the panel is configured the way
// an operator would configure it who wants the admin surface reachable from two
// countries and nowhere else.
//
// The property that matters is that it fails CLOSED. A missing header is the
// normal state of a deployment that lost its Cloudflare edge, or of an attacker
// coming straight to the origin - and answering those with "well, no country,
// let them in" would leave the control switched on and doing nothing.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// Set before anything pulls in config.ts. Static imports hoist, so every module
// that reads config is imported dynamically below.
vi.stubEnv('ADMIN_ALLOWED_COUNTRIES', 'RU,DE');

const { registerSecurityGate } = await import('./security-gate.js');
const { config } = await import('../config.js');
const { redis, closeRedis } = await import('./redis.js');

let app: FastifyInstance;
let octet = 0;
const touchedIps: string[] = [];

function freshIp(): string {
  octet += 1;
  const ip = `198.51.100.${octet}`;
  touchedIps.push(ip);
  return ip;
}

beforeEach(async () => {
  app = Fastify({ trustProxy: true });
  await registerSecurityGate(app);
  app.get('/*', async () => ({ reached: true }));
  await app.ready();
});

afterEach(async () => {
  await app.close();
  for (const ip of touchedIps.splice(0)) {
    await redis.del(`sec:blacklist:${ip}`).catch(() => null);
  }
});

afterAll(async () => {
  await closeRedis();
});

function get(url: string, headers: Record<string, string> = {}) {
  return app.inject({ method: 'GET', url, headers: { 'x-forwarded-for': freshIp(), ...headers } });
}

it('is actually configured for this file', () => {
  expect(config.ADMIN_ALLOWED_COUNTRIES).toEqual(['RU', 'DE']);
});

describe('the admin surface is gated by country', () => {
  it('lets every allowed country through', async () => {
    for (const country of ['RU', 'DE']) {
      const res = await get('/api/nodes', { 'cf-ipcountry': country });
      expect(res.statusCode, `${country} was refused`).toBe(200);
    }
  });

  it('refuses a country that is not on the list', async () => {
    const res = await get('/api/nodes', { 'cf-ipcountry': 'US' });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'GEO_BLOCKED' });
  });

  // The whole point of the control. An origin reachable without the edge in
  // front of it sends no country header at all, and so does anyone who found
  // the backend directly.
  it('fails closed when there is no country header', async () => {
    const res = await get('/api/nodes');
    expect(
      res.statusCode,
      'no header must mean refused; letting it through leaves the control on and inert',
    ).toBe(403);
  });

  // Measured while proving these: deleting the `/^[A-Z]{2}$/` shape check
  // changes nothing, because `config.ts` already filters the allowlist down to
  // two-letter codes, so a malformed header simply is not a member. The shape
  // test below is kept - it is the statement of intent, and it reddens the
  // fail-open mutation - but the guard doing the work is the membership check.
  it('refuses a header that is not on the list, whatever shape it has', async () => {
    for (const bad of ['', 'R', 'RUS', 'XX1', '12', 'RU,DE', 'unknown']) {
      const res = await get('/api/nodes', { 'cf-ipcountry': bad });
      expect(res.statusCode, `${JSON.stringify(bad)} was accepted`).toBe(403);
    }
  });

  it('reads the code case-insensitively', async () => {
    const res = await get('/api/nodes', { 'cf-ipcountry': 'ru' });
    expect(res.statusCode).toBe(200);
  });

  // The fallback for deployments whose edge is not Cloudflare.
  it('accepts the x-country-code fallback', async () => {
    expect((await get('/api/nodes', { 'x-country-code': 'DE' })).statusCode).toBe(200);
    expect((await get('/api/nodes', { 'x-country-code': 'US' })).statusCode).toBe(403);
  });

  it('prefers cf-ipcountry when both headers are present', async () => {
    const res = await get('/api/nodes', { 'cf-ipcountry': 'US', 'x-country-code': 'RU' });
    expect(res.statusCode, 'the edge-set header must win over the one below it').toBe(403);
  });
});

describe('the surfaces that must never be geo-blocked', () => {
  // Subscribers and node agents are worldwide by definition; a geo-block that
  // reached them would black out paying customers and orphan the fleet.
  it('serves subscription, agent, discovery and health paths from anywhere', async () => {
    for (const path of [
      '/sub/sometoken',
      '/api/internal/nodes/me/status',
      '/api/internal/bootstrap/bs_x',
      '/api/auth/status',
      '/health',
      '/healthz',
    ]) {
      const res = await get(path, { 'cf-ipcountry': 'US' });
      expect(res.statusCode, `${path} was geo-blocked`).toBe(200);
      const bare = await get(path);
      expect(bare.statusCode, `${path} was geo-blocked with no country header`).toBe(200);
    }
  });

  // The SPA shell and its assets come from the frontend container and never
  // reach this backend, so only /api/* is gated.
  it('does not gate anything outside /api/', async () => {
    for (const path of ['/', '/assets/app.js', '/metrics']) {
      expect((await get(path)).statusCode, `${path} was gated`).toBe(200);
    }
  });

  // A near-miss on a public prefix must NOT inherit the exemption: the
  // discovery route is exact-match for a reason.
  it('gates a path that merely looks public', async () => {
    expect((await get('/api/auth/statuses', { 'cf-ipcountry': 'US' })).statusCode).toBe(403);
    expect((await get('/api/auth/login', { 'cf-ipcountry': 'US' })).statusCode).toBe(403);
  });
});

describe('the layers keep their order', () => {
  // Honeypot before geo: the source says why - a probe from a denied country is
  // still signal, and answering it 403 would throw that signal away.
  it('traps a scanner from a denied country instead of geo-blocking it', async () => {
    const res = await get('/.env', { 'cf-ipcountry': 'US' });
    expect(res.statusCode, 'the trap must run before the country check').toBe(404);
    expect(res.body).toContain('Not Found');
  });

  it('refuses a blacklisted address even when its country is allowed', async () => {
    const ip = `198.51.100.${(octet += 1)}`;
    touchedIps.push(ip);
    await redis.set(`sec:blacklist:${ip}`, '1', 'EX', 60);

    const res = await app.inject({
      method: 'GET',
      url: '/api/nodes',
      headers: { 'x-forwarded-for': ip, 'cf-ipcountry': 'RU' },
    });
    expect(res.statusCode).toBe(403);
    expect(
      JSON.parse(res.body),
      'the blacklist answer, not the geo one: the layers must not swap places',
    ).toEqual({ error: 'FORBIDDEN' });
  });
});
