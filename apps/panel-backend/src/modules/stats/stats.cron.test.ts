import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { GetStatsResponse } from '@iceslab/shared';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { NodeTransport } from '../nodes/nodes.transport.js';
import { eventBus } from '../../lib/infra/event-bus.js';
import { pollNodeStats } from './stats.cron.js';

// B3 integration: exercises the bulk `unnest` upsert SQL against a real
// Postgres (the part pure-logic tests can't cover). Needs the test DB stack
// (CI service containers, or the local dev compose). Run:
//   pnpm exec vitest run src/modules/stats/stats.cron.test.ts
//
// Note: createUser eagerly seeds an empty user_traffic row (users.service
// `traffic: { create: {} }`), so every poll hits the ON CONFLICT update path -
// used/lifetime increment from 0, online_at/last_connected_node_id refresh,
// first_connected_at is left as-is (update never sets it). Assertions below
// reflect that actual behaviour, which matches the pre-B3 upsert exactly.

let app: FastifyInstance;
let token: string;

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

const auth = () => ({ authorization: `Bearer ${token}` });

async function createNode(name: string, address: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/nodes', headers: auth(), payload: { name, address } });
  if (res.statusCode !== 201) throw new Error(`createNode failed: ${res.statusCode} ${res.body}`);
  return JSON.parse(res.body).id as string;
}

async function createUser(username: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/users', headers: auth(), payload: { username } });
  if (res.statusCode !== 201) throw new Error(`createUser failed: ${res.statusCode} ${res.body}`);
  return JSON.parse(res.body).id as string;
}

function stats(users: { userId: string; bytesIn: number; bytesOut: number }[]): GetStatsResponse {
  return { users, uptime: 1, totalBytesIn: 0, totalBytesOut: 0 };
}

function mockStats(value: GetStatsResponse) {
  return vi.spyOn(NodeTransport.prototype, 'getStats').mockResolvedValue(value);
}

describe('pollNodeStats bulk upsert (B3, integration)', () => {
  it('increments user_traffic across two polls (ON CONFLICT) and leaves absent users alone', async () => {
    const nodeId = await createNode('eu-1', '10.0.0.1:8443');
    const u1 = await createUser('alice');
    const u2 = await createUser('bob');

    mockStats(stats([
      { userId: u1, bytesIn: 100, bytesOut: 50 },
      { userId: u2, bytesIn: 10, bytesOut: 0 },
    ]));
    const r1 = await pollNodeStats();
    expect(r1.failed).toBe(0);
    expect(r1.ok).toBe(1);

    const t1a = await prisma.userTraffic.findUnique({ where: { userId: u1 } });
    const t1b = await prisma.userTraffic.findUnique({ where: { userId: u2 } });
    expect(t1a?.usedTrafficBytes).toBe(150n);
    expect(t1a?.lifetimeTrafficBytes).toBe(150n);
    expect(t1a?.lastConnectedNodeId).toBe(nodeId);
    expect(t1a?.onlineAt).not.toBeNull(); // update path refreshes online_at
    expect(t1b?.usedTrafficBytes).toBe(10n);

    // Second poll: u1 moves more bytes -> increment (not overwrite); u2 absent
    // from the payload -> untouched.
    vi.restoreAllMocks();
    mockStats(stats([{ userId: u1, bytesIn: 1, bytesOut: 1 }]));
    await pollNodeStats();

    const t2a = await prisma.userTraffic.findUnique({ where: { userId: u1 } });
    const t2b = await prisma.userTraffic.findUnique({ where: { userId: u2 } });
    expect(t2a?.usedTrafficBytes).toBe(152n); // 150 + 2
    expect(t2b?.usedTrafficBytes).toBe(10n); // unchanged
  });

  it('writes and increments per-user daily history and node hourly usage', async () => {
    const nodeId = await createNode('eu-2', '10.0.0.2:8443');
    const u1 = await createUser('carol');

    mockStats(stats([{ userId: u1, bytesIn: 200, bytesOut: 300 }]));
    await pollNodeStats();

    const hist = await prisma.nodeUserUsageHistory.findMany({ where: { userId: u1 } });
    expect(hist).toHaveLength(1);
    expect(hist[0]!.bytesIn).toBe(200n);
    expect(hist[0]!.bytesOut).toBe(300n);
    expect(hist[0]!.nodeId).toBe(nodeId);

    const usage = await prisma.nodeUsageHistory.findMany({ where: { nodeId } });
    expect(usage).toHaveLength(1);
    expect(usage[0]!.uploadBytes).toBe(200n); // raw bytes in
    expect(usage[0]!.downloadBytes).toBe(300n); // raw bytes out

    // Second poll same UTC day -> daily bucket increments via ON CONFLICT, no new row.
    vi.restoreAllMocks();
    mockStats(stats([{ userId: u1, bytesIn: 5, bytesOut: 5 }]));
    await pollNodeStats();
    const hist2 = await prisma.nodeUserUsageHistory.findMany({ where: { userId: u1 } });
    expect(hist2).toHaveLength(1);
    expect(hist2[0]!.bytesIn).toBe(205n);
    expect(hist2[0]!.bytesOut).toBe(305n);
  });

  it('scales per-user billing by the node multiplier; node usage stays raw', async () => {
    const nodeId = await createNode('eu-3', '10.0.0.3:8443');
    await prisma.node.update({ where: { id: nodeId }, data: { consumptionMultiplierTenths: 20 } });
    const u1 = await createUser('dave');

    mockStats(stats([{ userId: u1, bytesIn: 100, bytesOut: 0 }]));
    await pollNodeStats();

    const t = await prisma.userTraffic.findUnique({ where: { userId: u1 } });
    expect(t?.usedTrafficBytes).toBe(200n); // scaled x2

    const usage = await prisma.nodeUsageHistory.findMany({ where: { nodeId } });
    expect(usage[0]!.uploadBytes).toBe(100n); // raw, unscaled
  });

  // A-143: a fractional multiplier and a free node, through the poller.
  it('bills 0.5 of 1001 bytes as 501 (half up) and a free node as 0, node usage raw', async () => {
    const half = await createNode('eu-h', '10.0.0.31:8443');
    await prisma.node.update({ where: { id: half }, data: { consumptionMultiplierTenths: 5 } });
    const u1 = await createUser('half');
    mockStats(stats([{ userId: u1, bytesIn: 1001, bytesOut: 0 }]));
    await pollNodeStats();
    expect((await prisma.userTraffic.findUnique({ where: { userId: u1 } }))?.usedTrafficBytes).toBe(501n);
  });

  it('a free node (0) bills nothing and still records its raw usage', async () => {
    const free = await createNode('eu-f', '10.0.0.32:8443');
    await prisma.node.update({ where: { id: free }, data: { consumptionMultiplierTenths: 0 } });
    const u1 = await createUser('free');
    mockStats(stats([{ userId: u1, bytesIn: 1000, bytesOut: 0 }]));
    await pollNodeStats();
    expect((await prisma.userTraffic.findUnique({ where: { userId: u1 } }))?.usedTrafficBytes).toBe(0n);
    const usage = await prisma.nodeUsageHistory.findMany({ where: { nodeId: free } });
    expect(usage[0]!.uploadBytes).toBe(1000n);
  });

  it('leaves a zero-delta user untouched (no billing, no online flip)', async () => {
    await createNode('eu-4', '10.0.0.4:8443');
    const u1 = await createUser('erin');

    // user-create seeded an empty traffic row; the poll must not move it.
    const before = await prisma.userTraffic.findUnique({ where: { userId: u1 } });
    expect(before?.usedTrafficBytes).toBe(0n);
    expect(before?.onlineAt).toBeNull();

    mockStats(stats([{ userId: u1, bytesIn: 0, bytesOut: 0 }]));
    await pollNodeStats();

    const after = await prisma.userTraffic.findUnique({ where: { userId: u1 } });
    expect(after?.usedTrafficBytes).toBe(0n); // unchanged
    expect(after?.onlineAt).toBeNull(); // non-presence zero-delta -> not touched
    const hist = await prisma.nodeUserUsageHistory.findMany({ where: { userId: u1 } });
    expect(hist).toHaveLength(0);
  });

  // Regression for the prod failure (2026-06-12): a node reported the same user
  // twice in one poll (two inbounds) and the bulk unnest upsert hit Postgres
  // 21000 ("ON CONFLICT DO UPDATE command cannot affect row a second time").
  it('handles a user reported twice in one poll without a conflict error', async () => {
    const nodeId = await createNode('eu-5', '10.0.0.5:8443');
    const u1 = await createUser('frank');

    mockStats(stats([
      { userId: u1, bytesIn: 100, bytesOut: 50 },
      { userId: u1, bytesIn: 20, bytesOut: 5 }, // same user, second inbound
    ]));
    const r = await pollNodeStats();
    expect(r.failed).toBe(0); // previously failed with 21000
    expect(r.ok).toBe(1);

    const t = await prisma.userTraffic.findUnique({ where: { userId: u1 } });
    expect(t?.usedTrafficBytes).toBe(175n); // 150 + 25 aggregated

    const hist = await prisma.nodeUserUsageHistory.findMany({ where: { userId: u1 } });
    expect(hist).toHaveLength(1);
    expect(hist[0]!.bytesIn).toBe(120n);
    expect(hist[0]!.bytesOut).toBe(55n);
    expect(hist[0]!.nodeId).toBe(nodeId);
  });

  // Regression for the mixed cumulative+delta node bug: a node running BOTH a
  // cumulative core (xray, non-destructive read) and a delta core (shadowsocks,
  // statsquery -reset) OR's the response-level `cumulative` flag to true. Before
  // the per-user flag fix, the panel snapshot-deltaed EVERY user, so the delta
  // core's users were double-deltaed to ~zero and their traffic went unbilled.
  // The cumulative user must baseline on first sight; the delta user must bill
  // its bytes on every poll.
  it('bills delta-core and cumulative-core users correctly on a mixed node', async () => {
    await createNode('eu-6', '10.0.0.6:8443');
    const cumUser = await createUser('grace'); // xray-style cumulative counters
    const deltaUser = await createUser('heidi'); // ss-style per-poll deltas

    const mixed = (cumBytes: number, deltaBytes: number): GetStatsResponse => ({
      users: [
        { userId: cumUser, bytesIn: cumBytes, bytesOut: 0, cumulative: true },
        { userId: deltaUser, bytesIn: deltaBytes, bytesOut: 0, cumulative: false },
      ],
      uptime: 1,
      totalBytesIn: 0,
      totalBytesOut: 0,
      cumulative: true, // response-level OR across the two cores
    });

    // Poll 1: cumulative user baselines (delta 0); delta user bills its 100.
    mockStats(mixed(1000, 100));
    await pollNodeStats();
    let cum = await prisma.userTraffic.findUnique({ where: { userId: cumUser } });
    let del = await prisma.userTraffic.findUnique({ where: { userId: deltaUser } });
    expect(cum?.usedTrafficBytes).toBe(0n); // first sight of a cumulative counter
    expect(del?.usedTrafficBytes).toBe(100n); // delta billed immediately

    // Poll 2: cumulative grows 1000 -> 1500 (delta 500); delta core reports
    // another 100 for this poll -> billed additively, NOT re-baselined to zero.
    vi.restoreAllMocks();
    mockStats(mixed(1500, 100));
    await pollNodeStats();
    cum = await prisma.userTraffic.findUnique({ where: { userId: cumUser } });
    del = await prisma.userTraffic.findUnique({ where: { userId: deltaUser } });
    expect(cum?.usedTrafficBytes).toBe(500n); // 0 + 500
    expect(del?.usedTrafficBytes).toBe(200n); // 100 + 100 (was 100 pre-fix: unbilled)
  });

  // A-121: an mtproto listing is not an online signal. mtg lists every user the
  // panel sent it, connected or not, so taking the listing as "online" marked
  // the whole roster online on every poll, moved everyone's last node and gave
  // a first-connected date to people who never connected. Whatever the node's
  // label, and whether or not the agent tags its entries.
  describe('an mtproto listing, on a node with xray beside mtproto', () => {
    async function mixedNode(label: string): Promise<string> {
      const res = await app.inject({
        method: 'POST',
        url: '/api/nodes',
        headers: auth(),
        payload: { name: `mix-${label}`, address: `mix-${label}.test:1337`, intendedEngines: ['xray', 'mtproto'] },
      });
      if (res.statusCode !== 201) throw new Error(res.body);
      const id = JSON.parse(res.body).id as string;
      // The stored label, whatever it is, must not decide anything for an
      // agent that tags its entries: both are tried.
      await prisma.node.update({ where: { id }, data: { protocol: label } });
      return id;
    }

    it.each(['xray', 'mtproto'])('label %s: the listed mtproto user untouched, idle xray not, xray bytes billed', async (label) => {
      await mixedNode(label);
      const tg = await createUser(`tg-${label}`); // on mtproto: listed, no bytes
      const idle = await createUser(`idle-${label}`); // on xray, moved nothing
      const busy = await createUser(`busy-${label}`); // on xray, moved bytes

      // First poll baselines the cumulative xray counters, the second bills.
      for (const cum of [1000, 1300]) {
        vi.restoreAllMocks();
        mockStats({
          users: [
            { userId: tg, bytesIn: 0, bytesOut: 0, protocol: 'mtproto' },
            { userId: idle, bytesIn: 50, bytesOut: 0, cumulative: true, protocol: 'xray' },
            { userId: busy, bytesIn: cum, bytesOut: 0, cumulative: true, protocol: 'xray' },
          ],
          uptime: 1,
          totalBytesIn: 0,
          totalBytesOut: 0,
          cumulative: true,
        });
        await pollNodeStats();
      }

      const [t, i, b] = await Promise.all(
        [tg, idle, busy].map((userId) => prisma.userTraffic.findUnique({ where: { userId } })),
      );
      // No online time, no last node, no first-connected date.
      expect(t?.onlineAt ?? null, 'the listed mtproto user is not online').toBeNull();
      expect(t?.lastConnectedNodeId ?? null).toBeNull();
      expect(t?.firstConnectedAt ?? null).toBeNull();
      expect(t?.usedTrafficBytes ?? 0n).toBe(0n);
      expect(i?.onlineAt, 'the idle xray user is not').toBeNull();
      expect(b?.usedTrafficBytes).toBe(300n);
      expect(b?.onlineAt).not.toBeNull();
    });

    it('an agent that does not tag its entries: a node labelled mtproto marks nobody online either', async () => {
      await mixedNode('mtproto');
      const tg = await createUser('tg-legacy');
      mockStats(stats([{ userId: tg, bytesIn: 0, bytesOut: 0 }]));
      await pollNodeStats();
      expect((await prisma.userTraffic.findUnique({ where: { userId: tg } }))?.onlineAt ?? null).toBeNull();
    });
  });
});

describe('pollNodeStats anomaly sensor (integration)', () => {
  /** A 24h baseline well above the sensor's floor: 4 GB in a past hour. */
  async function seedBaseline(nodeId: string) {
    const pastHour = new Date(Date.now() - 2 * 60 * 60 * 1000);
    pastHour.setUTCMinutes(0, 0, 0);
    await prisma.nodeUsageHistory.create({
      data: { nodeId, hour: pastHour, downloadBytes: 3_000_000_000n, uploadBytes: 1_000_000_000n },
    });
  }

  /** A delta core (awg) that reports its total, as an agent with `cores` does. */
  function deltaPoll(users: { userId: string; bytes: number }[], over: Partial<GetStatsResponse> = {}): GetStatsResponse {
    const total = users.reduce((a, u) => a + u.bytes, 0);
    return {
      users: users.map((u) => ({ userId: u.userId, bytesIn: u.bytes, bytesOut: 0, cumulative: false })),
      uptime: 1,
      totalBytesIn: total,
      totalBytesOut: 0,
      cores: [{ protocol: 'amneziawg', engine: 'amneziawg', bytesIn: total, bytesOut: 0, cumulative: false }],
      ...over,
    };
  }

  async function tenUsers(prefix: string) {
    const users: string[] = [];
    for (let i = 0; i < 10; i++) users.push(await createUser(`${prefix}${i}`));
    return users;
  }

  it('fires node.anomaly once after a sustained correlated drop, and clears when users return', async () => {
    const nodeId = await createNode('ru-1', '10.0.0.9:8443');
    const users = await tenUsers('anon');
    await seedBaseline(nodeId);
    const emitSpy = vi.spyOn(eventBus, 'emit');
    const events = (name: string) => emitSpy.mock.calls.filter((c) => c[0] === name);

    const healthy = () => mockStats(deltaPoll(users.map((userId) => ({ userId, bytes: 300_000 }))));
    const drop = () => mockStats(deltaPoll([{ userId: users[0]!, bytes: 150 }]));

    healthy(); await pollNodeStats();
    drop(); await pollNodeStats();
    drop(); await pollNodeStats();
    expect(events('node.anomaly')).toHaveLength(0);
    drop(); await pollNodeStats();
    expect(events('node.anomaly')).toHaveLength(1);
    expect(events('node.anomaly')[0]![1]).toMatchObject({ nodeId, severity: 'critical', activeUsers: 1 });
    expect((events('node.anomaly')[0]![1] as { droppedUsers: number }).droppedUsers).toBeGreaterThanOrEqual(5);

    drop(); await pollNodeStats();
    expect(events('node.anomaly')).toHaveLength(1);
    healthy(); await pollNodeStats();
    expect(events('node.anomaly-cleared')).toEqual([['node.anomaly-cleared', { nodeId }]]);
  });

  // A cumulative core (xray) keeps listing every user it has seen, with
  // counters that stop growing when the node goes dark. Counting the list
  // instead of the users who moved bytes would leave the breadth signal flat.
  it('fires on a cumulative core, where the node keeps listing users that stopped moving', async () => {
    const nodeId = await createNode('ru-cum', '10.0.0.11:8443');
    const users = await tenUsers('cumanon');
    await seedBaseline(nodeId);
    const emitSpy = vi.spyOn(eventBus, 'emit');
    const anomalies = () => emitSpy.mock.calls.filter((c) => c[0] === 'node.anomaly');

    const cumPoll = (perUser: number): GetStatsResponse => ({
      users: users.map((id) => ({ userId: id, bytesIn: perUser, bytesOut: 0, cumulative: true, protocol: 'xray', engine: 'xray' })),
      uptime: 1,
      totalBytesIn: 0,
      totalBytesOut: 0,
      cumulative: true,
      cores: [{ protocol: 'xray', engine: 'xray', bytesIn: perUser * users.length, bytesOut: 0, cumulative: true }],
    });

    // The first poll only baselines the cumulative counters.
    mockStats(cumPoll(1_000_000)); await pollNodeStats();
    mockStats(cumPoll(2_000_000)); await pollNodeStats();
    mockStats(cumPoll(3_000_000)); await pollNodeStats();
    expect(anomalies()).toHaveLength(0);

    for (let i = 0; i < 3; i++) {
      mockStats(cumPoll(3_000_000));
      await pollNodeStats();
    }
    expect(anomalies()).toHaveLength(1);
    expect(anomalies()[0]![1]).toMatchObject({ nodeId, activeUsers: 0 });
  });

  // An agent too old to report per-core totals cannot tell a core that missed
  // its read from a blackout. It is "not reporting", never "all is well", and
  // never a false alarm either.
  it('does not judge an agent that sends no per-core totals', async () => {
    const nodeId = await createNode('ru-old', '10.0.0.12:8443');
    const users = await tenUsers('oldanon');
    await seedBaseline(nodeId);
    const emitSpy = vi.spyOn(eventBus, 'emit');

    mockStats(deltaPoll(users.map((userId) => ({ userId, bytes: 300_000 })), { cores: undefined }));
    await pollNodeStats();
    for (let i = 0; i < 5; i++) {
      mockStats(deltaPoll([], { cores: undefined }));
      await pollNodeStats();
    }
    expect(emitSpy.mock.calls.filter((c) => String(c[0]).startsWith('node.anomaly'))).toHaveLength(0);
  });

  it('does not count a poll in which a core could not read its counters', async () => {
    const nodeId = await createNode('ru-nodata', '10.0.0.13:8443');
    const users = await tenUsers('ndanon');
    await seedBaseline(nodeId);
    const emitSpy = vi.spyOn(eventBus, 'emit');
    const anomalies = () => emitSpy.mock.calls.filter((c) => c[0] === 'node.anomaly');
    const noData: GetStatsResponse = {
      users: [],
      uptime: 1,
      totalBytesIn: 0,
      totalBytesOut: 0,
      cores: [{ protocol: 'amneziawg', engine: 'amneziawg', bytesIn: 0, bytesOut: 0, cumulative: false, noData: true }],
    };

    mockStats(deltaPoll(users.map((userId) => ({ userId, bytes: 300_000 })))); await pollNodeStats();
    for (let i = 0; i < 5; i++) {
      mockStats(noData);
      await pollNodeStats();
    }
    expect(anomalies()).toHaveLength(0);
  });
});
