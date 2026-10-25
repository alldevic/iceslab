import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { DELETED_USER_RETENTION_DAYS, HWID_DEVICE_RETENTION_DAYS } from '@iceslab/shared';
import { pruneHistory } from './retention.cron.js';

/**
 * A-268 and A-269 (owner, 26.10): a deleted user is erased with everything
 * theirs after 30 days, and a device unseen for 90 days is forgotten.
 */
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
let seq = 0;

async function user(deletedAt: Date | null): Promise<string> {
  seq += 1;
  const u = await prisma.user.create({
    data: {
      shortId: `rt${seq}${randomBytes(3).toString('hex')}`,
      username: `rt_${seq}`,
      subscriptionToken: randomBytes(16).toString('hex'),
      hysteriaPassword: 'h',
      amneziawgPrivateKey: 'a',
      amneziawgPublicKey: 'b',
      naivePassword: 'n',
      xrayUuid: randomUUID(),
      deletedAt,
    },
    select: { id: true },
  });
  return u.id;
}

/** What a user leaves behind: traffic, a device, a poll, a stats snapshot. */
async function withRows(userId: string): Promise<void> {
  await prisma.userTraffic.create({ data: { userId } });
  await prisma.hwidUserDevice.create({ data: { userId, hwid: `hw-${userId}` } });
  await prisma.subscriptionRequestHistory.create({ data: { userId, requestIp: '10.0.0.1', userAgent: 'x' } });
  await prisma.nodeUserTrafficSnapshot.create({ data: { nodeId: randomUUID(), userId, cumIn: 1n, cumOut: 1n } });
}

const rowsOf = async (userId: string) => ({
  user: await prisma.user.count({ where: { id: userId } }),
  traffic: await prisma.userTraffic.count({ where: { userId } }),
  devices: await prisma.hwidUserDevice.count({ where: { userId } }),
  polls: await prisma.subscriptionRequestHistory.count({ where: { userId } }),
  snapshots: await prisma.nodeUserTrafficSnapshot.count({ where: { userId } }),
});

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('the deleted user window (A-268)', () => {
  it('erases a user deleted 31 days ago with everything theirs, and keeps one deleted 29 days ago', async () => {
    expect(DELETED_USER_RETENTION_DAYS).toBe(30);
    const gone = await user(daysAgo(DELETED_USER_RETENTION_DAYS + 1));
    const kept = await user(daysAgo(DELETED_USER_RETENTION_DAYS - 1));
    const alive = await user(null);
    for (const u of [gone, kept, alive]) await withRows(u);

    const r = await pruneHistory();
    expect(r.deletedUsers).toBe(1);
    // The snapshot has no foreign key and is deleted by hand; the rest cascade.
    expect(await rowsOf(gone)).toEqual({ user: 0, traffic: 0, devices: 0, polls: 0, snapshots: 0 });
    expect(await rowsOf(kept)).toEqual({ user: 1, traffic: 1, devices: 1, polls: 1, snapshots: 1 });
    expect(await rowsOf(alive)).toEqual({ user: 1, traffic: 1, devices: 1, polls: 1, snapshots: 1 });
  });

  it('a second run the same day erases nothing', async () => {
    await user(daysAgo(40));
    expect((await pruneHistory()).deletedUsers).toBe(1);
    expect((await pruneHistory()).deletedUsers).toBe(0);
  });
});

describe('the device window (A-269)', () => {
  it('forgets a device unseen for 91 days and keeps one seen 89 days ago', async () => {
    expect(HWID_DEVICE_RETENTION_DAYS).toBe(90);
    const u = await user(null);
    await prisma.hwidUserDevice.create({ data: { userId: u, hwid: 'old', lastSeenAt: daysAgo(91) } });
    await prisma.hwidUserDevice.create({ data: { userId: u, hwid: 'recent', lastSeenAt: daysAgo(89) } });

    const r = await pruneHistory();
    expect(r.hwidDevices).toBe(1);
    const left = await prisma.hwidUserDevice.findMany({ where: { userId: u }, select: { hwid: true } });
    expect(left.map((d) => d.hwid)).toEqual(['recent']);
  });
});
