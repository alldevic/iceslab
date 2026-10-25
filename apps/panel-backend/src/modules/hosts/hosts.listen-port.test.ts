import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { eventBus } from '../../lib/infra/event-bus.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { registerBindingsCacheBust } from '../subscription/subscription.bindings-cache.js';

/**
 * A-150: the port on the host screen is the port the node LISTENS on. It used
 * to write portOverride only, so the node kept the old port while every
 * client was handed the new one. Now it moves the binding (port checks, push)
 * and portOverride is only the port clients dial when it differs (NAT, CDN).
 */
let app: FastifyInstance;
let token: string;
const pushed: string[] = [];

beforeAll(() => {
  registerBindingsCacheBust();
  eventBus.on('binding.updated', ({ bindingId }) => {
    pushed.push(bindingId);
  });
});

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  token = await registerAndLogin(app);
  pushed.length = 0;
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

const auth = () => ({ authorization: `Bearer ${token}` });
const call = async (method: 'POST' | 'PUT', url: string, payload: unknown) => {
  const res = await app.inject({ method, url, headers: auth(), payload });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};

async function seed() {
  const profile = (
    await call('POST', '/api/profiles', {
      name: 'p',
      protocol: 'xray',
      config: {
        security: 'reality',
        realityDest: 'www.microsoft.com:443',
        realityServerNames: ['www.microsoft.com'],
        realityPrivateKey: 'k'.repeat(43),
        realityPublicKey: 'p'.repeat(43),
        realityShortIds: ['0123abcd'],
        network: 'raw',
      },
    })
  ).body;
  const node = (await call('POST', '/api/nodes', { name: 'n', address: 'n.example.com', protocol: 'xray' })).body;
  // The create screen used to send the listen port as an override too.
  const host = (
    await call('POST', '/api/hosts', { profileId: profile.id, nodeId: node.id, port: 443, portOverride: 443, remark: 'Direct' })
  ).body;
  const squad = (await call('POST', '/api/squads', { name: 'sq', profileIds: [profile.id] })).body;
  const user = (await call('POST', '/api/users', { username: 'port_user', groupIds: [squad.id] })).body;
  return { profile, node, host, user };
}

async function subscribedPorts(subToken: string): Promise<number[]> {
  const res = await app.inject({ method: 'GET', url: `/sub/${subToken}?format=plain` });
  expect(res.statusCode, `${subToken} ${res.body}`).toBe(200);
  return Buffer.from(res.body, 'base64')
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((uri) => Number(new URL(uri).port));
}

const bindingOf = async (hostId: string) =>
  prisma.profileNodeBinding.findFirstOrThrow({ where: { hosts: { some: { id: hostId } } } });

describe('the listen port on the host screen', () => {
  it('create does not store an override equal to the listen port', async () => {
    const { host } = await seed();
    expect((await prisma.host.findUniqueOrThrow({ where: { id: host.id } })).portOverride).toBeNull();
  });

  it('a port change moves the binding, pushes, and the subscription hands out the new port', async () => {
    const { host, user } = await seed();
    const res = await call('PUT', `/api/hosts/${host.id}`, { port: 8443 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const binding = await bindingOf(host.id);
    expect(binding.port).toBe(8443);
    expect(pushed).toEqual([binding.id]);
    expect(await subscribedPorts(user.subscriptionToken)).toEqual([8443]);
  });

  it('a binding from the node wizard (publicPort = port) moves too: clients get the new port', async () => {
    const { host, user } = await seed();
    // What the wizard left on every binding it created, before the server
    // stopped storing the copy.
    const b = await bindingOf(host.id);
    await prisma.profileNodeBinding.update({ where: { id: b.id }, data: { publicPort: 443 } });

    const res = await call('PUT', `/api/hosts/${host.id}`, { port: 8443 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await bindingOf(host.id);
    expect([after.port, after.publicPort]).toEqual([8443, null]);
    expect(await subscribedPorts(user.subscriptionToken)).toEqual([8443]);
  });

  it('a public port equal to the listen port is not stored by the bindings API either', async () => {
    const { host } = await seed();
    const b = await bindingOf(host.id);
    const res = await call('PUT', `/api/bindings/${b.id}`, { publicPort: 443 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await bindingOf(host.id)).publicPort).toBeNull();
  });

  it('an override is the port clients dial; the binding is not touched', async () => {
    const { host, user } = await seed();
    const res = await call('PUT', `/api/hosts/${host.id}`, { portOverride: 2053 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await bindingOf(host.id)).port).toBe(443);
    expect(pushed).toEqual([]);
    expect(await subscribedPorts(user.subscriptionToken)).toEqual([2053]);
  });

  // A-259: one profile may sit on a node on several ports, so a host on a
  // binding it shares moves alone by default ('host'), or takes the whole
  // binding with it ('binding'). HOST_PORT_SHARED is not answered any more.
  it('portMove host (the default): the host goes onto a binding of its own, the other host stays on the old port', async () => {
    const { host, profile, node } = await seed();
    const cdn = (await call('POST', '/api/hosts', { profileId: profile.id, nodeId: node.id, port: 443, remark: 'CDN' })).body;
    const old = await bindingOf(host.id);
    await prisma.host.update({ where: { id: host.id }, data: { linkChangedAt: new Date('2020-01-01T00:00:00Z') } });

    const moved = await call('PUT', `/api/hosts/${host.id}`, { port: 8443 });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const mine = await bindingOf(host.id);
    expect(mine.id).not.toBe(old.id);
    expect(mine.port).toBe(8443);
    expect(mine.publicPort).toBeNull();
    expect((await bindingOf(cdn.id)).id).toBe(old.id);
    expect((await bindingOf(cdn.id)).port).toBe(443);
    // Its link changed: the stamp moved (A-122).
    expect((await prisma.host.findUniqueOrThrow({ where: { id: host.id } })).linkChangedAt.getTime()).toBeGreaterThan(
      new Date('2020-01-01T00:00:00Z').getTime(),
    );

    // Back to 443: onto the binding there, and the one it leaves empty is removed.
    const back = await call('PUT', `/api/hosts/${host.id}`, { port: 443 });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect((await bindingOf(host.id)).id).toBe(old.id);
    expect(await prisma.profileNodeBinding.findUnique({ where: { id: mine.id } })).toBeNull();
  });

  it('portMove binding, and confirmSharedPort as the older screens send it: every host of the binding moves', async () => {
    const { host, profile, node } = await seed();
    const cdn = (await call('POST', '/api/hosts', { profileId: profile.id, nodeId: node.id, port: 443, remark: 'CDN' })).body;
    const old = await bindingOf(host.id);

    const moved = await call('PUT', `/api/hosts/${host.id}`, { port: 8443, portMove: 'binding' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect((await bindingOf(host.id)).id).toBe(old.id);
    expect((await bindingOf(cdn.id)).port).toBe(8443);

    const legacy = await call('PUT', `/api/hosts/${host.id}`, { port: 9443, confirmSharedPort: true });
    expect(legacy.status, JSON.stringify(legacy.body)).toBe(200);
    expect((await bindingOf(cdn.id)).port).toBe(9443);
    expect(await prisma.profileNodeBinding.count({ where: { profileId: profile.id, nodeId: node.id } })).toBe(1);
  });

  it('two hosts on two bindings of one profile are two endpoints in the subscription, with their own ids and ports', async () => {
    const { host, profile, node, user } = await seed();
    await call('POST', '/api/hosts', { profileId: profile.id, nodeId: node.id, port: 443, remark: 'CDN' });
    expect((await call('PUT', `/api/hosts/${host.id}`, { port: 8443 })).status).toBe(200);

    const res = await app.inject({ method: 'GET', url: `/sub/${user.subscriptionToken}?format=json` });
    expect(res.statusCode).toBe(200);
    const eps = (JSON.parse(res.body) as { endpoints: { key: string; port: number; hostId: string }[] }).endpoints;
    expect(eps).toHaveLength(2);
    expect(new Set(eps.map((e) => e.key)).size).toBe(2);
    expect(eps.map((e) => e.port).sort()).toEqual([443, 8443]);
    expect(await subscribedPorts(user.subscriptionToken)).toEqual(expect.arrayContaining([443, 8443]));
  });

  it('a port another profile holds on the node is refused with the same answer as create', async () => {
    const { host, node } = await seed();
    const other = (
      await call('POST', '/api/profiles', {
        name: 'p2',
        protocol: 'xray',
        config: {
          security: 'reality',
          realityDest: 'www.microsoft.com:443',
          realityServerNames: ['www.microsoft.com'],
          realityPrivateKey: 'k'.repeat(43),
          realityPublicKey: 'p'.repeat(43),
          realityShortIds: ['0123abcd'],
          network: 'raw',
        },
      })
    ).body;
    await call('POST', '/api/hosts', { profileId: other.id, nodeId: node.id, port: 8443, remark: 'Other' });
    const res = await call('PUT', `/api/hosts/${host.id}`, { port: 8443 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('PORT_TAKEN_PROFILE');
    expect((await bindingOf(host.id)).port).toBe(443);
  });
});
