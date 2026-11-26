import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { eventBus } from '../../lib/infra/event-bus.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { ensureDevices } from './wg-devices.service.js';

let app: FastifyInstance;
let token: string;
const auth = () => ({ authorization: `Bearer ${token}` });

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  token = await registerAndLogin(app);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

async function userWithDevices(name: string, n = 3) {
  const res = await app.inject({ method: 'POST', url: '/api/users', headers: auth(), payload: { username: name } });
  const userId = JSON.parse(res.body).id as string;
  const { devices } = await ensureDevices(userId, n);
  return { userId, devices };
}

async function mint(scopes: string[]): Promise<{ authorization: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/api-tokens', headers: auth(), payload: { name: `t-${scopes.join('-')}`, scopes } });
  expect(res.statusCode, res.body).toBe(201);
  return { authorization: `Bearer ${JSON.parse(res.body).token}` };
}

describe('GET /api/users/:userId/wg-devices', () => {
  it('needs a session', async () => {
    const { userId } = await userWithDevices('no_session');
    expect((await app.inject({ method: 'GET', url: `/api/users/${userId}/wg-devices` })).statusCode).toBe(401);
  });

  it('lists the live devices, device 1 first, with addresses and counters as strings, and never a key but the public one', async () => {
    const { userId, devices } = await userWithDevices('lister');
    const profile = await prisma.profile.create({ data: { name: 'p', protocol: 'amneziawg', config: {} } });
    await prisma.amneziawgPeer.create({ data: { profileId: profile.id, userId, deviceId: devices[1]!.id, ip: '10.66.66.3' } });
    await prisma.wgDevice.update({ where: { id: devices[1]!.id }, data: { bytesIn: 5_000_000_000_000_000n, lastSeenAt: new Date(1_800_000_000_000) } });

    const res = await app.inject({ method: 'GET', url: `/api/users/${userId}/wg-devices`, headers: auth() });
    expect(res.statusCode).toBe(200);
    const list = JSON.parse(res.body).devices as Record<string, unknown>[];
    expect(list.map((d) => d.index)).toEqual([1, 2, 3]);
    expect(list.map((d) => d.id)).toEqual(devices.map((d) => d.id));
    expect(list[1]).toMatchObject({ addresses: ['10.66.66.3'], bytesIn: '5000000000000000', bytesOut: '0', lastSeenAt: '2027-01-15T08:00:00.000Z' });
    expect(list[0]).toMatchObject({ addresses: [], lastSeenAt: null });
    expect(res.body).not.toContain(devices[0]!.privateKey);
    expect(res.body).not.toContain('privateKey');
    expect(res.body).not.toContain('presharedKey');
  });

  it('is a users:read matter: a token with it lists, one with wg-devices:read only does not', async () => {
    const { userId } = await userWithDevices('scoped_list');
    const ok = await app.inject({ method: 'GET', url: `/api/users/${userId}/wg-devices`, headers: await mint(['users:read']) });
    expect(ok.statusCode).toBe(200);
    const no = await app.inject({ method: 'GET', url: `/api/users/${userId}/wg-devices`, headers: await mint(['nodes:read', 'wg-devices:write']) });
    expect(no.statusCode).toBe(403);
  });
});

describe('DELETE /api/wg-devices/:id', () => {
  it('needs a session, and a token with the wg-devices:write scope', async () => {
    const { devices } = await userWithDevices('scoped_revoke');
    const id = devices[0]!.id;
    expect((await app.inject({ method: 'DELETE', url: `/api/wg-devices/${id}` })).statusCode).toBe(401);
    for (const scopes of [['users:write'], ['wg-devices:read'], ['nodes:write']]) {
      const res = await app.inject({ method: 'DELETE', url: `/api/wg-devices/${id}`, headers: await mint(scopes) });
      expect(res.statusCode, scopes.join()).toBe(403);
    }
    expect((await prisma.wgDevice.findUniqueOrThrow({ where: { id } })).revokedAt).toBeNull();
    const ok = await app.inject({ method: 'DELETE', url: `/api/wg-devices/${id}`, headers: await mint(['wg-devices:write']) });
    expect(ok.statusCode).toBe(204);
  });

  it('marks the row revoked (kept, with its traffic), frees its addresses, announces it once, and the list drops it', async () => {
    const { userId, devices } = await userWithDevices('revoker');
    const target = devices[1]!;
    const profile = await prisma.profile.create({ data: { name: 'p', protocol: 'amneziawg', config: {} } });
    await prisma.amneziawgPeer.create({ data: { profileId: profile.id, userId, deviceId: target.id, ip: '10.66.66.3' } });
    await prisma.wgDevice.update({ where: { id: target.id }, data: { bytesOut: 42n } });
    const heard: unknown[] = [];
    eventBus.on('wg-devices.changed', (p) => heard.push(p));

    const res = await app.inject({ method: 'DELETE', url: `/api/wg-devices/${target.id}`, headers: auth() });
    expect(res.statusCode).toBe(204);
    const row = await prisma.wgDevice.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.revokedAt).not.toBeNull();
    expect(row.bytesOut).toBe(42n);
    expect(await prisma.amneziawgPeer.count({ where: { deviceId: target.id } })).toBe(0);
    await new Promise((r) => setImmediate(r));
    expect(heard).toEqual([{ userId, reason: 'revoked' }]);

    // Again: idempotent, no second announcement.
    expect((await app.inject({ method: 'DELETE', url: `/api/wg-devices/${target.id}`, headers: auth() })).statusCode).toBe(204);
    await new Promise((r) => setImmediate(r));
    expect(heard).toHaveLength(1);

    const list = JSON.parse((await app.inject({ method: 'GET', url: `/api/users/${userId}/wg-devices`, headers: auth() })).body).devices;
    expect(list.map((d: { id: string }) => d.id)).toEqual([devices[0]!.id, devices[2]!.id]);
    expect(list.map((d: { index: number }) => d.index)).toEqual([1, 2]);
  });

  it('the replacement comes at the next count and never reuses the revoked key; no way past the count', async () => {
    const { userId, devices } = await userWithDevices('replace', 3);
    await app.inject({ method: 'DELETE', url: `/api/wg-devices/${devices[0]!.id}`, headers: auth() });
    const { devices: after, issued } = await ensureDevices(userId, 3);
    expect(issued).toBe(1);
    expect(after).toHaveLength(3);
    expect(after.map((d) => d.id)).not.toContain(devices[0]!.id);
    expect(after.map((d) => d.publicKey)).not.toContain(devices[0]!.publicKey);
    expect((await ensureDevices(userId, 3)).issued).toBe(0);
  });

  it('404 for an unknown device, 400 for a malformed id', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/api/wg-devices/00000000-0000-4000-8000-000000000000', headers: auth() })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/wg-devices/nope', headers: auth() })).statusCode).toBeGreaterThanOrEqual(400);
  });
});
