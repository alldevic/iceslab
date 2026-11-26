import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { invalidateSrrCache } from '../srr/srr.service.js';
import { WG_TEST_PRIVATE_KEY, WG_TEST_PUBLIC_KEY } from '../../../tests/helpers/wg-keys.js';

/**
 * 12.4: a User-Agent rule names the wg flavour `wgconf` renders. The rule's
 * flavour narrows like `?protocols=` does, only when the request names no
 * protocols itself, and only when the user holds a tunnel of that flavour.
 */

let app: FastifyInstance;
let token: string;
const auth = () => ({ authorization: `Bearer ${token}` });

async function post(url: string, payload: object): Promise<string> {
  const res = await app.inject({ method: 'POST', url, headers: auth(), payload });
  if (res.statusCode !== 201) throw new Error(`${url}: ${res.statusCode} ${res.body}`);
  return JSON.parse(res.body).id as string;
}

let seq = 0;
async function bind(protocol: string, config: object, nodeId: string, port: number) {
  seq += 1;
  const profileId = await post('/api/profiles', { name: `${protocol}-${seq}`, protocol, config });
  await post('/api/bindings', { profileId, nodeId, port });
}

let caller = 0;
const get = (url: string, userAgent?: string) => {
  caller += 1;
  return app.inject({
    method: 'GET',
    url,
    ...(userAgent ? { headers: { 'user-agent': userAgent } } : {}),
    remoteAddress: `10.80.${Math.floor(caller / 250)}.${caller % 250}`,
  });
};

const AWG = { subnet: '10.66.66.0/24', serverPrivateKey: WG_TEST_PRIVATE_KEY, serverPublicKey: WG_TEST_PUBLIC_KEY, obfuscation: {} };
const WG = { subnet: '10.77.77.0/24', serverPrivateKey: WG_TEST_PRIVATE_KEY, serverPublicKey: WG_TEST_PUBLIC_KEY };

async function subscriber(kinds: ('amneziawg' | 'wireguard')[]) {
  const node = await post('/api/nodes', { name: 'amsterdam-primary-1', address: '10.0.0.1:8443' });
  if (kinds.includes('amneziawg')) await bind('amneziawg', AWG, node, 51820);
  if (kinds.includes('wireguard')) await bind('wireguard', WG, node, 51830);
  const id = await post('/api/users', { username: 'alice' });
  const u = await prisma.user.findUniqueOrThrow({ where: { id }, select: { subscriptionToken: true } });
  return u.subscriptionToken;
}

async function rule(name: string, uaPattern: string, proto: 'amneziawg' | 'wireguard' | null) {
  await prisma.subscriptionResponseRule.create({
    data: { name, uaPattern, format: 'wgconf', proto, priority: 10 },
  });
  invalidateSrrCache();
}

// An AmneziaWG file carries the obfuscation directives; a stock one never does.
const isAwg = (body: string) => /^Jc\s*=/m.test(body);
const port = (body: string) => /^Endpoint\s*=.*:(\d+)\s*$/m.exec(body)?.[1];

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  invalidateSrrCache();
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

describe('a rule that names a wg flavour', () => {
  it('serves each client its own file from one subscription', async () => {
    const t = await subscriber(['amneziawg', 'wireguard']);
    await rule('WG', 'WireGuard/', 'wireguard');
    await rule('AWG', 'AmneziaWG/', 'amneziawg');
    const stock = await get(`/sub/${t}`, 'WireGuard/1.0.16 (Android)');
    expect(stock.statusCode).toBe(200);
    expect(isAwg(stock.body)).toBe(false);
    expect(port(stock.body)).toBe('51830');
    const awg = await get(`/sub/${t}`, 'AmneziaWG/1.0');
    expect(isAwg(awg.body)).toBe(true);
    expect(port(awg.body)).toBe('51820');
  });

  it('an explicit ?protocols= beats the rule', async () => {
    const t = await subscriber(['amneziawg', 'wireguard']);
    await rule('WG', 'WireGuard/', 'wireguard');
    const res = await get(`/sub/${t}?protocols=amneziawg`, 'WireGuard/1.0.16 (Android)');
    expect(isAwg(res.body)).toBe(true);
  });

  it('is not applied when the request names the format itself', async () => {
    const t = await subscriber(['amneziawg', 'wireguard']);
    await rule('WG', 'WireGuard/', 'wireguard');
    const res = await get(`/sub/${t}?format=wgconf`, 'WireGuard/1.0.16 (Android)');
    // The base's wgconf with two tunnels and no narrowing: the AmneziaWG one first.
    expect(isAwg(res.body)).toBe(true);
  });

  it('issues without narrowing when the user holds no tunnel of that flavour', async () => {
    const t = await subscriber(['amneziawg']);
    await rule('WG', 'WireGuard/', 'wireguard');
    const res = await get(`/sub/${t}`, 'WireGuard/1.0.16 (Android)');
    expect(res.statusCode).toBe(200);
    expect(isAwg(res.body)).toBe(true);
  });
});

describe('a rule that names no flavour', () => {
  it('serves as before: the first tunnel the user holds', async () => {
    const t = await subscriber(['amneziawg', 'wireguard']);
    await rule('Any', 'SomeWg/', null);
    const res = await get(`/sub/${t}`, 'SomeWg/1.0');
    expect(res.statusCode).toBe(200);
    expect(isAwg(res.body)).toBe(true);
  });
});
