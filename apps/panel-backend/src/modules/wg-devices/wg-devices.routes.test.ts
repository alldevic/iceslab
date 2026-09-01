// The admin's view of a buyer's wg devices, and what revoking one does.
//
// Worth a route test rather than a service test: the two things an operator
// acts on here are numbers the panel did not measure itself (they come off the
// nodes) and a destructive button. Both are easy to get subtly wrong in the
// mapping layer - a BigInt that serialises to something the UI reads as zero,
// a revoke that answers 204 without dropping the peer.

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { generateUserCredentials } from '../../lib/credentials.js';
import { ensureDevices } from './wg-devices.service.js';

let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  await cleanDatabase();
  app = await buildApp();
  token = await registerAndLogin(app);
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

async function seedUser(username: string): Promise<string> {
  const creds = generateUserCredentials();
  const user = await prisma.user.create({
    data: {
      username,
      shortId: creds.shortId,
      subscriptionToken: creds.subscriptionToken,
      hysteriaPassword: creds.hysteriaPassword,
      naivePassword: creds.naivePassword,
      xrayUuid: creds.xrayUuid,
      amneziawgPrivateKey: creds.amneziawgPrivateKey,
      amneziawgPublicKey: creds.amneziawgPublicKey,
    },
  });
  return user.id;
}

describe('GET /api/users/:userId/wg-devices', () => {
  it('reports the traffic the nodes measured, without losing precision', async () => {
    const userId = await seedUser('u1');
    const [device] = await ensureDevices(userId, 1);
    // Past 2^53: BigInt columns exist here because a busy tunnel outgrows a
    // JS number, and JSON.stringify on one throws rather than rounding.
    await prisma.wgDevice.update({
      where: { id: device!.id },
      data: { bytesIn: 9_007_199_254_740_993n, bytesOut: 1n, lastSeenAt: new Date() },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${userId}/wg-devices`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const [row] = JSON.parse(res.body).devices;
    expect(row.bytesIn).toBe('9007199254740993');
    expect(row.lastSeenAt).not.toBeNull();
    expect(row.publicKey).toBe(device!.publicKey);
    // The buyer's private key is theirs; the panel has no reason to show it.
    expect(JSON.stringify(row)).not.toContain(device!.privateKey);
  });

  it('keeps a revoked device in the list, with its history', async () => {
    const userId = await seedUser('u1');
    const devices = await ensureDevices(userId, 2);
    await app.inject({
      method: 'DELETE',
      url: `/api/wg-devices/${devices[0]!.id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${userId}/wg-devices`,
      headers: { authorization: `Bearer ${token}` },
    });
    const rows = JSON.parse(res.body).devices;
    expect(rows).toHaveLength(2);
    expect(rows.find((r: { id: string }) => r.id === devices[0]!.id).revokedAt).not.toBeNull();
  });

  it('needs auth', async () => {
    const userId = await seedUser('u1');
    const res = await app.inject({ method: 'GET', url: `/api/users/${userId}/wg-devices` });
    expect(res.statusCode).toBe(401);
  });
});

describe('DELETE /api/wg-devices/:id', () => {
  it('404s on a device that does not exist, rather than answering 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/wg-devices/00000000-0000-4000-8000-000000000000',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
