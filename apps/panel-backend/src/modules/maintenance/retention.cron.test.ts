import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { ADMIN_AUDIT_RETENTION_DAYS, DELETED_USER_RETENTION_DAYS, HWID_DEVICE_RETENTION_DAYS } from '@iceslab/shared';
import { pruneHistory } from './retention.cron.js';
import { sourceIdSha256 } from '../users/erased-sources.js';
import { createUser, SourceIdErasedError } from '../users/users.service.js';
import { CreateUserSchema } from '../users/users.schemas.js';

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

/**
 * The tombstone (ARCH 26.10): an imported user leaves the sha256 of their
 * source id and nothing else, and the same source id is refused afterwards.
 * Source ids here are random and the table is cleared by this file itself
 * (cleanDatabase does not list it), so nothing leaks into another file.
 */
describe('the tombstone of an erased imported user (A-268)', () => {
  const sid = () => `rw-${randomUUID()}`;
  beforeEach(async () => {
    await prisma.erasedUserSource.deleteMany({});
  });

  async function imported(sourceId: string, deletedAt: Date | null): Promise<string> {
    const id = await user(deletedAt);
    await prisma.user.update({ where: { id }, data: { sourceId } });
    return id;
  }

  it('erasing an imported user keeps the hash of the source id, never the id itself', async () => {
    const sourceId = sid();
    await imported(sourceId, daysAgo(DELETED_USER_RETENTION_DAYS + 1));
    await pruneHistory();
    const rows = await prisma.erasedUserSource.findMany();
    expect(rows.map((r) => r.sourceIdSha256)).toEqual([sourceIdSha256(sourceId)]);
    const raw = JSON.stringify(await prisma.$queryRawUnsafe('SELECT * FROM erased_user_sources'));
    expect(raw).not.toContain(sourceId);
  });

  it('a user created by hand leaves no tombstone', async () => {
    await user(daysAgo(DELETED_USER_RETENTION_DAYS + 1));
    expect((await pruneHistory()).deletedUsers).toBe(1);
    expect(await prisma.erasedUserSource.count()).toBe(0);
  });

  it('the same source id is refused afterwards with SOURCE_ID_ERASED, and a user without one is created', async () => {
    const sourceId = sid();
    await imported(sourceId, daysAgo(DELETED_USER_RETENTION_DAYS + 1));
    await pruneHistory();

    const again = createUser(CreateUserSchema.parse({ username: 'reimported', sourceId }));
    await expect(again).rejects.toBeInstanceOf(SourceIdErasedError);
    const fresh = await createUser(CreateUserSchema.parse({ username: 'reimported' }));
    expect(fresh.id).toBeTruthy();
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

// f16-23 part 2: the history tables on their own windows, the report, the sweep
// of single-use install tokens. A retention bug does not announce itself: the
// job reports a count, the count looks plausible, and what is gone is gone, so
// these stand on both sides of each boundary instead of checking "something was
// deleted".
async function node(): Promise<string> {
  seq += 1;
  const n = await prisma.node.create({
    data: { name: `rt-n-${seq}`, address: `rt-n-${seq}.test:1337`, heartbeatSecret: Buffer.alloc(32) },
  });
  return n.id;
}

/** One row in each of the four history tables, all aged the same. */
async function seedHistory(userId: string, nodeId: string, age: number): Promise<void> {
  await prisma.subscriptionRequestHistory.create({ data: { userId, requestedAt: daysAgo(age) } });
  await prisma.nodeUserUsageHistory.create({ data: { nodeId, userId, date: daysAgo(age), bytesIn: 1n, bytesOut: 1n } });
  await prisma.nodeUsageHistory.create({ data: { nodeId, hour: daysAgo(age), downloadBytes: 1n, uploadBytes: 1n } });
  await prisma.subscriptionEvent.create({ data: { userId, eventType: 'created', createdAt: daysAgo(age) } });
}

const historyCounts = async () => ({
  subscriptionRequests: await prisma.subscriptionRequestHistory.count(),
  nodeUserUsage: await prisma.nodeUserUsageHistory.count(),
  nodeUsage: await prisma.nodeUsageHistory.count(),
  subscriptionEvents: await prisma.subscriptionEvent.count(),
});

describe('each history table is pruned on its own window', () => {
  // 200 days is past the 90-day poll window and the 180-day usage/event
  // windows, well inside the 800-day node-usage one (the dashboard reads up to
  // ~24 months back). Pruning on a neighbour's window loses data on one side or
  // leaves a table unbounded on the other.
  it('drops the 200-day-old rows of three tables and keeps node_usage_history', async () => {
    const u = await user(null);
    const n = await node();
    await seedHistory(u, n, 200);

    await pruneHistory();

    expect(await historyCounts()).toEqual({ subscriptionRequests: 0, nodeUserUsage: 0, nodeUsage: 1, subscriptionEvents: 0 });
  });

  it('leaves everything alone when nothing is old enough', async () => {
    const u = await user(null);
    const n = await node();
    await seedHistory(u, n, 30);

    const r = await pruneHistory();

    expect(await historyCounts()).toEqual({ subscriptionRequests: 1, nodeUserUsage: 1, nodeUsage: 1, subscriptionEvents: 1 });
    expect(r).toMatchObject({ subscriptionRequests: 0, nodeUserUsage: 0, nodeUsage: 0, subscriptionEvents: 0 });
  });

  // One day either side of the boundary, not the exact instant:
  // node_user_usage_history.date is a DATE column, so an exact-cutoff comparison
  // would measure Postgres's truncation, not the rule.
  it('keeps the day inside each window and drops the day outside it', async () => {
    const u = await user(null);
    const n = await node();
    await prisma.subscriptionRequestHistory.create({ data: { userId: u, requestedAt: daysAgo(89) } });
    await prisma.subscriptionRequestHistory.create({ data: { userId: u, requestedAt: daysAgo(91) } });
    await prisma.subscriptionEvent.create({ data: { userId: u, eventType: 'inside', createdAt: daysAgo(179) } });
    await prisma.subscriptionEvent.create({ data: { userId: u, eventType: 'outside', createdAt: daysAgo(181) } });
    await prisma.nodeUsageHistory.create({ data: { nodeId: n, hour: daysAgo(799) } });
    await prisma.nodeUsageHistory.create({ data: { nodeId: n, hour: daysAgo(801) } });
    await prisma.nodeUserUsageHistory.create({ data: { nodeId: n, userId: u, date: daysAgo(179) } });
    await prisma.nodeUserUsageHistory.create({ data: { nodeId: n, userId: u, date: daysAgo(181) } });

    await pruneHistory();

    const polls = await prisma.subscriptionRequestHistory.findMany();
    expect(polls, 'the 89-day-old poll is inside the 90-day window').toHaveLength(1);
    expect(polls[0]!.requestedAt.getTime()).toBeGreaterThan(Date.now() - 90 * DAY);
    expect((await prisma.subscriptionEvent.findMany()).map((e) => e.eventType)).toEqual(['inside']);
    const usage = await prisma.nodeUsageHistory.findMany();
    expect(usage).toHaveLength(1);
    expect(usage[0]!.hour.getTime()).toBeGreaterThan(Date.now() - 800 * DAY);
    const perUser = await prisma.nodeUserUsageHistory.findMany();
    expect(perUser).toHaveLength(1);
    expect(perUser[0]!.date.getTime()).toBeGreaterThan(Date.now() - 180 * DAY);
  });
});

describe('the admin audit window', () => {
  it('drops an audit row past the shared constant and keeps one inside it', async () => {
    const row = (at: Date, label: string) => ({
      at,
      actorKind: 'admin',
      actorLabel: 'a',
      action: 'x',
      targetKind: 'user',
      targetLabel: label,
      outcome: 'ok',
    });
    await prisma.adminAuditEvent.create({ data: row(daysAgo(ADMIN_AUDIT_RETENTION_DAYS + 1), 'old') });
    await prisma.adminAuditEvent.create({ data: row(daysAgo(ADMIN_AUDIT_RETENTION_DAYS - 1), 'recent') });

    const r = await pruneHistory();

    expect(r.adminAudit).toBe(1);
    expect((await prisma.adminAuditEvent.findMany()).map((e) => e.targetLabel)).toEqual(['recent']);
  });
});

describe('the counts it reports are the rows it removed', () => {
  it('reports each table separately', async () => {
    const u = await user(null);
    const n = await node();
    for (const age of [100, 120, 140]) {
      await prisma.subscriptionRequestHistory.create({ data: { userId: u, requestedAt: daysAgo(age) } });
    }
    await prisma.subscriptionEvent.create({ data: { userId: u, eventType: 'old', createdAt: daysAgo(400) } });
    await prisma.nodeUsageHistory.create({ data: { nodeId: n, hour: daysAgo(900) } });

    const r = await pruneHistory();

    // Named per table: a summed result would hide whether "1400 deleted" was
    // polls or a year of dashboard history.
    expect(r.subscriptionRequests).toBe(3);
    expect(r.subscriptionEvents).toBe(1);
    expect(r.nodeUsage).toBe(1);
    expect(r.nodeUserUsage).toBe(0);
    expect(r.bootstrapTokens).toBe(0);
    expect(r.deletedUsers).toBe(0);
    expect(r.hwidDevices).toBe(0);
    expect(r.adminAudit).toBe(0);
  });
});

describe('single-use bootstrap tokens are swept with the history', () => {
  it('removes expired and consumed tokens and keeps a live one', async () => {
    const nodeId = await node();
    await prisma.nodeBootstrapToken.create({ data: { nodeId, token: 'expired-token', expiresAt: daysAgo(1) } });
    await prisma.nodeBootstrapToken.create({
      data: { nodeId, token: 'consumed-token', expiresAt: new Date(Date.now() + DAY), consumedAt: new Date() },
    });
    await prisma.nodeBootstrapToken.create({ data: { nodeId, token: 'live-token', expiresAt: new Date(Date.now() + DAY) } });

    const r = await pruneHistory();

    expect(r.bootstrapTokens).toBe(2);
    expect((await prisma.nodeBootstrapToken.findMany()).map((t) => t.token)).toEqual(['live-token']);
  });
});
