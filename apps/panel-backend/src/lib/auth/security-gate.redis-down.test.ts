import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

// Redis is taken away from the gate alone: every command rejects, as the
// application client does with the store unreachable.
const down = vi.hoisted(() => ({
  exists: vi.fn(),
  set: vi.fn(),
}));
vi.mock('../infra/redis.js', () => ({ redis: { exists: down.exists, set: down.set } }));
vi.mock('../notify/telegram-notify.js', () => ({
  notifyTelegramAsync: vi.fn(),
  escapeMarkdown: (s: string) => s,
}));

import { registerSecurityGate } from './security-gate.js';

async function gate() {
  const app = Fastify({ trustProxy: true });
  await registerSecurityGate(app);
  app.get('/api/ping', async () => ({ ok: true }));
  return app;
}

const get = (app: Awaited<ReturnType<typeof gate>>, url: string, ip: string) =>
  app.inject({ method: 'GET', url, headers: { 'x-forwarded-for': ip } });

describe('security gate with the store unavailable', () => {
  beforeEach(() => {
    down.exists.mockReset().mockRejectedValue(new Error('Command timed out'));
    down.set.mockReset().mockRejectedValue(new Error('Command timed out'));
  });

  it('lets a request through when the blacklist cannot be read', async () => {
    const app = await gate();
    const res = await get(app, '/api/ping', '203.0.113.10');
    expect(res.statusCode).toBe(200);
    expect(down.exists).toHaveBeenCalled();
    await app.close();
  });

  it('asks again on the next request: a failed read is not cached as a verdict', async () => {
    const app = await gate();
    await get(app, '/api/ping', '203.0.113.11');
    await get(app, '/api/ping', '203.0.113.11');
    expect(down.exists).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it('still answers the honeypot with its fake 404 when the ban cannot be written, and keeps the ban locally', async () => {
    const app = await gate();
    const ip = '203.0.113.12';
    const trap = await get(app, '/wp-admin', ip);
    expect(trap.statusCode).toBe(404);
    expect(down.set).toHaveBeenCalled();
    // The in-process cache holds the ban the store could not.
    const next = await get(app, '/api/ping', ip);
    expect(next.statusCode).toBe(403);
    await app.close();
  });
});
