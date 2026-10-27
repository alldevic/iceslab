import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from './redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { redactUrl, secretPrefixOf } from './log-redact.js';

/**
 * A-267: what the request log holds of a URL with a token in it, read from
 * the logger's own stream at info, the production level.
 */

const SUB = 'Zx9QkT2mVb7LpR4sWc8NdY3h';
const BOOTSTRAP = 'bs_Qm3Xr8TzK2vLp9WsN4cYd7HbF6jG';
const PREVIEW = '7c1e4a52-9b3d-4f8e-a6c2-15d0e9b7f342';
const BY_TOKEN = 'Hk4Lm9Qp2Rs7Tv3Wx8Yz5Ab6Cd';
const CLIENT_IP = '203.0.113.77';

let app: FastifyInstance;
let admin: string;
const lines: string[] = [];

beforeAll(async () => {
  app = await buildApp({ log: { level: 'info', stream: { write: (line: string) => void lines.push(line) } } });
  await cleanDatabase();
  admin = await registerAndLogin(app);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await closeRedis();
});

/** The log lines one request wrote, by its request id. */
async function logOf(url: string, opts: { auth?: boolean } = {}): Promise<string[]> {
  const from = lines.length;
  await app.inject({
    method: 'GET',
    url,
    remoteAddress: CLIENT_IP,
    headers: opts.auth ? { authorization: `Bearer ${admin}` } : {},
  });
  return lines.slice(from);
}

describe('the request log', () => {
  it('a subscription poll: no token in full, the client address cut to its /24', async () => {
    for (const url of [`/sub/${SUB}/mihomo`, `/sub/${SUB}?format=wgconf&node=x`, `/sub/${SUB}`, `/sub/${SUB}/x/y`]) {
      const out = await logOf(url);
      const text = out.join('');
      expect(out.length, url).toBeGreaterThan(0);
      expect(text, url).not.toContain(SUB);
      expect(text, url).not.toContain(CLIENT_IP);
      const incoming = out.map((l) => JSON.parse(l) as { msg: string; req?: { url: string; remoteAddress: string } }).find((l) => l.msg === 'incoming request');
      expect(incoming?.req?.url, url).toContain(`/sub/${SUB.slice(0, 4)}***`);
      expect(incoming?.req?.remoteAddress, url).toBe('203.0.113.0/24');
    }
  });

  it('the format and node of the query stay readable', async () => {
    const text = (await logOf(`/sub/${SUB}?format=wgconf&node=x`)).join('');
    expect(text).toContain('format=wgconf&node=x');
  });

  it('a request under a token route that matches nothing: the 404 line does not hold it either', async () => {
    const out = await logOf(`/sub/${SUB}/a/b/c`);
    expect(out.some((l) => l.includes('not found'))).toBe(true);
    expect(out.join('')).not.toContain(SUB);
  });

  it('the bootstrap redeem and the two admin routes with a token: none of the tokens in full', async () => {
    for (const [url, token, auth] of [
      [`/api/internal/bootstrap/${BOOTSTRAP}`, BOOTSTRAP, false],
      [`/api/users/by-subscription-token/${BY_TOKEN}`, BY_TOKEN, true],
      [`/api/settings/subscription/preview/${PREVIEW}`, PREVIEW, true],
    ] as const) {
      const out = await logOf(url, { auth });
      expect(out.length, url).toBeGreaterThan(0);
      expect(out.join(''), url).not.toContain(token);
    }
  });

  it('an address of a request with no token is kept', async () => {
    const text = (await logOf('/api/auth/status')).join('');
    expect(text).toContain(CLIENT_IP);
  });
});

describe('the rule', () => {
  it('a parameter named token, or ending in Token, is the secret; the segments before it are any one segment', () => {
    expect(secretPrefixOf('/sub/:token/:client')!.exec('/sub/abc/mihomo')?.[1]).toBe('abc');
    expect(secretPrefixOf('/api/x/:id/:subscriptionToken')!.exec('/api/x/7/def')?.[1]).toBe('def');
    expect(secretPrefixOf('/api/users/:id')).toBeNull();
    expect(secretPrefixOf('/api/users/:tokenId')).toBeNull();
  });

  it('a secret query key is masked whatever the route', () => {
    expect(redactUrl('/api/thing?api_key=abc&page=2')).toBe('/api/thing?api_key=***&page=2');
    expect(redactUrl('/api/thing?page=2')).toBe('/api/thing?page=2');
  });
});
