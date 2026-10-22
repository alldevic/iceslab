import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { trustProxyHops } from './ip.js';

/**
 * TRUST_PROXY_HOPS as Fastify's trustProxy, asked of Fastify itself: which
 * address `request.ip` becomes for a request that came through the proxies.
 *
 * Since 5.12.2 a NUMBER handed to Fastify means "trust nobody" at runtime, so
 * `request.ip` would be the proxy for everyone. The function keeps the
 * meaning the setting always had. Runs against whichever Fastify the
 * lockfile pins, which is the point: a later release that changes the rule
 * again fails here.
 */
async function ipFor(hops: number, socket: string, forwardedFor?: string): Promise<string> {
  const app = Fastify({ trustProxy: trustProxyHops(hops) });
  app.get('/', async (req) => ({ ip: req.ip }));
  const res = await app.inject({
    method: 'GET',
    url: '/',
    remoteAddress: socket,
    ...(forwardedFor ? { headers: { 'x-forwarded-for': forwardedFor } } : {}),
  });
  await app.close();
  return JSON.parse(res.body).ip as string;
}

describe('trustProxyHops', () => {
  it('the default deploy, Cloudflare then Caddy (2): the client the edge saw', async () => {
    // client -> Cloudflare (adds the client) -> Caddy (adds Cloudflare) -> panel
    expect(await ipFor(2, '172.18.0.5', '203.0.113.7, 198.51.100.20')).toBe('203.0.113.7');
  });

  it('one proxy (1): the address that proxy saw, not what the client wrote before it', async () => {
    // A client claims 6.6.6.6 itself; Caddy appends the real one.
    expect(await ipFor(1, '172.18.0.5', '6.6.6.6, 203.0.113.7')).toBe('203.0.113.7');
  });

  it('no proxy (0): the socket, whatever the header says', async () => {
    expect(await ipFor(0, '203.0.113.7', '6.6.6.6')).toBe('203.0.113.7');
  });

  it('is never the proxy itself when the proxy sent the header (the 5.12.2 trap)', async () => {
    expect(await ipFor(2, '172.18.0.5', '203.0.113.7, 198.51.100.20')).not.toBe('172.18.0.5');
  });
});
