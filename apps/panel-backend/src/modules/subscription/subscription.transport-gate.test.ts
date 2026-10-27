import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { TRANSPORT_SUPPORT } from '@iceslab/shared';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { generateSubscription } from './subscription.service.js';

/**
 * A-224 tail: the shared transport table asked through the service itself,
 * on rows written as the database holds them, not only as the API would.
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

const REALITY = {
  security: 'reality',
  realityDest: 'www.microsoft.com:443',
  realityServerNames: ['www.microsoft.com'],
  realityPrivateKey: 'k'.repeat(43),
  realityPublicKey: 'p'.repeat(43),
  realityShortIds: ['0123abcd'],
};

/** A node, a profile with `config`, a binding. Returns the profile id and the
 *  node's name, which is the endpoint's name. */
async function bound(config: Record<string, unknown>): Promise<{ profileId: string; nodeName: string }> {
  seq += 1;
  const nodeName = `tg-node-${seq}`;
  const node = await app.inject({
    method: 'POST',
    url: '/api/nodes',
    headers: auth(),
    payload: { name: nodeName, address: `tg-${seq}.test`, protocol: 'xray' },
  });
  expect(node.statusCode, node.body).toBe(201);
  const profile = await app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: auth(),
    payload: { name: `tg-profile-${seq}`, protocol: 'xray', config },
  });
  expect(profile.statusCode, profile.body).toBe(201);
  const profileId = JSON.parse(profile.body).id as string;
  const binding = await app.inject({
    method: 'POST',
    url: '/api/bindings',
    headers: auth(),
    payload: { profileId, nodeId: JSON.parse(node.body).id, port: 443 },
  });
  expect(binding.statusCode, binding.body).toBe(201);
  return { profileId, nodeName };
}

/** Overwrites one key of a stored profile config the way an old or hand-made
 *  row would hold it, past the API schema. */
async function storeConfigKey(profileId: string, key: string, value: unknown): Promise<void> {
  const row = await prisma.profile.findUniqueOrThrow({ where: { id: profileId }, select: { config: true } });
  await prisma.profile.update({
    where: { id: profileId },
    data: { config: { ...(row.config as Record<string, unknown>), [key]: value } },
  });
}

async function newUser(): Promise<string> {
  const user = await app.inject({ method: 'POST', url: '/api/users', headers: auth(), payload: { username: `tg-user-${seq}` } });
  expect(user.statusCode, user.body).toBe(201);
  const { subscriptionToken } = await prisma.user.findFirstOrThrow({
    where: { id: JSON.parse(user.body).id as string },
    select: { subscriptionToken: true },
  });
  return subscriptionToken;
}

describe('the transport table through the service', () => {
  it('a stored subprotocol no format carries skips that endpoint, and the subscription still answers 200', async () => {
    const good = await bound({ ...REALITY, subprotocol: 'vless', network: 'raw' });
    const bad = await bound({ ...REALITY, subprotocol: 'vless', network: 'raw' });
    await storeConfigKey(bad.profileId, 'subprotocol', 'wireguard');
    const sub = await newUser();

    const result = await generateSubscription(sub, { ip: '127.0.0.1', userAgent: '' });
    const names = result.endpoints.filter((e) => e.protocol === 'xray').map((e) => e.nodeName);
    expect(names).toContain(good.nodeName);
    expect(names).not.toContain(bad.nodeName);

    for (const format of ['plain', 'clash', 'singbox', 'xrayjson', 'xrayjson-array', 'xkeen', 'surge', 'quantumultx', 'loon']) {
      const res = await app.inject({ method: 'GET', url: `/sub/${sub}?format=${format}` });
      expect(res.statusCode, `${format}: ${res.body.slice(0, 200)}`).toBe(200);
    }
  });

  it('a stored network the table does not know gives no link, not a bare TCP one', async () => {
    const p = await bound({ ...REALITY, subprotocol: 'vless', network: 'raw' });
    await storeConfigKey(p.profileId, 'network', 'quic');
    const sub = await newUser();

    const result = await generateSubscription(sub, { ip: '127.0.0.1', userAgent: '' });
    const e = result.endpoints.find((x) => x.nodeName === p.nodeName);
    expect(e).toBeDefined();
    expect(e!.uri).toBe('');
    const res = await app.inject({ method: 'GET', url: `/sub/${sub}?format=clash` });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(p.nodeName);
  });

  it('the link gate is the table: a link cell narrowed to skipped takes the link out, the endpoint stays', async () => {
    const p = await bound({ ...REALITY, subprotocol: 'vless', network: 'xhttp', path: '/xh' });
    const sub = await newUser();

    const before = await generateSubscription(sub, { ip: '127.0.0.1', userAgent: '' });
    expect(before.endpoints.find((x) => x.nodeName === p.nodeName)!.uri).toMatch(/^vless:\/\//);

    const saved = TRANSPORT_SUPPORT['vless-link'].vless;
    TRANSPORT_SUPPORT['vless-link'].vless = { ...saved, xhttp: 'skipped' };
    try {
      const after = await generateSubscription(sub, { ip: '127.0.0.1', userAgent: '' });
      const e = after.endpoints.find((x) => x.nodeName === p.nodeName);
      expect(e).toBeDefined();
      expect(e!.uri).toBe('');
      expect(after.textPlain).not.toContain('vless://');
    } finally {
      TRANSPORT_SUPPORT['vless-link'].vless = saved;
    }
  });
});
