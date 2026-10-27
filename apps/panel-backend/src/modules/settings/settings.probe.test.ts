import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { config, ConfigSchema, RESERVED_PATH_PREFIXES } from '../../config.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { readCapped, subscriptionProbeAnswered } from './settings.probe.js';

/**
 * A-137: the delivery probe counted any answer under 500 as the subscription,
 * so the SPA's index.html (a prefix the frontend's nginx did not route) was
 * green. Only the route's own answer for a token nobody owns counts now. And
 * the prefixes the panel's nginx already routes are refused at startup, the
 * same list as the frontend's entrypoint script.
 */

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('subscriptionProbeAnswered', () => {
  it('takes the real route answer for a token nobody owns, as the app gives it', async () => {
    // The shape from the app itself, so the verdict cannot drift from the route.
    const res = await app.inject({ method: 'GET', url: `${config.SUBSCRIPTION_PATH_PREFIX}/probe-0f6c2a4e-aaaa-4bbb-8ccc-123456789abc` });
    expect(subscriptionProbeAnswered(res.statusCode, String(res.headers['content-type'] ?? ''), res.body)).toBe(true);
  });

  it('refuses the SPA, a proxy page, a redirect and a JSON 404 of something else', () => {
    expect(subscriptionProbeAnswered(200, 'text/html', '<!doctype html><html>')).toBe(false);
    expect(subscriptionProbeAnswered(404, 'text/html', '<h1>404 Not Found</h1>')).toBe(false);
    expect(subscriptionProbeAnswered(302, '', '')).toBe(false);
    expect(subscriptionProbeAnswered(404, 'application/json', '{"error":"NOT_FOUND","message":"Route GET:/x not found"}')).toBe(false);
    expect(subscriptionProbeAnswered(404, 'application/json', 'not json')).toBe(false);
  });
});

describe('readCapped', () => {
  it('reads at most the cap and drains the rest', async () => {
    let dumped = false;
    const stream = Readable.from([Buffer.from('a'.repeat(3000)), Buffer.from('b'.repeat(3000))]) as Readable & {
      dump(): Promise<void>;
    };
    stream.dump = async () => {
      dumped = true;
    };
    const text = await readCapped(stream, 4096);
    expect(text.length).toBe(4096);
    expect(dumped).toBe(true);
  });
});

describe('SUBSCRIPTION_PATH_PREFIX', () => {
  const parse = (v: string) => ConfigSchema.shape.SUBSCRIPTION_PATH_PREFIX.safeParse(v);

  it('refuses the panel routes on the frontend nginx, the entrypoint script list', () => {
    expect(RESERVED_PATH_PREFIXES).toEqual(['/api', '/admin', '/health', '/assets']);
    for (const p of RESERVED_PATH_PREFIXES) {
      const r = parse(p);
      expect(r.success, p).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain('Taken by the panel itself');
    }
  });

  it('takes an ordinary prefix', () => {
    for (const p of ['/sub', '/s2', '/get', '/apix']) expect(parse(p).success, p).toBe(true);
  });
});
