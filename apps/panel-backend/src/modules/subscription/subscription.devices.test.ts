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
 * 9.4: a key and an address per device. `?device=` picks whose tunnel a
 * wgconf / amneziavpn answer is; without it the answer is device 1's, which is
 * the user's old key at their old address.
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
const get = (url: string) => {
  caller += 1;
  return app.inject({ method: 'GET', url, remoteAddress: `10.78.${Math.floor(caller / 250)}.${caller % 250}` });
};

const AWG = { subnet: '10.66.66.0/24', serverPrivateKey: WG_TEST_PRIVATE_KEY, serverPublicKey: WG_TEST_PUBLIC_KEY, obfuscation: {} };
const WG = { subnet: '10.77.77.0/24', serverPrivateKey: WG_TEST_PRIVATE_KEY, serverPublicKey: WG_TEST_PUBLIC_KEY };

async function subscriber(hwidDeviceLimit?: number) {
  const node = await post('/api/nodes', { name: 'eu-1', address: '10.0.0.1:8443' });
  await bind('amneziawg', AWG, node, 51820);
  await bind('wireguard', WG, node, 51830);
  const id = await post('/api/users', { username: 'alice', ...(hwidDeviceLimit !== undefined ? { hwidDeviceLimit } : {}) });
  const u = await prisma.user.findUniqueOrThrow({
    where: { id },
    select: { subscriptionToken: true, amneziawgPrivateKey: true, amneziawgPublicKey: true },
  });
  return { id, token: u.subscriptionToken, key: u.amneziawgPrivateKey };
}

const field = (conf: string, name: string) => new RegExp(`^${name} = (.+)$`, 'm').exec(conf)?.[1];

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

describe('?device= on wgconf', () => {
  it("without it the answer is device 1: the user's own key, the first address, for AmneziaWG and plain", async () => {
    const s = await subscriber();
    const awg = await get(`/sub/${s.token}?format=wgconf`);
    const wg = await get(`/sub/${s.token}?format=wgconf&protocols=wireguard`);
    expect(awg.statusCode).toBe(200);
    expect(field(awg.body, 'PrivateKey')).toBe(s.key);
    expect(field(awg.body, 'Address')).toBe('10.66.66.2/32');
    expect(field(wg.body, 'PrivateKey')).toBe(s.key);
    expect(field(wg.body, 'Address')).toBe('10.77.77.2/32');
    // The same as asking for device 1 outright.
    expect((await get(`/sub/${s.token}?format=wgconf&device=1`)).body).toBe(awg.body);
    expect((await get(`/sub/${s.token}?format=wgconf&protocols=wireguard&device=1`)).body).toBe(wg.body);
  });

  it('?device=2 gives another pair and another address, on AmneziaWG and on plain WireGuard', async () => {
    const s = await subscriber();
    const one = (await get(`/sub/${s.token}?format=wgconf`)).body;
    const two = (await get(`/sub/${s.token}?format=wgconf&device=2`)).body;
    const oneWg = (await get(`/sub/${s.token}?format=wgconf&protocols=wireguard`)).body;
    const twoWg = (await get(`/sub/${s.token}?format=wgconf&protocols=wireguard&device=2`)).body;
    for (const [a, b] of [[one, two], [oneWg, twoWg]] as const) {
      expect(field(b, 'PrivateKey')).toBeTruthy();
      expect(field(b, 'PrivateKey')).not.toBe(field(a, 'PrivateKey'));
      expect(field(b, 'Address')).not.toBe(field(a, 'Address'));
    }
    expect(field(two, 'Address')).toBe('10.66.66.3/32');
    expect(field(twoWg, 'Address')).toBe('10.77.77.3/32');
    // Device 2's key is the second device's, not made up per request.
    const devices = await prisma.wgDevice.findMany({ where: { userId: s.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    expect(devices).toHaveLength(3);
    expect(field(two, 'PrivateKey')).toBe(devices[1]!.privateKey);
    expect(field((await get(`/sub/${s.token}?format=wgconf&device=3`)).body, 'PrivateKey')).toBe(devices[2]!.privateKey);
  });

  it('takes the device by its id too, and the same device every time', async () => {
    const s = await subscriber();
    await get(`/sub/${s.token}?format=wgconf`);
    const second = (await prisma.wgDevice.findMany({ where: { userId: s.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }))[1]!;
    const byId = await get(`/sub/${s.token}?format=wgconf&device=${second.id}`);
    expect(byId.statusCode).toBe(200);
    expect(field(byId.body, 'PrivateKey')).toBe(second.privateKey);
    expect((await get(`/sub/${s.token}?format=wgconf&device=2`)).body).toBe(byId.body);
  });

  it('refuses a device the user does not have, and a device of somebody else', async () => {
    const s = await subscriber(2);
    const four = await get(`/sub/${s.token}?format=wgconf&device=4`);
    expect(four.statusCode).toBe(400);
    expect(JSON.parse(four.body)).toMatchObject({ error: 'SUBSCRIPTION_DEVICE_UNKNOWN', devices: [1, 2] });
    expect((await get(`/sub/${s.token}?format=wgconf&device=nonsense`)).statusCode).toBe(400);
    expect((await get(`/sub/${s.token}?format=amneziavpn&device=3`)).statusCode).toBe(400);

    const other = await post('/api/users', { username: 'bob' });
    const bob = await prisma.user.findUniqueOrThrow({ where: { id: other }, select: { subscriptionToken: true } });
    await get(`/sub/${bob.subscriptionToken}?format=wgconf`);
    const bobsDevice = await prisma.wgDevice.findFirstOrThrow({ where: { userId: other } });
    expect((await get(`/sub/${s.token}?format=wgconf&device=${bobsDevice.id}`)).statusCode).toBe(400);
  });

  it("the number of devices is the user's limit: 2 gives 2, none gives 3, 0 gives 3", async () => {
    const two = await subscriber(2);
    await get(`/sub/${two.token}?format=wgconf`);
    expect(await prisma.wgDevice.count({ where: { userId: two.id } })).toBe(2);
    const none = await post('/api/users', { username: 'carol' });
    const carol = await prisma.user.findUniqueOrThrow({ where: { id: none }, select: { subscriptionToken: true } });
    await get(`/sub/${carol.subscriptionToken}?format=wgconf`);
    expect(await prisma.wgDevice.count({ where: { userId: none } })).toBe(3);
    const zero = await post('/api/users', { username: 'dave', hwidDeviceLimit: 0 });
    const dave = await prisma.user.findUniqueOrThrow({ where: { id: zero }, select: { subscriptionToken: true } });
    await get(`/sub/${dave.subscriptionToken}?format=wgconf`);
    expect(await prisma.wgDevice.count({ where: { userId: zero } })).toBe(3);
  });

  it("names the file after the device from 2 on, and keeps device 1's name", async () => {
    const s = await subscriber();
    const one = await get(`/sub/${s.token}?format=wgconf&protocols=amneziawg`);
    const two = await get(`/sub/${s.token}?format=wgconf&protocols=amneziawg&device=2`);
    expect(one.headers['content-disposition']).toContain('filename="alice.conf"');
    expect(two.headers['content-disposition']).toContain('filename="alice-2.conf"');
    // With a node: the device follows the node's name.
    const label = (JSON.parse((await get(`/sub/${s.token}?format=json&protocols=amneziawg`)).body).endpoints as { nodeName: string }[])[0]!.nodeName;
    const named = await get(`/sub/${s.token}?format=wgconf&protocols=amneziawg&device=3&node=${encodeURIComponent(label)}`);
    expect(named.headers['content-disposition']).toMatch(/filename="alice-.+-3\.conf"/);
  });
});

describe('?device= on amneziavpn and on the page', () => {
  it('amneziavpn: device 1 without it, device 2 a different key', async () => {
    const s = await subscriber();
    const one = (await get(`/sub/${s.token}?format=amneziavpn`)).body;
    const two = (await get(`/sub/${s.token}?format=amneziavpn&device=2`)).body;
    expect(one).toMatch(/^vpn:\/\//);
    expect(two).toMatch(/^vpn:\/\//);
    expect(two).not.toBe(one);
    expect((await get(`/sub/${s.token}?format=amneziavpn&device=1`)).body).toBe(one);
  });

  it('the page lists a tunnel per device, linking device 2 on with device=', async () => {
    const s = await subscriber();
    const page = await app.inject({ method: 'GET', url: `/sub/${s.token}`, headers: { accept: 'text/html' }, remoteAddress: '10.79.0.1' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('eu-1 #2');
    expect(page.body).toContain('eu-1 #3');
    expect(page.body).toMatch(/format=wgconf[^"]*device=2/);
    expect(page.body).not.toContain('eu-1 #1');
  });
});
