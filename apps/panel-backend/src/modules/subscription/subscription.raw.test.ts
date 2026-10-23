import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';

/**
 * A-236 step 1: `?format=raw` is the plain list without the base64, the same
 * lines, and a host switches it off by its own name.
 */
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

async function subscriber(): Promise<string> {
  const node = await app.inject({
    method: 'POST', url: '/api/nodes', headers: auth(),
    payload: { name: 'raw-node', address: 'raw.test', protocol: 'xray' },
  });
  const profile = await app.inject({
    method: 'POST', url: '/api/profiles', headers: auth(),
    payload: {
      name: 'raw-profile', protocol: 'xray',
      config: {
        security: 'reality', subprotocol: 'vless', network: 'raw',
        realityDest: 'www.microsoft.com:443', realityServerNames: ['www.microsoft.com'],
        realityPrivateKey: 'k'.repeat(43), realityPublicKey: 'p'.repeat(43), realityShortIds: ['0123abcd'],
      },
    },
  });
  expect(profile.statusCode, profile.body).toBe(201);
  const binding = await app.inject({
    method: 'POST', url: '/api/bindings', headers: auth(),
    payload: { profileId: JSON.parse(profile.body).id, nodeId: JSON.parse(node.body).id, port: 443 },
  });
  expect(binding.statusCode, binding.body).toBe(201);
  const user = await app.inject({ method: 'POST', url: '/api/users', headers: auth(), payload: { username: 'raw-user' } });
  const { subscriptionToken } = await prisma.user.findUniqueOrThrow({
    where: { id: JSON.parse(user.body).id as string }, select: { subscriptionToken: true },
  });
  return subscriptionToken;
}

describe('?format=raw', () => {
  it('answers the plain list unwrapped: the same lines, as text', async () => {
    const sub = await subscriber();
    const plain = await app.inject({ method: 'GET', url: `/sub/${sub}?format=plain` });
    const raw = await app.inject({ method: 'GET', url: `/sub/${sub}?format=raw` });
    expect(raw.statusCode).toBe(200);
    expect(raw.headers['content-type']).toContain('text/plain');
    expect(raw.body).toMatch(/^vless:\/\//);
    expect(raw.body).toBe(Buffer.from(plain.body, 'base64').toString('utf8'));
  });

  it('a host switched off for raw leaves raw empty and plain as it was', async () => {
    const sub = await subscriber();
    await prisma.host.updateMany({ data: { disableForFormats: ['raw'] } });
    const raw = await app.inject({ method: 'GET', url: `/sub/${sub}?format=raw` });
    expect(raw.body).toBe('');
    const plain = await app.inject({ method: 'GET', url: `/sub/${sub}?format=plain` });
    expect(Buffer.from(plain.body, 'base64').toString('utf8')).toMatch(/^vless:\/\//);
  });
});
