import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { invalidateSubscriptionSettingsCache } from '../settings/settings.service.js';
import { registerBindingsCacheBust } from './subscription.bindings-cache.js';
import { pickServer } from './endpoint-identity.js';
import type { SubscriptionEndpoint } from './subscription.formats.js';

/**
 * A-107 (with A-021): a single-server link (`?node=`) picks its server by the
 * endpoint's id, not by the label. The label moves with the neighbours: a
 * second profile on the node renames both points, and an Outline key saved
 * with the old label answered 404, the user left without a connection by an
 * edit to another protocol.
 */

let app: FastifyInstance;
let token: string;

beforeAll(() => registerBindingsCacheBust());

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
const post = async (url: string, payload: Record<string, unknown>) => {
  const res = await app.inject({ method: 'POST', url, headers: auth(), payload });
  expect(res.statusCode, res.body).toBeLessThan(300);
  return JSON.parse(res.body) as { id: string };
};

async function labels(sub: string): Promise<Record<string, string>> {
  const res = await app.inject({ method: 'GET', url: `/sub/${sub}?format=json` });
  const eps = (JSON.parse(res.body) as { endpoints: { protocol: string; nodeName: string }[] }).endpoints;
  return Object.fromEntries(eps.map((e) => [e.protocol, e.nodeName]));
}

describe('?node= after a neighbour profile lands on the node', () => {
  it('the Outline key from the page still answers, and the label of the day is still taken', async () => {
    const node = await post('/api/nodes', { name: 'nl-01', address: 'nl.test', protocol: 'xray' });
    const ss = await post('/api/profiles', { name: 'ss', protocol: 'shadowsocks', config: { method: 'aes-256-gcm' } });
    await post('/api/bindings', { profileId: ss.id, nodeId: node.id, port: 8388 });
    const user = await post('/api/users', { username: 'np-user' });
    const sub = (await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { subscriptionToken: true } })).subscriptionToken;
    // Outline keys exist only for an https address.
    const set = await app.inject({ method: 'PUT', url: '/api/settings', headers: auth(), payload: { subscriptionPublicHost: 'panel.example.com' } });
    expect(set.statusCode, set.body).toBe(200);
    invalidateSubscriptionSettingsCache();

    const page = (await app.inject({ method: 'GET', url: `/sub/${sub}`, headers: { accept: 'text/html' } })).body;
    const key = /ssconf:\/\/panel\.example\.com(\/sub\/[^"#<\s]+)/.exec(page.replaceAll('&amp;', '&'))?.[1];
    expect(key, 'an Outline key on the page').toBeDefined();
    const before = await labels(sub);
    // The key names no label: the label is the part that moves.
    expect(decodeURIComponent(key!)).not.toContain(before.shadowsocks!);
    const first = await app.inject({ method: 'GET', url: key! });
    expect(first.statusCode, first.body).toBe(200);
    expect(JSON.parse(first.body)).toMatchObject({ server: 'nl.test', server_port: 8388 });

    // The neighbour: xray on the same node, the recommended way to diversify.
    const xr = await post('/api/profiles', {
      name: 'xr', protocol: 'xray',
      config: {
        security: 'reality', subprotocol: 'vless', network: 'raw',
        realityDest: 'www.microsoft.com:443', realityServerNames: ['www.microsoft.com'],
        realityPrivateKey: 'k'.repeat(43), realityPublicKey: 'p'.repeat(43), realityShortIds: ['0123abcd'],
      },
    });
    await post('/api/bindings', { profileId: xr.id, nodeId: node.id, port: 443 });
    const after = await labels(sub);
    // The case is real only if the neighbour did move the label.
    expect(after.shadowsocks).not.toBe(before.shadowsocks);

    const again = await app.inject({ method: 'GET', url: key! });
    expect(again.statusCode, again.body).toBe(200);
    expect(JSON.parse(again.body)).toMatchObject({ server: 'nl.test', server_port: 8388 });

    // A link that carries a label (older pages) is still taken by the label.
    const byLabel = await app.inject({ method: 'GET', url: `/sub/${sub}?format=outline&node=${encodeURIComponent(after.shadowsocks!)}` });
    expect(byLabel.statusCode, byLabel.body).toBe(200);
    // An unknown one is still the 404 that names the labels.
    const unknown = await app.inject({ method: 'GET', url: `/sub/${sub}?format=outline&node=nope` });
    expect(unknown.statusCode).toBe(404);
    expect(JSON.parse(unknown.body)).toMatchObject({ error: 'SUBSCRIPTION_NODE_UNKNOWN', nodes: [after.shadowsocks] });
  });
});

describe('pickServer', () => {
  const ep = (key: string, nodeName: string) => ({ key, nodeName, protocol: 'shadowsocks' }) as unknown as SubscriptionEndpoint;
  const a = ep('host-a', 'nl-01');
  const b = ep('host-b', 'de-01');

  it('the id first, then the label, then nothing; without a node the first', async () => {
    const { endpointId } = await import('./endpoint-identity.js');
    expect(pickServer([a, b], endpointId(b))).toBe(b);
    expect(pickServer([a, b], 'de-01')).toBe(b);
    expect(pickServer([a, b], 'xx')).toBeUndefined();
    expect(pickServer([a, b])).toBe(a);
  });
});
