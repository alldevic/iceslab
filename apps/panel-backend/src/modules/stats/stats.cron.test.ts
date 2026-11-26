import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { GetStatsResponse } from '@iceslab/shared';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { eventBus } from '../../lib/infra/event-bus.js';
import { NodeTransport } from '../nodes/nodes.transport.js';
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

describe('pollNodeStats anomaly sensor (U7, integration)', () => {
  it('fires node.anomaly once after a sustained correlated drop, then re-arms', async () => {
    const nodeId = await createNode('ru-1', '10.0.0.9:8443');
    const users: string[] = [];
    for (let i = 0; i < 10; i++) users.push(await createUser(`anon${i}`));

    // Seed a high 24h baseline directly: 4 GB across a past hour → ~1.39 MB/poll,
    // comfortably above the sensor's min-baseline floor.
    const pastHour = new Date(Date.now() - 2 * 60 * 60 * 1000);
    pastHour.setUTCMinutes(0, 0, 0);
    await prisma.nodeUsageHistory.create({
      data: { nodeId, hour: pastHour, downloadBytes: 3_000_000_000n, uploadBytes: 1_000_000_000n },
    });

    const emitSpy = vi.spyOn(eventBus, 'emit');
    const anomalies = () => emitSpy.mock.calls.filter((c) => c[0] === 'node.anomaly');

    // Healthy poll: 10 users transferring → establishes the expected-user level.
    // Never fires on the first poll (no shortfall computed yet).
    const healthy = () =>
      mockStats(stats(users.map((id) => ({ userId: id, bytesIn: 200_000, bytesOut: 100_000 }))));
    healthy();
    await pollNodeStats();
    expect(anomalies()).toHaveLength(0);

    // Sustained correlated drop: 1 user, a trickle of bytes. Needs `debounce`
    // (3) consecutive polls before firing.
    const drop = () => mockStats(stats([{ userId: users[0]!, bytesIn: 100, bytesOut: 50 }]));
    drop(); await pollNodeStats();
    expect(anomalies()).toHaveLength(0); // hits=1
    drop(); await pollNodeStats();
    expect(anomalies()).toHaveLength(0); // hits=2
    drop(); await pollNodeStats(); // hits=3 → fire
    const fired = anomalies();
    expect(fired).toHaveLength(1);
    const payload = fired[0]![1] as { nodeId: string; severity: string; droppedUsers: number };
    expect(payload.nodeId).toBe(nodeId);
    expect(payload.severity).toBe('critical');
    expect(payload.droppedUsers).toBeGreaterThanOrEqual(5);

    // A 4th sustained-drop poll must NOT re-fire (single event per outage).
    drop(); await pollNodeStats();
    expect(anomalies()).toHaveLength(1);

    // Recovery: users return → sensor re-arms (debounce reset, still one event)
    // and the incident is closed with node.anomaly-cleared.
    const cleared = () => emitSpy.mock.calls.filter((c) => c[0] === 'node.anomaly-cleared');
    expect(cleared()).toHaveLength(0);
    healthy();
    await pollNodeStats();
    expect(anomalies()).toHaveLength(1);
    expect(cleared()).toHaveLength(1);
    expect(cleared()[0]![1]).toEqual({ nodeId });

    // A new sustained drop is a second incident.
    drop(); await pollNodeStats();
    drop(); await pollNodeStats();
    drop(); await pollNodeStats();
    expect(anomalies()).toHaveLength(2);
  });

  // The case above models a DELTA core: a node that goes dark simply stops
  // listing its users, so the reported list shrinks. A CUMULATIVE core (xray,
  // the common one) does the opposite — it keeps listing every user it has ever
  // seen, with counters that stop growing. Counting the list instead of the
  // users who actually moved bytes therefore leaves the breadth signal flat, and
  // because evaluateNodeDrop requires it, the sensor goes silent exactly on the
  // core most nodes run. It passes every pure-logic test while doing nothing.
  it('fires on a cumulative core, where the node keeps listing users that stopped moving', async () => {
    const nodeId = await createNode('ru-cum', '10.0.0.11:8443');
    const users: string[] = [];
    for (let i = 0; i < 10; i++) users.push(await createUser(`cumanon${i}`));

    const pastHour = new Date(Date.now() - 2 * 60 * 60 * 1000);
    pastHour.setUTCMinutes(0, 0, 0);
    await prisma.nodeUsageHistory.create({
      data: { nodeId, hour: pastHour, downloadBytes: 3_000_000_000n, uploadBytes: 1_000_000_000n },
    });

    const emitSpy = vi.spyOn(eventBus, 'emit');
    const anomalies = () => emitSpy.mock.calls.filter((c) => c[0] === 'node.anomaly');

    // Cumulative counters: EVERY user is listed on EVERY poll, always.
    const cumPoll = (perUser: number): GetStatsResponse => ({
      users: users.map((id) => ({ userId: id, bytesIn: perUser, bytesOut: 0, cumulative: true })),
      uptime: 1,
      totalBytesIn: 0,
      totalBytesOut: 0,
      cumulative: true,
    });

    // Two healthy polls: counters climb, so 10 users are genuinely moving bytes.
    // (The first poll only baselines the cumulative counters — its deltas are 0.)
    // Re-mocking via mockStats() replaces the implementation in place; calling
    // vi.restoreAllMocks() here would also drop the emit spy above and silently
    // stop recording the very events this test asserts on.
    mockStats(cumPoll(1_000_000));
    await pollNodeStats();
    mockStats(cumPoll(2_000_000));
    await pollNodeStats();
    expect(anomalies()).toHaveLength(0);

    // Node goes dark: counters FROZEN. The list is still 10 users long — only
    // the deltas are zero. This is what the old `userList.length` could not see.
    const frozen = () => mockStats(cumPoll(2_000_000));
    frozen(); await pollNodeStats();
    frozen(); await pollNodeStats();
    frozen(); await pollNodeStats();

    const fired = anomalies();
    expect(fired).toHaveLength(1);
    const payload = fired[0]![1] as { nodeId: string; droppedUsers: number };
    expect(payload.nodeId).toBe(nodeId);
    expect(payload.droppedUsers).toBeGreaterThanOrEqual(5);
  });

  async function seedBaseline(nodeId: string) {
    const pastHour = new Date(Date.now() - 2 * 60 * 60 * 1000);
    pastHour.setUTCMinutes(0, 0, 0);
    await prisma.nodeUsageHistory.create({
      data: { nodeId, hour: pastHour, downloadBytes: 3_000_000_000n, uploadBytes: 1_000_000_000n },
    });
  }

  // A-163: one user on two adapters is listed twice. Counting entries would see
  // 10 "users" in a poll where 5 are moving bytes, and the shortfall would never
  // reach the threshold of 5 against a peak of 10.
  it('counts a user listed by two adapters as one active user', async () => {
    const nodeId = await createNode('ru-2ad', '10.0.0.12:8443');
    const users: string[] = [];
    for (let i = 0; i < 10; i++) users.push(await createUser(`twoad${i}`));
    await seedBaseline(nodeId);

    const emitSpy = vi.spyOn(eventBus, 'emit');
    const anomalies = () => emitSpy.mock.calls.filter((c) => c[0] === 'node.anomaly');

    // 10 users, 10 entries: the expected level is 10.
    mockStats(stats(users.map((id) => ({ userId: id, bytesIn: 200_000, bytesOut: 100_000 }))));
    await pollNodeStats();

    // 4 users remain, each on two adapters = 8 entries. By entries the shortfall
    // is 2 (no event); by distinct users it is 6.
    const dark = users.slice(0, 4).flatMap((id) => [
      { userId: id, bytesIn: 10, bytesOut: 0, protocol: 'vless', engine: 'xray' },
      { userId: id, bytesIn: 10, bytesOut: 0, protocol: 'hysteria2', engine: 'hysteria' },
    ]);
    for (let i = 0; i < 3; i++) {
      mockStats(stats(dark));
      await pollNodeStats();
    }
    const fired = anomalies();
    expect(fired).toHaveLength(1);
    expect(fired[0]![1]).toMatchObject({ nodeId, activeUsers: 4, droppedUsers: 6 });
  });

  // A core that could not read its counters shows up as zero bytes and no users;
  // that is a failed read, not a blackout.
  it('does not count a poll in which a core had no data', async () => {
    const nodeId = await createNode('ru-nodata', '10.0.0.13:8443');
    const users: string[] = [];
    for (let i = 0; i < 10; i++) users.push(await createUser(`nodata${i}`));
    await seedBaseline(nodeId);

    const emitSpy = vi.spyOn(eventBus, 'emit');
    const anomalies = () => emitSpy.mock.calls.filter((c) => c[0] === 'node.anomaly');

    mockStats(stats(users.map((id) => ({ userId: id, bytesIn: 200_000, bytesOut: 100_000 }))));
    await pollNodeStats();

    const blind: GetStatsResponse = {
      ...stats([]),
      cores: [{ protocol: 'vless', engine: 'xray', totalBytesIn: 0, totalBytesOut: 0, noData: true }],
    } as GetStatsResponse;
    for (let i = 0; i < 5; i++) {
      mockStats(blind);
      await pollNodeStats();
    }
    expect(anomalies()).toHaveLength(0);
  });
});
