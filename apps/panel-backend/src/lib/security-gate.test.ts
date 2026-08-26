// The tier-1 gate: 195 lines that run before every route handler, and nothing
// in the repository even mentioned them.
//
// There is a reason nothing did, and it is worth stating: `buildApp()` skips
// the gate entirely under NODE_ENV=test, deliberately, so that tests probing
// `/.env` don't blacklist themselves. That choice is defensible and it is also
// why no route test can ever notice a regression here - the layer simply is not
// mounted. So these tests register the hook on a bare Fastify instance and
// drive it directly.
//
// What the gate decides:
//   * whether a request is answered 403 before it reaches any handler;
//   * whether the source IP is put on a one-hour blacklist;
//   * whether the admin surface is refused by country.
//
// Each of those has an expensive failure. A blacklist that fires on the wrong
// address locks a real customer or a real operator out for an hour. A honeypot
// that answers differently to a spoofing scanner than to an honest one tells
// the scanner which addresses are trusted. A geo-block that fails OPEN is not a
// control at all.

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { redis, closeRedis } from './redis.js';
import { registerSecurityGate } from './security-gate.js';
import { isPublicRoutableIp } from './ip.js';
import { config } from '../config.js';

/** IPs are unique per case: the gate keeps an in-process blacklist cache
 *  (positive for the full TTL, negative for 5s), so reusing an address would
 *  make one test read the previous test's answer. */
let octet = 0;
function freshIp(): string {
  octet += 1;
  return `203.0.113.${octet}`;
}

const touchedIps: string[] = [];
async function buildGate(): Promise<FastifyInstance> {
  // trustProxy so `request.ip` comes from x-forwarded-for, which is how the
  // gate sees a client in production (behind Caddy/Cloudflare) and the only
  // way a test can pose as one.
  const app = Fastify({ trustProxy: true });
  await registerSecurityGate(app);
  app.get('/*', async () => ({ reached: true }));
  app.post('/*', async () => ({ reached: true }));
  await app.ready();
  return app;
}

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildGate();
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

function get(url: string, ip: string, headers: Record<string, string> = {}) {
  touchedIps.push(ip);
  return app.inject({ method: 'GET', url, headers: { 'x-forwarded-for': ip, ...headers } });
}

describe('the honeypot', () => {
  // The fake has to look like an ordinary miss. A 403 here is a "this server is
  // hardened" signal and tells the scanner to move on to a target that gives
  // less away.
  it('answers a scanner with a plausible 404, not a refusal', async () => {
    const res = await get('/.env', freshIp());
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Not Found');
    expect(res.body).not.toContain('FORBIDDEN');
  });

  it('traps the paths scanners actually probe, however they are spelled', async () => {
    for (const path of [
      '/.env',
      '/.env?x=1', // query string stripped before matching
      '/.git/config',
      '/.git/HEAD', // prefix match
      '/.aws/credentials',
      '/wp-config.php',
      '/xmlrpc.php',
      '/phpinfo.php',
      '/server-status',
      '/wp-admin/setup-config.php',
      '/wp-login.php',
      '/wordpress/wp-admin',
      '/phpmyadmin/index.php',
      '/Wp-Admin/', // scanners probe with mixed case
      '/.GIT/config',
      '/.ENV',
    ]) {
      const res = await get(path, freshIp());
      expect(res.statusCode, `${path} was not trapped`).toBe(404);
      expect(res.body, `${path} reached a handler`).not.toContain('reached');
    }
  });

  it('lets ordinary paths through untouched', async () => {
    for (const path of ['/api/nodes', '/sub/token123', '/health', '/environment', '/wp']) {
      const res = await get(path, freshIp());
      expect(res.statusCode, `${path} was trapped`).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ reached: true });
    }
  });

  it('blacklists the prober, and the next request from that address is refused', async () => {
    const ip = freshIp();
    await get('/wp-admin/', ip);

    expect(await redis.exists(`sec:blacklist:${ip}`)).toBe(1);
    const ttl = await redis.ttl(`sec:blacklist:${ip}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(config.HONEYPOT_BLACKLIST_TTL_SEC);

    // Not just the trap path: the address is now refused everywhere, before
    // any handler runs.
    const after = await get('/api/nodes', ip);
    expect(after.statusCode).toBe(403);
    expect(JSON.parse(after.body)).toEqual({ error: 'FORBIDDEN' });
  });

  // The guard that keeps this from being a weapon. `request.ip` is only as
  // honest as the proxy-hop count; a client that can forge X-Forwarded-For
  // would otherwise blacklist a private range - or a victim - by probing
  // `/.env` once on their behalf.
  it('does not blacklist a source that is not publicly routable', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.16.4.5', '169.254.7.7',
      '100.64.3.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
      const res = await get('/.env', ip);
      // Same answer as for anyone else: a spoofing scanner must not be able to
      // tell trusted addresses apart by the response.
      expect(res.statusCode, `${ip} got a different answer`).toBe(404);
      expect(res.body).toContain('Not Found');
      expect(
        await redis.exists(`sec:blacklist:${ip}`),
        `${ip} was blacklisted - a forged header could lock out whoever is really there`,
      ).toBe(0);
    }
  });
});

describe('isPublicRoutableIp', () => {
  // The honeypot's blast radius is decided entirely by this function.
  it('refuses everything that is not a public unicast address', () => {
    for (const ip of [
      '', 'not-an-ip', '10.0.0.1', '127.0.0.1', '127.255.255.254', '0.0.0.0',
      '169.254.1.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '100.64.0.1', '100.127.255.255',
      '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1',
      // IPv4-mapped IPv6: the bypass the v6 branch alone would miss.
      '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::FFFF:192.168.1.1',
    ]) {
      expect(isPublicRoutableIp(ip), `${ip} was treated as routable`).toBe(false);
    }
  });

  it('accepts real public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.113.7', '172.32.0.1', '100.63.255.255',
      '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) {
      expect(isPublicRoutableIp(ip), `${ip} was treated as non-routable`).toBe(true);
    }
  });
});

describe('the blacklist', () => {
  it('refuses an address that was blacklisted elsewhere', async () => {
    const ip = freshIp();
    touchedIps.push(ip);
    // Another process (or another panel instance) put it there.
    await redis.set(`sec:blacklist:${ip}`, '1', 'EX', 60);

    const res = await get('/api/nodes', ip);
    expect(res.statusCode).toBe(403);
  });

  // Order matters and the source says why: blacklist BEFORE honeypot, so a
  // scanner cannot dodge the refusal by burning a fresh trap path.
  it('refuses a blacklisted address even on a honeypot path', async () => {
    const ip = freshIp();
    touchedIps.push(ip);
    await redis.set(`sec:blacklist:${ip}`, '1', 'EX', 60);

    const res = await get('/.env', ip);
    expect(res.statusCode, 'the blacklist must win over the trap').toBe(403);
  });

  it('leaves an address nobody flagged alone', async () => {
    const res = await get('/api/nodes', freshIp());
    expect(res.statusCode).toBe(200);
  });
});

describe('the geo-block is off by default', () => {
  // ADMIN_ALLOWED_COUNTRIES is empty in this environment, which is the shipped
  // default. The whole layer must then be inert - including for a request with
  // no country header at all, which is what every local deployment sends.
  it('does not ask for a country when no allowlist is configured', async () => {
    expect(config.ADMIN_ALLOWED_COUNTRIES).toHaveLength(0);
    const res = await get('/api/nodes', freshIp());
    expect(res.statusCode).toBe(200);
  });
});
