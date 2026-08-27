import { describe, it, expect } from 'vitest';

import { pingClient, pingRedis, REDIS_PING_TIMEOUT_MS } from './redis.js';

/**
 * The Redis half of /health could not report a failure.
 *
 * The client is built with `maxRetriesPerRequest: null` because BullMQ requires
 * it, and that turns a command issued on a down connection into one that is
 * queued rather than rejected. `await redis.ping()` never settled, so the
 * `catch` that read as "Redis is down -> false" never ran and /health answered
 * nothing at all. Measured against the built image: Postgres stopped gave a 503
 * in three seconds, Redis stopped gave no reply in sixty.
 *
 * These cases are about the two bounds, and each is written so that removing
 * the bound it covers reddens it.
 */
describe('pingClient', () => {
  it('refuses a client that is not connected without issuing a command', async () => {
    let called = false;
    const client = {
      status: 'end',
      ping: async () => {
        called = true;
        return 'PONG';
      },
    };

    expect(await pingClient(client as never)).toBe(false);
    // The point of the status gate: a disconnected client is answered from what
    // ioredis already knows, not by putting one more command on a queue that
    // nothing is draining.
    expect(called).toBe(false);
  });

  it('gives up on a ready client that never answers, rather than waiting forever', async () => {
    const client = {
      status: 'ready',
      // The exact shape of the defect: a promise that neither resolves nor
      // rejects, which is what a queued command on a down connection is.
      ping: () => new Promise<string>(() => {}),
    };

    const started = Date.now();
    const result = await pingClient(client as never, 50);
    const waited = Date.now() - started;

    expect(result).toBe(false);
    // Bounded, and bounded by the argument rather than by luck. Without the
    // race this call does not return and the test times out instead.
    expect(waited).toBeLessThan(2_000);
  });

  it('reports a live client as up', async () => {
    const client = { status: 'ready', ping: async () => 'PONG' };
    expect(await pingClient(client as never)).toBe(true);
  });

  it('treats a reply that is not PONG as down', async () => {
    const client = { status: 'ready', ping: async () => 'something else' };
    expect(await pingClient(client as never)).toBe(false);
  });

  it('answers about the real client too, which is the one /health asks', async () => {
    // The control for the four above: they all run against objects this file
    // made up. This one is the singleton the route uses, against the Redis the
    // suite is pointed at.
    expect(await pingRedis()).toBe(true);
  });

  it('has a timeout short enough for a health probe', () => {
    expect(REDIS_PING_TIMEOUT_MS).toBeGreaterThan(0);
    expect(REDIS_PING_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });
});
