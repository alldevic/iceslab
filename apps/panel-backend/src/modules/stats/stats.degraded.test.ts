import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { GetStatsResponse } from '@iceslab/shared';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { NodeTransport } from '../nodes/nodes.transport.js';
import { pollNodeStats } from './stats.cron.js';

/**
 * A poll in which ONE core could not read its counters.
 *
 * The panel sums a user's cumulative rows across cores before comparing them to
 * its stored snapshot, so a core that drops out of the payload is
 * indistinguishable from a core whose counters reset: the sum falls, the
 * snapshot is re-baselined to the lower value, and the next successful poll
 * bills the difference - the absent core's ENTIRE since-core-start counter - as
 * one poll's traffic.
 *
 * Measured live 2026-08-30 on a node running xray and sing-box for one user.
 * sing-box's stats endpoint was blocked with an iptables REJECT for a single
 * poll and restored, with no traffic at all in between:
 *
 *   before  1 156 229 B
 *   after   1 672 312 B      (+516 083, exactly sing-box's cumulative counter)
 *
 * On a node up for a week that is the week, re-billed, bounded only by the
 * poller's 1 TiB per-poll clamp.
 *
 * xray's soft-fail could not prevent it and says so in its own comment: it
 * emits NO rows rather than zero rows, precisely so it does not look like a
 * reset - and once the panel has summed the cores, "said nothing" and "said
 * zero" are the same thing. Only the node can tell them apart, which is why it
 * now reports `statsDegraded` and the panel holds the cumulative rows for that
 * poll.
 */

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
  const res = await app.inject({
    method: 'POST', url: '/api/nodes', headers: auth(), payload: { name, address },
  });
  if (res.statusCode !== 201) throw new Error(`createNode: ${res.statusCode} ${res.body}`);
  return JSON.parse(res.body).id as string;
}

async function createUser(username: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/api/users', headers: auth(), payload: { username },
  });
  if (res.statusCode !== 201) throw new Error(`createUser: ${res.statusCode} ${res.body}`);
  return JSON.parse(res.body).id as string;
}

/** One user reported by two cumulative cores, the way a mixed node reports. */
function twoCores(
  userId: string,
  xray: number,
  singbox: number,
  opts: { degraded?: boolean; dropSingbox?: boolean } = {},
): GetStatsResponse {
  const users = [{ userId, bytesIn: 0, bytesOut: xray, cumulative: true }];
  if (!opts.dropSingbox) {
    users.push({ userId, bytesIn: 0, bytesOut: singbox, cumulative: true });
  }
  return {
    users,
    uptime: 1,
    totalBytesIn: 0,
    totalBytesOut: 0,
    cumulative: true,
    ...(opts.degraded ? { statsDegraded: true } : {}),
  };
}

const mock = (v: GetStatsResponse) =>
  vi.spyOn(NodeTransport.prototype, 'getStats').mockResolvedValue(v);

const used = async (userId: string): Promise<bigint> =>
  (await prisma.userTraffic.findUnique({ where: { userId } }))?.usedTrafficBytes ?? 0n;

describe('a poll where one core could not read its counters', () => {
  it('bills nothing for it and does not re-baseline, so recovery does not double-bill', async () => {
    await createNode('mixed-1', '10.0.0.1:8443');
    const u = await createUser('alice');

    // Baseline, then one real poll's worth of traffic.
    mock(twoCores(u, 1_000_000, 500_000));
    await pollNodeStats();
    vi.restoreAllMocks();
    mock(twoCores(u, 1_100_000, 516_083));
    await pollNodeStats();
    const billed = await used(u);
    expect(billed, 'the honest delta of the second poll').toBe(116_083n);

    // The degraded poll: sing-box could not answer, so its row is absent.
    vi.restoreAllMocks();
    mock(twoCores(u, 1_100_000, 0, { degraded: true, dropSingbox: true }));
    await pollNodeStats();
    expect(await used(u), 'a degraded poll must bill nothing').toBe(billed);

    // Recovery, byte-identical counters, no traffic whatsoever in between.
    vi.restoreAllMocks();
    mock(twoCores(u, 1_100_000, 516_083));
    await pollNodeStats();
    expect(
      await used(u),
      'the recovery poll billed the absent core\'s whole cumulative again',
    ).toBe(billed);
  });

  it('leaves the stored snapshot at the full sum, not at the partial one', async () => {
    // The mechanism, asserted directly: the snapshot is what the next delta is
    // measured against, and re-baselining it low is the whole defect.
    const nodeId = await createNode('mixed-2', '10.0.0.2:8443');
    const u = await createUser('bob');

    mock(twoCores(u, 1_000_000, 500_000));
    await pollNodeStats();
    vi.restoreAllMocks();
    mock(twoCores(u, 1_000_000, 500_000, { degraded: true, dropSingbox: true }));
    await pollNodeStats();

    const snap = await prisma.nodeUserTrafficSnapshot.findFirst({
      where: { nodeId, userId: u },
    });
    expect(snap?.cumOut, 'the snapshot dropped to the partial sum').toBe(1_500_000n);
  });

  it('still bills a DELTA core on a degraded poll', async () => {
    // The control, and a real risk: a delta core's read is destructive
    // (shadowsocks passes -reset), so bytes discarded here are gone from the
    // core too. Only cumulative rows may be held.
    await createNode('mixed-3', '10.0.0.3:8443');
    const u = await createUser('carol');

    mock({
      users: [
        { userId: u, bytesIn: 0, bytesOut: 700_000, cumulative: true },
        { userId: u, bytesIn: 11, bytesOut: 22 }, // delta core: no flag on the wire
      ],
      uptime: 1,
      totalBytesIn: 0,
      totalBytesOut: 0,
      cumulative: true,
      statsDegraded: true,
    });
    await pollNodeStats();
    expect(await used(u), 'the delta core\'s bytes were dropped with the cumulative ones').toBe(33n);
  });

  it('is a no-op on an undegraded poll: normal billing is untouched', async () => {
    // Without this the fix could simply be "never bill anything".
    await createNode('mixed-4', '10.0.0.4:8443');
    const u = await createUser('dave');

    mock(twoCores(u, 1_000_000, 500_000));
    await pollNodeStats();
    vi.restoreAllMocks();
    mock(twoCores(u, 1_000_100, 500_200));
    await pollNodeStats();
    expect(await used(u)).toBe(300n);
  });
});
