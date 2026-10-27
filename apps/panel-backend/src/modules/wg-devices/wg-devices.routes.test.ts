import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { ensureDevices } from './wg-devices.service.js';

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

async function userWithDevices(n: number) {
  const res = await app.inject({ method: 'POST', url: '/api/users', headers: auth(), payload: { username: 'alice' } });
  const id = JSON.parse(res.body).id as string;
  return { id, devices: await ensureDevices(id, n) };
}

describe('GET /api/users/:userId/wg-devices', () => {
  it('lists every device with what the nodes measured, revoked ones kept, keys never', async () => {
    const { id, devices } = await userWithDevices(3);
    // Past 2^53: a lifetime of bytes is not a safe JSON number.
    await prisma.wgDevice.update({ where: { id: devices[0]!.id }, data: { bytesIn: 9007199254740993n, lastSeenAt: new Date() } });
    const del = await app.inject({ method: 'DELETE', url: `/api/wg-devices/${devices[1]!.id}`, headers: auth() });
    expect(del.statusCode).toBe(204);

    const res = await app.inject({ method: 'GET', url: `/api/users/${id}/wg-devices`, headers: auth() });
    expect(res.statusCode).toBe(200);
    const list = JSON.parse(res.body).devices as Record<string, unknown>[];
    expect(list.map((d) => d.id)).toEqual(devices.map((d) => d.id));
    expect(list[0]).toMatchObject({ index: 1, bytesIn: '9007199254740993', bytesOut: '0', revokedAt: null });
    expect(list[1]).toMatchObject({ index: null, revokedAt: expect.any(String) });
    // The device after a revoked one moves up: its number is the one ?device= takes.
    expect(list[2]).toMatchObject({ index: 2 });
    expect(res.body).not.toContain(devices[0]!.privateKey);
    expect(res.body).not.toContain(devices[0]!.presharedKey!);
  });

  it('needs auth', async () => {
    const { id } = await userWithDevices(1);
    expect((await app.inject({ method: 'GET', url: `/api/users/${id}/wg-devices` })).statusCode).toBe(401);
  });
});

describe('DELETE /api/wg-devices/:id', () => {
  it('404 for no such device, 204 again for one already revoked', async () => {
    const { devices } = await userWithDevices(1);
    const missing = await app.inject({ method: 'DELETE', url: '/api/wg-devices/00000000-0000-4000-8000-000000000000', headers: auth() });
    expect(missing.statusCode).toBe(404);
    const url = `/api/wg-devices/${devices[0]!.id}`;
    expect((await app.inject({ method: 'DELETE', url, headers: auth() })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url, headers: auth() })).statusCode).toBe(204);
  });
});
