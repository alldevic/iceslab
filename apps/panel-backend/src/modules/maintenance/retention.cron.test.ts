// pruneHistory is the one job in the panel whose whole purpose is DELETE, and
// nothing watched it. Measured before writing: the suite of 1513 stayed green
// with the subscription-request window inverted (`lt` turned into `gt`, i.e.
// keep the old rows and delete every recent one) and with node_usage_history
// pruned on the 90-day window instead of its own 800-day one. Both mutants
// destroy live data on the first nightly run and no test noticed either.
//
// A retention bug does not announce itself: the job reports a count, the count
// looks plausible, and what is gone is gone. So these tests stand on both sides
// of each boundary rather than checking that "something was deleted".

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { generateUserCredentials } from '../../lib/credentials.js';
import { pruneHistory } from './retention.cron.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (d: number): Date => new Date(Date.now() - d * DAY_MS);

let seq = 0;

async function makeUser(): Promise<string> {
  seq += 1;
  const c = generateUserCredentials();
  const u = await prisma.user.create({
    data: {
      username: `prune-${seq}`,
      shortId: c.shortId,
      subscriptionToken: c.subscriptionToken,
      hysteriaPassword: c.hysteriaPassword,
      naivePassword: c.naivePassword,
      xrayUuid: c.xrayUuid,
      amneziawgPrivateKey: c.amneziawgPrivateKey,
      amneziawgPublicKey: c.amneziawgPublicKey,
    },
  });
  return u.id;
}

async function makeNode(): Promise<string> {
  seq += 1;
  const n = await prisma.node.create({
    data: {
      name: `prune-n-${seq}`,
      address: `prune-n-${seq}.test:1337`,
      heartbeatSecret: Buffer.alloc(32),
    },
  });
  return n.id;
}

/** One row in each of the four history tables, all aged the same. */
async function seedAllTables(userId: string, nodeId: string, age: number): Promise<void> {
  await prisma.subscriptionRequestHistory.create({
    data: { userId, requestedAt: daysAgo(age) },
  });
  await prisma.nodeUserUsageHistory.create({
    data: { nodeId, userId, date: daysAgo(age), bytesIn: 1n, bytesOut: 1n },
  });
  await prisma.nodeUsageHistory.create({
    data: { nodeId, hour: daysAgo(age), downloadBytes: 1n, uploadBytes: 1n },
  });
  await prisma.subscriptionEvent.create({
    data: { userId, eventType: 'created', createdAt: daysAgo(age) },
  });
}

async function counts(): Promise<Record<string, number>> {
  return {
    subscriptionRequests: await prisma.subscriptionRequestHistory.count(),
    nodeUserUsage: await prisma.nodeUserUsageHistory.count(),
    nodeUsage: await prisma.nodeUsageHistory.count(),
    subscriptionEvents: await prisma.subscriptionEvent.count(),
  };
}

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('each table is pruned on its own window', () => {
  // The windows differ by nearly an order of magnitude on purpose: /sub polls
  // churn one row every few minutes per device, while node_usage_history feeds
  // the dashboard's year-over-year deltas and has to reach ~24 months back.
  // Pruning any of them on a neighbour's window is a silent data loss on one
  // side or an unbounded table on the other - and both mutants compile.
  it('keeps a 200-day-old row that is inside its own window and drops the ones that are not', async () => {
    const userId = await makeUser();
    const nodeId = await makeNode();
    await seedAllTables(userId, nodeId, 200);

    await pruneHistory();

    const left = await counts();
    // 200 days: past the 90-day request window and the 180-day usage/event
    // windows, well inside the 800-day node-usage one.
    expect(left.subscriptionRequests, 'a 200-day-old /sub poll is 110 days past its window').toBe(0);
    expect(left.nodeUserUsage, 'a 200-day-old per-user row is 20 days past its window').toBe(0);
    expect(left.subscriptionEvents, 'a 200-day-old event is 20 days past its window').toBe(0);
    expect(
      left.nodeUsage,
      'node_usage_history keeps 800 days: the dashboard reads up to ~24 months back, ' +
        'and pruning it on a shorter window empties last year from the charts',
    ).toBe(1);
  });

  it('leaves everything alone when nothing is old enough', async () => {
    const userId = await makeUser();
    const nodeId = await makeNode();
    await seedAllTables(userId, nodeId, 30);

    const result = await pruneHistory();

    expect(await counts()).toEqual({
      subscriptionRequests: 1,
      nodeUserUsage: 1,
      nodeUsage: 1,
      subscriptionEvents: 1,
    });
    expect(result).toMatchObject({
      subscriptionRequests: 0,
      nodeUserUsage: 0,
      nodeUsage: 0,
      subscriptionEvents: 0,
    });
  });

  // The boundary is where an off-by-one lives, and an off-by-one here is a day
  // of history nobody asked to lose. Checked one day either side rather than at
  // the exact instant: `node_user_usage_history.date` is a DATE column, so its
  // value is midnight and an exact-cutoff comparison would be measuring
  // Postgres's truncation, not the retention rule.
  it('keeps the day inside the window and drops the day outside it', async () => {
    const userId = await makeUser();
    const nodeId = await makeNode();

    await prisma.subscriptionRequestHistory.create({ data: { userId, requestedAt: daysAgo(89) } });
    await prisma.subscriptionRequestHistory.create({ data: { userId, requestedAt: daysAgo(91) } });
    await prisma.subscriptionEvent.create({
      data: { userId, eventType: 'inside', createdAt: daysAgo(179) },
    });
    await prisma.subscriptionEvent.create({
      data: { userId, eventType: 'outside', createdAt: daysAgo(181) },
    });
    await prisma.nodeUsageHistory.create({ data: { nodeId, hour: daysAgo(799) } });
    await prisma.nodeUsageHistory.create({ data: { nodeId, hour: daysAgo(801) } });

    await pruneHistory();

    const requests = await prisma.subscriptionRequestHistory.findMany();
    expect(requests, 'the 89-day-old poll is inside the 90-day window').toHaveLength(1);
    expect(requests[0]!.requestedAt.getTime()).toBeGreaterThan(Date.now() - 90 * DAY_MS);

    const events = await prisma.subscriptionEvent.findMany();
    expect(events.map((e) => e.eventType)).toEqual(['inside']);

    const usage = await prisma.nodeUsageHistory.findMany();
    expect(usage, 'the 799-day-old hour is inside the 800-day window').toHaveLength(1);
    expect(usage[0]!.hour.getTime()).toBeGreaterThan(Date.now() - 800 * DAY_MS);
  });
});

describe('the counts it reports are the rows it removed', () => {
  it('reports each table separately', async () => {
    const userId = await makeUser();
    const nodeId = await makeNode();
    for (const age of [100, 120, 140]) {
      await prisma.subscriptionRequestHistory.create({ data: { userId, requestedAt: daysAgo(age) } });
    }
    await prisma.subscriptionEvent.create({
      data: { userId, eventType: 'old', createdAt: daysAgo(400) },
    });
    await prisma.nodeUsageHistory.create({ data: { nodeId, hour: daysAgo(900) } });

    const result = await pruneHistory();

    // Named per table: a result that summed them would hide which table a
    // surprising number came from, and an operator reading "1400 deleted" has
    // to know whether that was polls or a year of dashboard history.
    expect(result.subscriptionRequests).toBe(3);
    expect(result.subscriptionEvents).toBe(1);
    expect(result.nodeUsage).toBe(1);
    expect(result.nodeUserUsage).toBe(0);
  });

});

describe('single-use bootstrap tokens are swept with the history', () => {
  // Nothing else cleans these up, so without the daily sweep the table grows
  // forever. Both halves of the condition matter: an expired token is dead, and
  // a consumed one is dead even if it has not expired yet.
  it('removes expired and consumed tokens and keeps a live one', async () => {
    const nodeId = await makeNode();
    await prisma.nodeBootstrapToken.create({
      data: { nodeId, token: 'expired-token', expiresAt: daysAgo(1) },
    });
    await prisma.nodeBootstrapToken.create({
      data: {
        nodeId,
        token: 'consumed-token',
        expiresAt: new Date(Date.now() + DAY_MS),
        consumedAt: new Date(),
      },
    });
    await prisma.nodeBootstrapToken.create({
      data: { nodeId, token: 'live-token', expiresAt: new Date(Date.now() + DAY_MS) },
    });

    const result = await pruneHistory();

    expect(result.bootstrapTokens).toBe(2);
    const left = await prisma.nodeBootstrapToken.findMany();
    expect(
      left.map((t) => t.token),
      'a token that is neither expired nor consumed is still an operator waiting to install a node',
    ).toEqual(['live-token']);
  });
});
