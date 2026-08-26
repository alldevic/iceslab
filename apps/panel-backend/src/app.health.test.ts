// The endpoint the orchestration reads, and nothing read it.
//
// `/health` pings Postgres and Redis and reports `degraded` when either is
// gone. Measured 2026-08-26 with the pings stubbed: it answered
// `200 {"status":"degraded","db":"down"}` - a 200. The compose healthcheck in
// docker-compose.prod.yml and .ghcr.yml runs
// `fetch(...).then(r => process.exit(r.ok ? 0 : 1))`, and `r.ok` is true for a
// 200, so a backend whose database was gone stayed `healthy` forever:
// `depends_on: service_healthy` let the frontend start against it, and anything
// watching container health saw green. The endpoint was reporting `degraded` to
// a reader that did not exist.
//
// That the intent was otherwise is written down twice: the healthcheck's own
// comment says "/health pings Postgres+Redis and returns {"status":"ok"}", and
// the installer's wait loop greps the body for `"status":"ok"` rather than
// trusting the code.
//
// Nothing tested any of it - the only mentions of `/health` in the suite are as
// a public path in the security gate.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// vi.hoisted: the mock factories are lifted above every import, so a plain
// `let` would still be in its temporal dead zone when they run.
const { pings } = vi.hoisted(() => ({ pings: { db: true, redis: true } }));

vi.mock('./prisma.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pingDatabase: async () => pings.db,
}));
vi.mock('./lib/redis.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pingRedis: async () => pings.redis,
}));

const { buildApp } = await import('./app.js');

let app: FastifyInstance;

beforeEach(async () => {
  pings.db = true;
  pings.redis = true;
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

const health = () => app.inject({ method: 'GET', url: '/health' });

describe('/health', () => {
  it('answers 200 and names both dependencies when they are up', async () => {
    const res = await health();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok', db: 'ok', redis: 'ok' });
  });

  // The whole point. A 200 here is a container that never goes unhealthy, and
  // an operator who finds out from their customers instead of their monitoring.
  it('answers 503 when the database is gone', async () => {
    pings.db = false;
    const res = await health();
    expect(
      res.statusCode,
      'a 200 here makes the compose healthcheck pass with a dead database',
    ).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ status: 'degraded', db: 'down', redis: 'ok' });
  });

  // Redis holds the job queues, the blacklist and the caches. A panel that
  // cannot reach it is not serving, whatever Postgres says.
  it('answers 503 when redis is gone', async () => {
    pings.redis = false;
    const res = await health();
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ status: 'degraded', db: 'ok', redis: 'down' });
  });

  it('names both when both are gone', async () => {
    pings.db = false;
    pings.redis = false;
    const res = await health();
    expect(res.statusCode).toBe(503);
    expect(
      JSON.parse(res.body),
      'which dependency failed is the first thing an operator needs',
    ).toEqual({ status: 'degraded', db: 'down', redis: 'down' });
  });

  // The installer waits for the stack by grepping this body for
  // `"status":"ok"` (install-iceslab.sh). Changing the field or its spelling
  // would make a healthy install look like a 60-second timeout.
  it('keeps the exact string the installer waits for', async () => {
    const res = await health();
    expect(res.body).toContain('"status":"ok"');
  });

  // Public by design: the orchestration probes it before anyone has a session,
  // and the security gate exempts it from the admin geo-block for the same
  // reason. An accidental requireAuth would make every container unhealthy.
  it('needs no session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { authorization: 'Bearer not-a-token' },
    });
    expect(res.statusCode).toBe(200);
  });

  // A dependency that recovers has to be reported as recovered, or the
  // container stays unhealthy until someone restarts it by hand.
  it('goes back to 200 once the dependency returns', async () => {
    pings.db = false;
    expect((await health()).statusCode).toBe(503);
    pings.db = true;
    const res = await health();
    expect(res.statusCode, 'the check must not latch').toBe(200);
    expect(JSON.parse(res.body).status).toBe('ok');
  });
});
