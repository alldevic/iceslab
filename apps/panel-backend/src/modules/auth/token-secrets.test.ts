import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';

/**
 * A-109: a token with restricted scopes read every profile's server keys.
 * Now it reads without them, a write of such a token that leaves a key out
 * keeps the stored one, and the chain password needs nodes:write like the
 * bootstrap. Sessions and full tokens are unchanged.
 */

let app: FastifyInstance;
let session: string;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  session = await registerAndLogin(app);
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

const PRIVATE = 'k'.repeat(43);
const REALITY = {
  subprotocol: 'vless',
  security: 'reality',
  realityDest: 'www.microsoft.com:443',
  realityServerNames: ['www.microsoft.com'],
  realityPrivateKey: PRIVATE,
  realityPublicKey: 'p'.repeat(43),
  realityShortIds: ['0123abcd'],
  network: 'raw',
};

async function mint(name: string, scopes?: string[]): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/api-tokens',
    headers: { authorization: `Bearer ${session}` },
    payload: { name, ...(scopes ? { scopes } : {}) },
  });
  expect(res.statusCode, res.body).toBe(201);
  return JSON.parse(res.body).token as string;
}

async function profile(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: { authorization: `Bearer ${session}` },
    payload: { name: 'p', protocol: 'xray', config: REALITY },
  });
  expect(res.statusCode, res.body).toBe(201);
  return JSON.parse(res.body).id as string;
}

const get = (url: string, bearer: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${bearer}` } });

describe('server secrets and restricted tokens', () => {
  it('a profiles:read token reads profiles without the keys; a full token and the session see them', async () => {
    const id = await profile();
    const reader = await mint('dash', ['profiles:read']);
    for (const url of [`/api/profiles/${id}`, '/api/profiles']) {
      const res = await get(url, reader);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.body, url).not.toContain(PRIVATE);
      expect(res.body, url).not.toContain('realityPrivateKey');
      expect(res.body, url).toContain('realityPublicKey');
    }
    const full = await mint('full');
    expect((await get(`/api/profiles/${id}`, full)).body).toContain(PRIVATE);
    expect((await get(`/api/profiles/${id}`, session)).body).toContain(PRIVATE);
  });

  it('a profiles:write token that writes back what it read keeps the stored key', async () => {
    const id = await profile();
    const writer = await mint('bot', ['profiles:read', 'profiles:write']);
    const read = JSON.parse((await get(`/api/profiles/${id}`, writer)).body) as { config: Record<string, unknown> };
    expect(read.config.realityPrivateKey).toBeUndefined();
    const put = await app.inject({
      method: 'PUT',
      url: `/api/profiles/${id}`,
      headers: { authorization: `Bearer ${writer}` },
      payload: { config: { ...read.config, realityShortIds: ['89abcdef'] } },
    });
    expect(put.statusCode, put.body).toBe(200);
    const stored = (await prisma.profile.findUniqueOrThrow({ where: { id } })).config as Record<string, unknown>;
    expect(stored.realityPrivateKey).toBe(PRIVATE);
    expect(stored.realityShortIds).toEqual(['89abcdef']);
  });

  it('the chain password needs nodes:write, as the bootstrap does', async () => {
    const node = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: { authorization: `Bearer ${session}` },
      payload: { name: 'n1', address: 'n1.test' },
    });
    const nodeId = JSON.parse(node.body).id as string;
    const reader = await mint('nodes-r', ['nodes:read']);
    const res = await get(`/api/nodes/${nodeId}/chain-secret`, reader);
    expect(res.statusCode, res.body).toBe(403);
    expect(JSON.parse(res.body).message).toContain('nodes:write');
    const writer = await mint('nodes-w', ['nodes:write']);
    expect((await get(`/api/nodes/${nodeId}/chain-secret`, writer)).statusCode).not.toBe(403);
  });
});
