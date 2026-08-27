import { Redis } from 'ioredis';
import { config } from '../config.js';

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
 * honeypot blacklist, the rate-limit store, the agent-start keys.
 *
 * Split from the BullMQ connection on 2026-08-27, because the options BullMQ
 * requires are the wrong ones everywhere else. With retries unbounded and the
 * offline queue on, a command issued while Redis is unreachable is QUEUED, not
 * rejected: it never settles, and every `await redis.get(...).catch(...)` in
 * this repository reads as a graceful degrade that cannot happen.
 *
 * What that cost, measured against the built image on 2026-08-27: with Redis
 * stopped, `GET /health` returned nothing at all after sixty seconds — the
 * request never left the onRequest hooks, because the rate limiter and the
 * security gate both touch Redis before any route runs. Stopping Postgres, by
 * contrast, gave a 503 in three seconds. The panel did not degrade when Redis
 * went away; it stopped answering, with no error logged and no timeout.
 *
 * Fail fast here, and let each caller decide what to do about it. The callers
 * that already wrote `.catch(() => null)` get the behaviour they described.
 */
export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 1,
  enableReadyCheck: false,
  // The offline queue STAYS ON, and `commandTimeout` is what makes that safe.
  // ioredis arms the command's timer in `sendCommand`, above the writable
  // check, so a queued command is bounded exactly like a sent one. Turning the
  // queue off instead rejects everything issued in the second between `new
  // Redis()` and 'ready', which is a different bug in the same family: the app
  // waits for readiness before it serves, but nothing else does.
  commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
  lazyConnect: false,
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
 * Wait for the connection to be usable, for the one caller that must not
 * proceed without it.
 *
 * The startup gate in index.ts asks whether Redis is up and exits 1 if not, and
 * a plain ping used to answer that question by being queued until the socket
 * came up — an accident of the options above. Without the queue, sampling
 * `status` at boot races the first connect. So the wait is explicit.
 */
export async function waitForRedis(timeoutMs = 10_000): Promise<boolean> {
  if (redis.status === 'ready') return true;
  return new Promise<boolean>((resolve) => {
    const done = (result: boolean) => {
      clearTimeout(timer);
      redis.off('ready', onReady);
      resolve(result);
    };
    const onReady = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    redis.once('ready', onReady);
  });
}

/**
 * How long /health waits for a PONG before calling Redis down.
 *
 * Short on purpose: this is a liveness answer, and the caller that matters
 * most is the installer's launch step, which asks in a loop.
 */
export const REDIS_PING_TIMEOUT_MS = 2_000;

/**
 * The ping, with the client injectable so the down path can be tested without
 * taking the lab's Redis away from everything else.
 *
 * `maxRetriesPerRequest: null` above is required by BullMQ, and it is also why
 * the plain `try/catch` this replaces could not do what it read as doing: with
 * retries unbounded, a command issued while the connection is down is QUEUED,
 * not rejected. `redis.ping()` then never settles, the catch never runs, and
 * /health does not answer 503 — it does not answer at all.
 *
 * Measured 2026-08-27 against the built image: Postgres stopped gave
 * `{"status":"degraded"}` with 503 in 3 seconds; Redis stopped gave no reply
 * after 60. The docker healthcheck survived it only because docker kills its
 * own probe at 3s; the installer's launch loop has no such timeout and hung.
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