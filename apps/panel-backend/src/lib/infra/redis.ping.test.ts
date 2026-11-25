import { describe, it, expect } from 'vitest';
import { Redis } from 'ioredis';
import { EventEmitter } from 'node:events';

import { pingClient, pingRedis, REDIS_PING_TIMEOUT_MS, REDIS_COMMAND_TIMEOUT_MS, waitForRedis, redis, queueRedis } from './redis.js';

/**
 * The Redis half of /health could not report a failure.
 *
 * One client served BullMQ and the application, built with the options BullMQ
 * requires (`maxRetriesPerRequest: null`), so a command issued on a down
 * connection was queued rather than rejected and `await redis.ping()` never
 * settled: /health answered nothing at all instead of a 503.
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

describe('the two clients', () => {
  it('keeps BullMQ options on the queue client and bounds the application client', () => {
    expect(queueRedis.options.maxRetriesPerRequest).toBeNull();
    expect(queueRedis.options.commandTimeout).toBeUndefined();
    expect(redis.options.maxRetriesPerRequest).toBe(1);
    expect(redis.options.commandTimeout).toBe(REDIS_COMMAND_TIMEOUT_MS);
  });

  it('stops queueing commands once the application client has been ready', async () => {
    expect(await pingRedis()).toBe(true);
    expect(redis.options.enableOfflineQueue).toBe(false);
  });
});

describe('an application client with nothing to connect to', () => {
  // The options are the ones lib/infra/redis.ts gives the real client; only the
  // address differs (a port nothing listens on).
  function deadClient(): Redis {
    const c = new Redis('redis://127.0.0.1:1', {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
      retryStrategy: () => 100,
    });
    c.on('error', () => {});
    return c;
  }

  it('answers "no" to the ping in bounded time', async () => {
    const c = deadClient();
    try {
      const started = Date.now();
      expect(await pingClient(c)).toBe(false);
      expect(Date.now() - started).toBeLessThan(REDIS_PING_TIMEOUT_MS + 1_000);
    } finally {
      c.disconnect();
    }
  });

  it('rejects a command within the command timeout instead of waiting for ever', async () => {
    const c = deadClient();
    try {
      const started = Date.now();
      await expect(c.get('k')).rejects.toBeDefined();
      expect(Date.now() - started).toBeLessThan(REDIS_COMMAND_TIMEOUT_MS + 1_500);
    } finally {
      c.disconnect();
    }
  });

  it('does not pile up commands once the offline queue is off', async () => {
    const c = deadClient();
    c.options.enableOfflineQueue = false;
    try {
      const started = Date.now();
      const results = await Promise.allSettled(Array.from({ length: 50 }, () => c.get('k')));
      expect(results.every((r) => r.status === 'rejected')).toBe(true);
      expect(Date.now() - started).toBeLessThan(500);
      expect(c.commandQueue.length).toBe(0);
      expect(c.offlineQueue.length).toBe(0);
    } finally {
      c.disconnect();
    }
  });
});

describe('waitForRedis', () => {
  const fake = (status: string) => Object.assign(new EventEmitter(), { status }) as never;

  it('answers at once for a client that is already ready', async () => {
    expect(await waitForRedis(50, fake('ready'))).toBe(true);
  });

  it('succeeds when the server comes up inside the window', async () => {
    const c = fake('connecting') as unknown as EventEmitter;
    setTimeout(() => c.emit('ready'), 50);
    const started = Date.now();
    expect(await waitForRedis(2_000, c as never)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(c.listenerCount('ready')).toBe(0);
  });

  it('gives up after the deadline when the server never comes up', async () => {
    const c = fake('connecting') as unknown as EventEmitter;
    const started = Date.now();
    expect(await waitForRedis(100, c as never)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(c.listenerCount('ready')).toBe(0);
  });
});
