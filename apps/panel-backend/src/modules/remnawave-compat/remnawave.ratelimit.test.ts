import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/**
 * The panel rate-limits every route to 100/min per IP globally. The shop is a
 * server-to-server client that bursts: a fleet sync walks every user, and an
 * activation fires several writes in a row - all from ONE address, the shop
 * container's. Under the global limit that traffic takes a 429 partway
 * through, and a 429 in the middle of an activation is a payment the customer
 * made and did not get.
 *
 * The facade therefore sets its own 1200/min on every route it registers, which
 * is what Remnawave itself allows. This file exists because that is a claim
 * about how @fastify/rate-limit resolves route config against a `global: true`
 * registration - readable in two files, provable in neither, and silent when
 * wrong. The native control below is what makes the facade assertion mean
 * something: it shows the global limit is real and being measured.
 */

let app: FastifyInstance;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
const PREFIX = 'rw';
const token = `icp_rl_${Date.now()}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

beforeAll(async () => {
  process.env['REMNAWAVE_COMPAT_ENABLED'] = 'true';
  process.env['REMNAWAVE_COMPAT_PREFIX'] = PREFIX;
  const [{ buildApp }, prismaMod] = await Promise.all([
    import('../../app.js'),
    import('../../prisma.js'),
  ]);
  prisma = prismaMod.prisma;
  app = await buildApp();
  await app.ready();
  await prisma.apiToken.create({ data: { name: 'rl', tokenHash: sha(token), scopes: [] } });
});

afterAll(async () => {
  await prisma.apiToken.deleteMany({ where: { tokenHash: sha(token) } });
  await app.close();
});

/** All from one address, which is the point: the limit is keyed by IP. */
async function hammer(url: string, times: number): Promise<number[]> {
  const codes: number[] = [];
  for (let i = 0; i < times; i++) {
    const res = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '203.0.113.77' },
      remoteAddress: '203.0.113.77',
    });
    codes.push(res.statusCode);
  }
  return codes;
}

describe('the facade survives a burst the native API would refuse', () => {
  it('the global 100/min limit is real (control)', async () => {
    // If this ever stops 429-ing, the facade assertion below proves nothing:
    // it would be passing because no limit is being applied at all.
    const codes = await hammer('/api/nodes', 150);
    // 100 through, then 50 refused - asserted as the shape, not as "some",
    // so a limit that quietly moved shows up here instead of passing.
    expect(codes.filter((c) => c === 200).length).toBe(100);
    expect(codes.filter((c) => c === 429).length).toBe(50);
  });

  it('a facade route takes 150 calls in a row without a 429', async () => {
    // A different IP from the control, because the two limiters share a key
    // space and the control has already spent that address's budget.
    const codes: number[] = [];
    for (let i = 0; i < 150; i++) {
      const res = await app.inject({
        method: 'GET',
        url: `/${PREFIX}/api/system/metadata`,
        headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '203.0.113.78' },
        remoteAddress: '203.0.113.78',
      });
      codes.push(res.statusCode);
    }
    expect(codes.filter((c) => c === 429)).toEqual([]);
    expect(codes.every((c) => c === 200)).toBe(true);
  });
});
