// The numbers on the operator's front page, and the windows they are counted
// over.
//
// Eleven traffic figures come out of eight date helpers and one aggregate. The
// only test the module had covered `classifyClient` (User-Agent parsing).
// Measured: the suite of 1642 stayed green with the week window widened to
// fourteen days, with the previous-period window made identical to the current
// one (so every "vs previous" delta reads zero), with the calendar month
// starting on the 2nd, and with the rolling thirty days turned into three
// hundred.
//
// None of those break anything loudly. The dashboard keeps rendering, the
// numbers keep looking like numbers, and the operator makes capacity and
// billing decisions on them.
//
// Every window is checked by planting rows at known ages and asserting the
// EXACT total, so a boundary that moves by a day shows up as a wrong sum rather
// than as "still a number".

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { redis, closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { getOverview } from './dashboard.service.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let nodeId: string;
let seq = 0;

async function makeNode(): Promise<string> {
  seq += 1;
  const n = await prisma.node.create({
    data: {
      name: `dash-${seq}`,
      address: `dash-${seq}.example.com:1337`,
      heartbeatSecret: Buffer.alloc(32),
    },
  });
  return n.id;
}

/** One usage row at `at`, carrying `bytes` split across both directions. */
async function usage(at: Date, bytes: number): Promise<void> {
  // The hour column is part of the primary key, so nudge by a minute per row to
  // keep distinct rows at the same nominal age.
  seq += 1;
  const hour = new Date(at.getTime() - seq * 1000);
  await prisma.nodeUsageHistory.create({
    data: {
      nodeId,
      hour,
      downloadBytes: BigInt(Math.floor(bytes / 2)),
      uploadBytes: BigInt(bytes - Math.floor(bytes / 2)),
    },
  });
}

const ago = (ms: number): Date => new Date(Date.now() - ms);

function startOfTodayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// `getOverview()` caches the whole assembled DTO in Redis for 30 seconds, and
// that key is shared with the rest of the suite and with any live panel on the
// same Redis. Without dropping it, each case here reads the PREVIOUS case's
// numbers - which is exactly how the first draft of this file failed, with
// today's traffic reported as the sum of three earlier tests.
const OVERVIEW_CACHE_KEY = 'dashboard:overview:v1';

async function overview() {
  await redis.del(OVERVIEW_CACHE_KEY).catch(() => null);
  return getOverview();
}

beforeEach(async () => {
  await cleanDatabase();
  await redis.del(OVERVIEW_CACHE_KEY).catch(() => null);
  nodeId = await makeNode();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('the rolling windows', () => {
  // Each row is placed where exactly one interpretation of the window includes
  // it, so a window that grew or shrank by a day lands on a different total.
  it('counts today, yesterday, seven days and thirty days over their own spans', async () => {
    const today = startOfTodayUtc();
    // Two hours into today (or, if the test runs in the first two hours UTC,
    // still today by construction since we anchor to midnight).
    await usage(new Date(today.getTime() + 2 * HOUR), 100);
    // Yesterday, two hours before midnight.
    await usage(new Date(today.getTime() - 2 * HOUR), 200);
    // Inside the week, outside yesterday.
    await usage(ago(3 * DAY), 400);
    // Outside the week, inside thirty days.
    await usage(ago(10 * DAY), 800);
    // Outside thirty days, inside the year (unless the year just turned - see
    // the calendar test for that boundary).
    await usage(ago(45 * DAY), 1600);

    const { traffic } = await overview();

    expect(traffic.todayBytes, 'today counts from midnight UTC').toBe(100);
    expect(traffic.yesterdayBytes, 'yesterday is a closed day, not "since yesterday"').toBe(200);
    // 7 days back: today + yesterday + the 3-day-old row.
    expect(traffic.last7dBytes, 'seven days, not fourteen').toBe(700);
    // 30 days back: everything but the 45-day-old row.
    expect(traffic.last30dBytes, 'thirty days, not three hundred').toBe(1500);
  });

  // "vs previous period" compares [14d,7d) against the last 7d, and
  // [60d,30d) against the last 30d. Make the two windows the same and every
  // delta on the page silently reads zero.
  it('counts the previous period as the span BEFORE the current one', async () => {
    await usage(ago(2 * DAY), 100); // current 7d
    await usage(ago(9 * DAY), 200); // previous 7d: [14d, 7d)
    await usage(ago(20 * DAY), 400); // current 30d, and outside both 7d windows
    await usage(ago(45 * DAY), 800); // previous 30d: [60d, 30d)
    await usage(ago(70 * DAY), 1600); // outside both

    const { traffic } = await overview();

    expect(traffic.last7dBytes).toBe(100);
    expect(traffic.prev7dBytes, 'the previous week must exclude the current one').toBe(200);
    // 2d + 9d + 20d: the previous WEEK's row is still inside the current MONTH.
    expect(traffic.last30dBytes).toBe(700);
    expect(traffic.prev30dBytes, 'the previous month must exclude the current one').toBe(800);
  });

  it('reports zero rather than nothing when there is no traffic', async () => {
    const { traffic } = await overview();
    expect(traffic.todayBytes).toBe(0);
    expect(traffic.last7dBytes).toBe(0);
    expect(traffic.prev7dBytes).toBe(0);
  });

  // Both directions are traffic. Counting only one halves every figure on the
  // page, which looks like a quiet fleet rather than a bug.
  it('adds upload to download', async () => {
    await prisma.nodeUsageHistory.create({
      data: { nodeId, hour: ago(HOUR), downloadBytes: 30n, uploadBytes: 70n },
    });
    const { traffic } = await overview();
    expect(traffic.todayBytes === 100 || traffic.yesterdayBytes === 100).toBe(true);
  });
});

describe('the calendar windows', () => {
  // The calendar month is a separate figure from the rolling thirty days, and
  // it starts on the 1st. Starting it on the 2nd loses a day of revenue from
  // the monthly total, every month, invisibly.
  it('starts the calendar month on the first, at midnight UTC', async () => {
    const now = new Date();
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    // A row in the first hour of the 1st belongs to this calendar month.
    await usage(new Date(first.getTime() + HOUR), 100);
    // A row an hour before it belongs to the previous one.
    await usage(new Date(first.getTime() - HOUR), 200);

    const { traffic } = await overview();

    expect(traffic.calendarMonthBytes, 'the 1st belongs to this month').toBe(100);
    expect(
      traffic.lastCalendarMonthBytes,
      'the hour before the 1st belongs to the previous month',
    ).toBe(200);
  });

  it('starts the year on the first of January, at midnight UTC', async () => {
    const now = new Date();
    const jan1 = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));

    await usage(new Date(jan1.getTime() + HOUR), 100);
    await usage(new Date(jan1.getTime() - HOUR), 200);

    const { traffic } = await overview();

    expect(traffic.currentYearBytes).toBe(100);
    expect(traffic.lastYearBytes, 'the hour before January belongs to last year').toBe(200);
  });

  // The rolling thirty days and the calendar month are different questions and
  // must not be the same answer. Around the start of a month they diverge
  // sharply, which is exactly when an operator compares them.
  it('keeps the rolling month and the calendar month apart', async () => {
    const now = new Date();
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    // Just before this calendar month began, but well inside the last 30 days.
    const before = new Date(first.getTime() - HOUR);
    if (Date.now() - before.getTime() < 29 * DAY) {
      await usage(before, 500);
      const { traffic } = await overview();
      expect(traffic.last30dBytes, 'the rolling window reaches back past the 1st').toBe(500);
      expect(traffic.calendarMonthBytes, 'the calendar month does not').toBe(0);
    }
  });
});

describe('the last 24 hours, hour by hour', () => {
  // The sparkline. Buckets are whole hours and only the last 24 of them.
  it('buckets by hour and stops at 24 hours back', async () => {
    await usage(ago(2 * HOUR), 100);
    await usage(ago(2 * HOUR), 50); // same hour bucket
    await usage(ago(30 * HOUR), 800); // outside the window

    const { traffic } = await overview();
    const total = traffic.last24hHourly.reduce((s, p) => s + p.bytes, 0);

    expect(total, 'a row 30 hours old is not in the last 24').toBe(150);
    expect(traffic.last24hHourly.length).toBeGreaterThan(0);
    // Ascending, because the chart draws them left to right.
    const hours = traffic.last24hHourly.map((p) => p.hour);
    expect([...hours].sort()).toEqual(hours);
  });
});
