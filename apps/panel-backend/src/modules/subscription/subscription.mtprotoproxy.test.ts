import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { deriveMtprotoSecret } from '../../lib/auth/credentials.js';
import { mtprotoFakeTlsSecret, mtprotoSecret } from '../../core-adapters/mtproto/uri.js';
import { generateSubscription } from './subscription.service.js';

/**
 * MTProto's two engines hand out different links. mtg serves one secret per
 * inbound, so every user of it holds the same link; mtprotoproxy serves the
 * secret the node was given for each user, so the link is the user's own and
 * stops working when they are taken off the node.
 */
let app: FastifyInstance;
let token: string;
let seq = 0;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  token = await registerAndLogin(app);
  seq = 0;
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

const auth = () => ({ authorization: `Bearer ${token}` });
const DOMAIN = 'www.example.com';

async function post(url: string, payload: Record<string, unknown>): Promise<string> {
  const res = await app.inject({ method: 'POST', url, headers: auth(), payload });
  expect(res.statusCode, res.body).toBe(201);
  return JSON.parse(res.body).id as string;
}

/** One mtproto profile on `engine` bound to a node, and the mtproto endpoints
 *  two users get from it. */
async function twoUsers(engine: 'mtprotoproxy' | null) {
  seq += 1;
  const nodeId = await post('/api/nodes', { name: `mt-node-${seq}`, address: `mt-${seq}.test` });
  const profileId = await post('/api/profiles', {
    name: `mt-profile-${seq}`,
    protocol: 'mtproto',
    ...(engine ? { engine } : {}),
    config: { domain: DOMAIN },
  });
  const bindingId = await post('/api/bindings', { profileId, nodeId, port: 2443 });
  const out: { secret: string; xrayUuid: string }[] = [];
  for (const name of ['a', 'b']) {
    const id = await post('/api/users', { username: `mt-${name}-${seq}` });
    const u = await prisma.user.findUniqueOrThrow({ where: { id }, select: { subscriptionToken: true, xrayUuid: true } });
    const sub = await generateSubscription(u.subscriptionToken, { ip: '127.0.0.1', userAgent: '' });
    const e = sub.endpoints.find((x) => x.protocol === 'mtproto') as { secret: string; engine?: string } | undefined;
    expect(e, `user ${name} got no mtproto line`).toBeTruthy();
    out.push({ secret: e!.secret, xrayUuid: u.xrayUuid });
  }
  return { bindingId, users: out };
}

describe('the mtproto link follows the engine', () => {
  it('mtprotoproxy: each user their own Fake-TLS secret, the one the node is given', async () => {
    const { users } = await twoUsers('mtprotoproxy');
    for (const u of users) {
      expect(u.secret).toBe(mtprotoFakeTlsSecret(deriveMtprotoSecret(u.xrayUuid), DOMAIN));
      expect(u.secret).toMatch(/^ee[0-9a-f]{32}[0-9a-f]+$/);
    }
    expect(users[0]!.secret).not.toBe(users[1]!.secret);
  });

  it('mtg (native): one secret for the inbound, the same for every user', async () => {
    const { bindingId, users } = await twoUsers(null);
    expect(users[0]!.secret).toBe(mtprotoSecret(bindingId, DOMAIN));
    expect(users[1]!.secret).toBe(users[0]!.secret);
  });
});

describe('the profile takes mtprotoproxy for mtproto and nothing else', () => {
  it('refuses the engine on another protocol', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/profiles',
      headers: auth(),
      payload: { name: 'hy-mtpp', protocol: 'hysteria', engine: 'mtprotoproxy', config: {} },
    });
    expect(res.statusCode, res.body).toBe(400);
  });
});
