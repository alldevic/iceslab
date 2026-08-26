// The Insights page: who polls the subscription URL, with what, and how many
// devices sit behind one account.
//
// Three hand-written SQL queries and a window the admin chooses, and nothing
// tested any of it. Measured: the suite of 1642 stayed green with the window
// pinned to the epoch, i.e. with the "last N days" selector counting everything
// ever recorded. The page still renders, the numbers still look like numbers,
// and the operator reads sharing and client-mix off them.
//
// `clients.test.ts` next door covers the User-Agent classifier itself; this is
// about the aggregation around it.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { generateUserCredentials } from '../../lib/credentials.js';
import { getInsights } from './insights.service.js';

const DAY = 24 * 60 * 60 * 1000;
let seq = 0;

async function makeUser(over: Record<string, unknown> = {}): Promise<string> {
  seq += 1;
  const c = generateUserCredentials();
  const u = await prisma.user.create({
    data: {
      username: `insight_${seq}`,
      shortId: c.shortId,
      subscriptionToken: c.subscriptionToken,
      hysteriaPassword: c.hysteriaPassword,
      naivePassword: c.naivePassword,
      xrayUuid: c.xrayUuid,
      amneziawgPrivateKey: c.amneziawgPrivateKey,
      amneziawgPublicKey: c.amneziawgPublicKey,
      ...over,
    },
  });
  return u.id;
}

async function poll(userId: string, at: Date, userAgent: string): Promise<void> {
  await prisma.subscriptionRequestHistory.create({
    data: { userId, requestedAt: at, userAgent },
  });
}

const ago = (ms: number): Date => new Date(Date.now() - ms);

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('the window the admin picked', () => {
  // The whole point of the selector. A window that silently counts everything
  // makes "requests in the last 7 days" a lifetime total, and the client mix a
  // history lesson rather than a picture of now.
  it('counts only requests inside it', async () => {
    const user = await makeUser();
    await poll(user, ago(1 * DAY), 'Happ/2.0');
    await poll(user, ago(3 * DAY), 'Happ/2.0');
    await poll(user, ago(10 * DAY), 'Happ/2.0');
    await poll(user, ago(40 * DAY), 'Happ/2.0');

    expect((await getInsights(7)).subRequests.total, 'seven days').toBe(2);
    expect((await getInsights(30)).subRequests.total, 'thirty days').toBe(3);
    expect((await getInsights(90)).subRequests.total, 'ninety days').toBe(4);
    expect((await getInsights(1)).subRequests.total, 'one day').toBe(0);
  });

  it('defaults to seven days when the caller names none', async () => {
    const user = await makeUser();
    await poll(user, ago(3 * DAY), 'Happ/2.0');
    await poll(user, ago(10 * DAY), 'Happ/2.0');

    const got = await getInsights(undefined);
    expect(got.windowDays).toBe(7);
    expect(got.subRequests.total).toBe(1);
  });

  // The clamp is what keeps a hand-edited query string from asking for a scan
  // of the whole table - or for nothing at all.
  it('clamps what it was asked for, and reports what it used', async () => {
    expect((await getInsights(0)).windowDays, 'below one becomes one').toBe(1);
    expect((await getInsights(-5)).windowDays).toBe(1);
    expect((await getInsights(9999)).windowDays, 'above the cap becomes the cap').toBe(90);
    expect((await getInsights(7.9)).windowDays, 'fractional days are floored').toBe(7);
    expect((await getInsights(Number.NaN)).windowDays, 'garbage falls back to the default').toBe(7);
  });
});

describe('what the numbers count', () => {
  // Requests and people are different questions. A single subscriber polling
  // every few minutes from three devices produces hundreds of requests, and an
  // operator reading that as hundreds of users would size the fleet for a crowd
  // that is not there.
  it('separates request count from distinct users', async () => {
    const a = await makeUser();
    const b = await makeUser();
    for (let i = 0; i < 5; i += 1) await poll(a, ago(i * 1000), 'Happ/2.0');
    await poll(b, ago(1000), 'Happ/2.0');

    const { subRequests } = await getInsights(7);
    expect(subRequests.total).toBe(6);
    expect(subRequests.uniqueUsers, 'six requests came from two people').toBe(2);
  });

  it('groups requests by client family, biggest first', async () => {
    const user = await makeUser();
    for (let i = 0; i < 3; i += 1) await poll(user, ago(i * 1000), 'Happ/2.0');
    await poll(user, ago(4000), 'v2rayNG/1.9.0');

    const { byClient } = (await getInsights(7)).subRequests;
    expect(byClient.length).toBeGreaterThanOrEqual(2);
    expect(byClient[0]!.count, 'the largest family comes first').toBe(3);
    expect(byClient[0]!.count).toBeGreaterThanOrEqual(byClient[1]!.count);
    expect(byClient.reduce((s, c) => s + c.count, 0), 'every request lands in a family').toBe(4);
  });

  // Always 24 buckets so the frontend can draw a fixed row: a sparse map would
  // make the chart's bars move around as traffic shifts.
  it('always returns 24 hour buckets, indexed by UTC hour', async () => {
    const user = await makeUser();
    // A recent day at 13:30 UTC, so the row is inside the window whatever the
    // local timezone of whoever runs this is.
    const recent = new Date(Date.now() - 2 * DAY);
    recent.setUTCHours(13, 30, 0, 0);
    await poll(user, recent, 'Happ/2.0');

    const { byHourUtc } = (await getInsights(7)).subRequests;
    expect(byHourUtc).toHaveLength(24);
    expect(byHourUtc[13], 'the 13:30 UTC request belongs to bucket 13').toBe(1);
    expect(byHourUtc.reduce((s, n) => s + n, 0)).toBe(1);
  });

  it('answers zeroes on an empty panel rather than failing', async () => {
    const { subRequests, hwid } = await getInsights(7);
    expect(subRequests.total).toBe(0);
    expect(subRequests.uniqueUsers).toBe(0);
    expect(subRequests.byClient).toEqual([]);
    expect(subRequests.byHourUtc).toHaveLength(24);
    expect(hwid.totalDevices).toBe(0);
    expect(hwid.avgDevicesPerUser, 'no devices is zero, not a division by zero').toBe(0);
  });
});

describe('the device histogram', () => {
  async function device(userId: string, hwid: string): Promise<void> {
    await prisma.hwidUserDevice.create({
      data: { userId, hwid, userAgent: 'Happ/2.0' },
    });
  }

  // This is the sharing signal: one account, many devices.
  it('counts devices, the people behind them, and the average', async () => {
    const solo = await makeUser();
    const sharer = await makeUser();
    await device(solo, 'device-a');
    await device(sharer, 'device-b');
    await device(sharer, 'device-c');
    await device(sharer, 'device-d');

    const { hwid } = await getInsights(7);
    expect(hwid.totalDevices).toBe(4);
    expect(hwid.usersWithDevices, 'a user with three devices is one user').toBe(2);
    expect(hwid.avgDevicesPerUser).toBe(2);
  });

  it('buckets users by device count and folds the tail into 5+', async () => {
    const one = await makeUser();
    const three = await makeUser();
    const many = await makeUser();
    await device(one, 'a1');
    for (const h of ['b1', 'b2', 'b3']) await device(three, h);
    for (const h of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']) await device(many, h);

    const { distribution } = (await getInsights(7)).hwid;
    const byBucket = Object.fromEntries(distribution.map((d) => [d.bucket, d.users]));
    expect(byBucket['1']).toBe(1);
    expect(byBucket['3']).toBe(1);
    expect(byBucket['5+'], 'six devices folds into the top bucket').toBe(1);
    expect(byBucket['2'] ?? 0).toBe(0);
  });

  // "At or over limit" is the actionable number: the next new device gets a
  // 403. Users with no limit set are not in trouble and must not be counted.
  it('counts only users who have reached a limit they actually have', async () => {
    const capped = await makeUser({ hwidDeviceLimit: 2 });
    const roomy = await makeUser({ hwidDeviceLimit: 5 });
    const unlimited = await makeUser();
    for (const h of ['x1', 'x2']) await device(capped, h);
    for (const h of ['y1', 'y2']) await device(roomy, h);
    for (const h of ['z1', 'z2', 'z3', 'z4']) await device(unlimited, h);

    const { hwid } = await getInsights(7);
    expect(
      hwid.atOrOverLimit,
      'only the capped user is at their limit; the unlimited one cannot be',
    ).toBe(1);
  });
});
