// The Prometheus endpoint, and the label rule that keeps subscriber tokens out
// of it.
//
// Nothing tested either. `/metrics` is where an operator's alerting reads the
// panel, and a counter that never moves looks exactly like an attack that never
// happened - the security gate's behaviour is now covered, its REPORTING was
// not. The endpoint is also auth-gated on purpose: unauthenticated it is a free
// inventory of the deployment.
//
// The sharpest rule here is `routeLabel`. Every request is observed into a
// histogram labelled by route, and the raw URL of a subscription poll is
// `/sub/<the subscriber's token>`. Emitting that as a label would both explode
// cardinality and publish working credentials to whoever scrapes the endpoint.

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { prisma } from '../prisma.js';
import { closeRedis } from './redis.js';
import { cleanDatabase } from '../../tests/helpers/db.js';
import { registerAndLogin, DEFAULT_ADMIN } from '../../tests/helpers/auth.js';
import { registry, routeLabel } from './metrics.js';

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
const scrape = () => app.inject({ method: 'GET', url: '/metrics', headers: auth() });

/** The current value of a counter, summed over all its label sets. */
async function counterTotal(name: string): Promise<number> {
  const metric = await registry.getSingleMetricAsString(name);
  let total = 0;
  for (const line of metric.split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue;
    const value = Number(line.trim().split(/\s+/).pop());
    if (Number.isFinite(value)) total += value;
  }
  return total;
}

describe('the endpoint', () => {
  // Unauthenticated it lists every route the panel serves, the process memory,
  // the node and user counts - an inventory of the deployment for free.
  it('needs a session or an API token', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(401);
  });

  it('serves the Prometheus text format', async () => {
    const res = await scrape();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    // The exposition format: a HELP line, a TYPE line, then samples.
    expect(res.body).toMatch(/^# HELP /m);
    expect(res.body).toMatch(/^# TYPE /m);
  });

  // Each of these answers a question somebody put on a dashboard or an alert.
  // A metric that quietly stopped being registered takes its alert with it.
  it('carries every metric the panel declares', async () => {
    const body = (await scrape()).body;
    for (const name of [
      'http_request_duration_seconds',
      'iceslab_login_attempts_total',
      'iceslab_subscription_requests_total',
      'iceslab_inbound_sync_jobs_total',
      'iceslab_honeypot_hits_total',
      'iceslab_geo_block_denials_total',
      'iceslab_nodes',
      'iceslab_users',
    ]) {
      expect(body, `${name} is not exposed`).toContain(name);
    }
    // Plus the default process metrics, which are what "is the panel alive and
    // not leaking memory" is answered from.
    expect(body).toContain('process_resident_memory_bytes');
    expect(body).toContain('nodejs_eventloop_lag_seconds');
  });
});

describe('route labels never carry a subscriber token', () => {
  // The whole reason routeLabel exists. A subscription poll's raw URL IS the
  // credential; a histogram labelled with it publishes working tokens to every
  // scraper and grows a new time series per subscriber.
  it('does not put the token of a real /sub request into the scrape', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: auth(),
      payload: { username: 'metrics_user' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const subToken = JSON.parse(created.body).subscriptionToken as string;
    expect(subToken.length).toBeGreaterThan(20);

    const sub = await app.inject({ method: 'GET', url: `/sub/${subToken}` });
    expect(sub.statusCode).toBe(200);

    const body = (await scrape()).body;
    expect(
      body.includes(subToken),
      'the subscription token appeared in the metrics output',
    ).toBe(false);
    // The pattern is what should be there instead.
    expect(body).toContain('/sub/:token');
  });

  // Unit half: a request that matched no route must not fall back to its raw
  // url, which is exactly the case where the url is attacker-chosen.
  it('answers unknown rather than the raw url', () => {
    expect(routeLabel({})).toBe('unknown');
    expect(routeLabel({ routeOptions: {} })).toBe('unknown');
    expect(routeLabel({ routeOptions: { url: '/api/users/:id' } })).toBe('/api/users/:id');
  });
});

describe('the counters move when the thing they count happens', () => {
  // A counter nobody increments is indistinguishable from a quiet week, and it
  // is the shape an alert is built on.
  it('counts a failed login', async () => {
    const before = await counterTotal('iceslab_login_attempts_total');

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: DEFAULT_ADMIN.username, password: 'wrong-password' },
    });
    expect(res.statusCode).toBe(401);

    const after = await counterTotal('iceslab_login_attempts_total');
    expect(after, 'a refused login has to reach the metric an operator alerts on').toBeGreaterThan(
      before,
    );
  });

  it('counts a subscription poll', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: auth(),
      payload: { username: 'metrics_poller' },
    });
    const subToken = JSON.parse(created.body).subscriptionToken as string;

    const before = await counterTotal('iceslab_subscription_requests_total');
    await app.inject({ method: 'GET', url: `/sub/${subToken}` });
    const after = await counterTotal('iceslab_subscription_requests_total');

    expect(after).toBeGreaterThan(before);
  });

  // The histogram is the one metric fed by EVERY request, so an observation
  // that stopped happening would take the whole latency panel with it.
  it('observes every request into the latency histogram', async () => {
    const before = await counterTotal('http_request_duration_seconds');
    await app.inject({ method: 'GET', url: '/api/auth/status' });
    const after = await counterTotal('http_request_duration_seconds');
    expect(after).toBeGreaterThan(before);
  });
});
