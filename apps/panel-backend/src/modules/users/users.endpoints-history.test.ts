import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';

/**
 * A-167: only a client's fetch of `/sub/<token>` is a subscription fetch. The
 * operator opening the user in the panel and a person opening the page in a
 * browser were written as fetches, and the host card then counted the user as
 * holding the new link.
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
async function post(url: string, payload: Record<string, unknown>) {
  const res = await app.inject({ method: 'POST', url, headers: auth(), payload });
  expect(res.statusCode, res.body).toBeLessThan(300);
  return JSON.parse(res.body) as { id: string };
}

describe('who counts as having fetched', () => {
  it('the panel view and the browser page write no history; the client fetch does', async () => {
    const node = await post('/api/nodes', { name: 'eh-node', address: 'eh.test', protocol: 'xray' });
    const profile = await post('/api/profiles', { name: 'eh-ss', protocol: 'shadowsocks', config: { method: 'aes-256-gcm' } });
    const binding = await post('/api/bindings', { profileId: profile.id, nodeId: node.id, port: 8388 });
    const host = await prisma.host.findFirstOrThrow({ where: { bindingId: binding.id }, select: { id: true } });
    const user = await post('/api/users', { username: 'eh-user' });
    const sub = (await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { subscriptionToken: true } })).subscriptionToken;
    const history = () => prisma.subscriptionRequestHistory.count({ where: { userId: user.id } });
    const freshness = async () =>
      JSON.parse((await app.inject({ method: 'GET', url: `/api/hosts/${host.id}/freshness`, headers: auth() })).body) as {
        current: number; neverFetched: number;
      };

    // The operator opens the user.
    expect((await app.inject({ method: 'GET', url: `/api/users/${user.id}/endpoints`, headers: auth() })).statusCode).toBe(200);
    // Someone opens the subscription page in a browser.
    expect((await app.inject({ method: 'GET', url: `/sub/${sub}`, headers: { accept: 'text/html' } })).statusCode).toBe(200);
    expect(await history()).toBe(0);
    expect(await freshness()).toMatchObject({ current: 0, neverFetched: 1 });

    // The client fetches.
    expect((await app.inject({ method: 'GET', url: `/sub/${sub}`, headers: { 'user-agent': 'Happ/3.2.1' } })).statusCode).toBe(200);
    expect(await history()).toBe(1);
    expect(await freshness()).toMatchObject({ current: 1, neverFetched: 0 });
  });
});
