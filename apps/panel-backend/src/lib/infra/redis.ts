import { Redis } from 'ioredis';
import { config } from '../../config.js';

/**
 * How long an application command waits before it is called failed.
 *
 * Covers the case `enableOfflineQueue: false` cannot: a socket that is open,
 * so ioredis still calls the client 'ready', with nothing answering on it.
 */
export const REDIS_COMMAND_TIMEOUT_MS = 2_000;

/**
 * BullMQ's connection, and only BullMQ's.
 *
 * `maxRetriesPerRequest: null` and `enableReadyCheck: false` are REQUIRED by
 * BullMQ, and its workers duplicate this connection for their blocking reads,
 * so no command timeout may be set on it either.
 */
export const queueRedis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: false,
});

/**
 * Everything that is not a queue: the cache, the login-lockout counters, the
 * session revocation keys, the honeypot blacklist, the rate-limit store, the
 * agent-start keys.
 *
 * Split from the BullMQ connection because the options BullMQ requires are the
 * wrong ones everywhere else. With retries unbounded and the offline queue on,
 * a command issued while Redis is unreachable is QUEUED, not rejected: it never
 * settles, every `await redis.get(...).catch(...)` reads as a graceful degrade
 * that cannot happen, and a request that touches Redis in an onRequest hook (the
 * rate limiter, the security gate) hangs forever, /health included.
 *
 * Fail fast here, and let each caller decide what to do about it.
 */
export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 1,
  enableReadyCheck: false,
  // On for now; turned off below the moment this client has been ready once.
  enableOfflineQueue: true,
  commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
  lazyConnect: false,
});

/**
 * The offline queue is a boot-time convenience, not a runtime one.
 *
 * Between `new Redis()` and the first 'ready' the socket is not writable yet,
 * and with the queue off every command issued in that window is rejected, so
 * the queue absorbs that second.
 *
 * After that it only costs. `commandTimeout` bounds each command
 * INDEPENDENTLY, so a route that touches Redis N times pays N timeouts in a
 * row while Redis is down (a subscription fetch took 13.5 s in the fork's
 * measurement). Once the client has connected once, "not writable" means Redis
 * is gone, and the honest answer is immediate. ioredis reads
 * `options.enableOfflineQueue` in `sendCommand` on every call, so flipping it
 * here takes effect at once and needs no wrapper around the call sites.
 */
redis.once('ready', () => {
  redis.options.enableOfflineQueue = false;
});

// An ioredis client emits 'error' on every failed reconnect attempt, and an
// EventEmitter 'error' with no listener is a thrown exception. Both clients get
// one, so a Redis outage is logged rather than being either invisible or fatal.
for (const [name, client] of [
  ['redis', redis],
  ['redis(queues)', queueRedis],
] as const) {
  client.on('error', (err: Error) => {
    console.error(`[${name}] ${err.message}`);
  });
}

/**
 * Wait for the application client to be usable, for the one caller that must
 * not proceed without it (the startup gate in index.ts). Without the offline
 * queue, sampling `status` at boot races the first connect, so the wait is
 * explicit.
 */
export async function waitForRedis(
  timeoutMs = 10_000,
  client: Pick<Redis, 'status' | 'once' | 'off'> = redis,
): Promise<boolean> {
  if (client.status === 'ready') return true;
  return new Promise<boolean>((resolve) => {
    const done = (result: boolean) => {
      clearTimeout(timer);
      client.off('ready', onReady);
      resolve(result);
    };
    const onReady = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    client.once('ready', onReady);
  });
}

/**
 * How long /health waits for a PONG before calling Redis down. Short on
 * purpose: this is a liveness answer, and the installer's launch step asks in
 * a loop.
 */
export const REDIS_PING_TIMEOUT_MS = 2_000;

/**
 * The ping, with the client injectable so the down path can be tested without
 * taking the shared Redis away from everything else.
 *
 * Two bounds, because they answer different questions. `status` is what ioredis
 * already knows about the socket, so a disconnected client costs nothing to
 * refuse; the race covers a socket that is open and not answering, which
 * `status` still calls 'ready'.
 */
export async function pingClient(
  client: Pick<Redis, 'status' | 'ping'>,
  timeoutMs: number = REDIS_PING_TIMEOUT_MS,
): Promise<boolean> {
  if (client.status !== 'ready') return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      client.ping(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('redis ping timed out')), timeoutMs);
      }),
    ]);
    return reply === 'PONG';
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function pingRedis(): Promise<boolean> {
  return pingClient(redis);
}

export async function closeRedis(): Promise<void> {
  await Promise.all([redis.quit(), queueRedis.quit()]);
}
