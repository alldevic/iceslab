import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { generateUserCredentials } from '../../lib/auth/credentials.js';
import { enforceHwid } from './hwid.service.js';

/** f01-05: what the client says about its device is stored with the row, once. */

let userId: string;

beforeEach(async () => {
  await cleanDatabase();
  const u = await prisma.user.create({
    data: { username: `hwidmeta_${Date.now()}`, ...generateUserCredentials() },
  });
  userId = u.id;
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

const row = (hwid: string) => prisma.hwidUserDevice.findUniqueOrThrow({ where: { userId_hwid: { userId, hwid } } });

const META = { platform: 'Android', osVersion: '14', deviceModel: 'Pixel 8', userAgent: 'Happ/1.0' };

describe('enforceHwid device metadata', () => {
  it('stores the four fields when the device first appears', async () => {
    await enforceHwid(userId, 'd1', 3, META);
    expect(await row('d1')).toMatchObject(META);
  });

  it('stores them on the audit-only path (no limit) too', async () => {
    await enforceHwid(userId, 'd1', null, META);
    expect(await row('d1')).toMatchObject(META);
  });

  it('does not overwrite them on a repeat visit, nor fill a header-less first row', async () => {
    await enforceHwid(userId, 'd1', 3, META);
    await enforceHwid(userId, 'd1', 3, { platform: 'iOS', osVersion: '17', deviceModel: 'iPhone', userAgent: 'Other/2' });
    expect(await row('d1')).toMatchObject(META);

    await enforceHwid(userId, 'd2', 3);
    await enforceHwid(userId, 'd2', 3, META);
    expect(await row('d2')).toMatchObject({ platform: null, osVersion: null, deviceModel: null, userAgent: null });
  });

  it('cuts long values to the column and leaves empty ones NULL', async () => {
    await enforceHwid(userId, 'd1', 3, {
      platform: 'p'.repeat(100),
      osVersion: '   ',
      deviceModel: 'm'.repeat(200),
      userAgent: 'u'.repeat(900),
    });
    const r = await row('d1');
    expect(r.platform).toHaveLength(64);
    expect(r.osVersion).toBeNull();
    expect(r.deviceModel).toHaveLength(128);
    expect(r.userAgent).toHaveLength(512);
  });
});
