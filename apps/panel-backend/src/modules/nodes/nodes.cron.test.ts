import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { HealthcheckResponse, HostMetricsResponse } from '@iceslab/shared';
import { prisma } from '../../prisma.js';
import { redis, closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { inboundSyncQueue } from '../inbounds/inbounds.queue.js';
import { eventBus } from '../../lib/event-bus.js';
import { NodeTransport, NodeRequestError } from './nodes.transport.js';
import { nodeMetricsKey, pollNodeMetrics, pollNodeStatuses, readCachedNodeMetrics } from './nodes.cron.js';

/**
 * The two fan-outs, as opposed to the rules they apply.
 *
 * `statusFromHealth`, `composeDownMessage` and `tuneWorthWriting` are pure and
 * have their own files. What had none is the code AROUND them: the poller that
 * decides which nodes to ask, what to write, whom to tell, and what to leave
 * alone. Three of the comments in it name live incidents in a row — a green
 * card over a dead core, `degraded` counted as ok in the summary, a node coming
 * back up whose inbounds were never re-pushed — and every one of those is a
 * decision in the ORCHESTRATOR, not in the rule it calls.
 *
 * The cost of getting it wrong is concrete: `status` decides whether a node is
 * in anybody's subscription at all, and `lastStatusChange` is half of why a lab
 * fleet can go quietly empty.
 *
 * The network is the only thing stubbed. Postgres, Redis and the queue are the
 * real ones, because "did the row change" is the question.
 */

let touchedNodeIds: string[] = [];

/**
 * One subscription for the whole file, at module scope on purpose: the bus has
 * `on` and no `off`, and it wraps the handler it registers, so a per-test
 * listener could not be removed even by hand. Each case filters by its own
 * node id instead.
 */
const statusEvents: { nodeId: string; from: string; to: string }[] = [];
eventBus.on('node.status-changed', (e) => {
  statusEvents.push(e);
});
let health: Map<string, HealthcheckResponse | Error>;
let metrics: Map<string, HostMetricsResponse | Error>;

function ok(cores: HealthcheckResponse['cores'] = []): HealthcheckResponse {
  return { status: 'ok', cores };
}

function degraded(cores: HealthcheckResponse['cores']): HealthcheckResponse {
  return { status: 'degraded', cores };
}

function sampleMetrics(usedPercent: number): HostMetricsResponse {
  return {
    cpu: { usagePercent: 3, loadAvg1: 0.1, loadAvg5: 0.1, loadAvg15: 0.1, cores: 2 },
    memory: { totalBytes: 100, availableBytes: 50, usedBytes: 50, usedPercent },
    disk: { path: '/', totalBytes: 100, usedBytes: 10, usedPercent: 10 },
    uptimeSeconds: 42,
    collectedAt: new Date().toISOString(),
  };
}

let seq = 0;

async function makeNode(opts: {
  status?: string;
  message?: string | null;
  deleted?: boolean;
  coreVersion?: string | null;
} = {}) {
  seq += 1;
  const address = `cron-${seq}.example.com:1337`;
  const node = await prisma.node.create({
    data: {
      name: `cron-${seq}`,
      address,
      heartbeatSecret: randomBytes(32),
      status: opts.status ?? 'unknown',
      lastStatusMessage: opts.message ?? null,
      coreVersion: opts.coreVersion ?? null,
      deletedAt: opts.deleted ? new Date() : null,
    },
  });
  touchedNodeIds.push(node.id);
  return { id: node.id, address, name: node.name };
}

beforeEach(async () => {
  await cleanDatabase();
  touchedNodeIds = [];
  health = new Map();
  metrics = new Map();

  // Keyed by address so one poll can give different nodes different answers,
  // which is the whole point of testing a fan-out.
  vi.spyOn(NodeTransport.prototype, 'healthcheck').mockImplementation(async function (
    this: { node?: { address: string } },
  ) {
    const addr = (this as unknown as { node: { address: string } }).node.address;
    const answer = health.get(addr);
    if (answer === undefined) throw new Error(`no healthcheck stub for ${addr}`);
    if (answer instanceof Error) throw answer;
    return answer;
  });
  vi.spyOn(NodeTransport.prototype, 'getMetrics').mockImplementation(async function (
    this: { node?: { address: string } },
  ) {
    const addr = (this as unknown as { node: { address: string } }).node.address;
    const answer = metrics.get(addr);
    if (answer === undefined) throw new Error(`no metrics stub for ${addr}`);
    if (answer instanceof Error) throw answer;
    return answer;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Redis and the queue are shared with the rest of the suite and with a live
  // panel if one is up, so only this file's own keys go.
  for (const id of touchedNodeIds) {
    await redis.del(nodeMetricsKey(id)).catch(() => null);
    const job = await inboundSyncQueue.getJob(`apply-${id}`).catch(() => null);
    if (job) await job.remove().catch(() => null);
  }
});

afterAll(async () => {
  await inboundSyncQueue.close();
  await prisma.$disconnect();
  await closeRedis();
});

describe('pollNodeStatuses: which nodes it asks', () => {
  it('asks active nodes and leaves disabled and soft-deleted ones alone', async () => {
    const live = await makeNode({ status: 'online' });
    const off = await makeNode({ status: 'disabled' });
    const gone = await makeNode({ status: 'online', deleted: true });
    health.set(live.address, ok());
    // No stubs for the other two: the mock throws if either is polled, and an
    // "unreachable" write is what that failure would look like.

    const summary = await pollNodeStatuses();
    expect(summary).toEqual({ ok: 1, down: 0 });

    // `disabled` is admin-managed; a poller that overwrote it would silently
    // re-enable a node an operator took out of rotation.
    expect((await prisma.node.findUnique({ where: { id: off.id } }))!.status).toBe('disabled');
    expect((await prisma.node.findUnique({ where: { id: gone.id } }))!.status).toBe('online');
  });

  it('is a no-op with nothing to poll', async () => {
    await expect(pollNodeStatuses()).resolves.toEqual({ ok: 0, down: 0 });
  });
});

describe('pollNodeStatuses: what the summary counts', () => {
  it('counts a degraded node with the down ones, not the ok ones', async () => {
    const good = await makeNode({ status: 'online' });
    const bad = await makeNode({ status: 'online' });
    const dead = await makeNode({ status: 'online' });
    health.set(good.address, ok());
    health.set(bad.address, degraded([{ name: 'xray', running: false }]));
    health.set(dead.address, new NodeRequestError('connect ETIMEDOUT', 0, null));

    // The agent answers on `bad`, but a core the operator configured is
    // serving nobody. Calling that "ok" is what let a dead cascade entry look
    // healthy in the summary an operator reads.
    await expect(pollNodeStatuses()).resolves.toEqual({ ok: 1, down: 2 });
  });
});

describe('pollNodeStatuses: what it writes', () => {
  it('stamps lastStatusChange only when the status itself moved', async () => {
    const node = await makeNode({ status: 'unknown' });
    health.set(node.address, ok());
    await pollNodeStatuses();

    const first = await prisma.node.findUnique({ where: { id: node.id } });
    expect(first!.status).toBe('online');
    expect(first!.lastStatusChange).not.toBeNull();

    // A second identical poll must not touch the row. A stamp that moves on
    // every tick stops meaning "when this node last changed", and a stale one
    // across a whole fleet is one of the two ways a lab subscription goes empty.
    await pollNodeStatuses();
    const second = await prisma.node.findUnique({ where: { id: node.id } });
    expect(second!.lastStatusChange!.getTime()).toBe(first!.lastStatusChange!.getTime());
    expect(second!.updatedAt.getTime()).toBe(first!.updatedAt.getTime());
  });

  it('clears a stale degraded blurb when the node recovers', async () => {
    const node = await makeNode({ status: 'degraded', message: 'not running: xray' });
    health.set(node.address, ok());

    await pollNodeStatuses();

    const row = await prisma.node.findUnique({ where: { id: node.id } });
    expect(row!.status).toBe('online');
    // The guard used to be `statusChanged || result.message`, which never
    // re-wrote when the NEW message was null — so the old blurb sat in the UI
    // forever after the core came back.
    expect(row!.lastStatusMessage).toBeNull();
  });

  it('rewrites a changed message even when the status stayed put', async () => {
    const node = await makeNode({ status: 'degraded', message: 'not running: xray' });
    health.set(node.address, degraded([{ name: 'hysteria', running: false }]));

    await pollNodeStatuses();

    const row = await prisma.node.findUnique({ where: { id: node.id } });
    expect(row!.status).toBe('degraded');
    expect(row!.lastStatusMessage).toContain('hysteria');
    // Same status, so the transition stamp must NOT move.
    expect(row!.lastStatusChange).toBeNull();
  });

  it('keeps the stored core version when this poll observed none', async () => {
    const node = await makeNode({ status: 'online', coreVersion: '26.3.27' });
    // Unreachable: the agent said nothing about its cores, which is not the
    // same as saying it has none.
    health.set(node.address, new Error('socket hang up'));

    await pollNodeStatuses();

    const row = await prisma.node.findUnique({ where: { id: node.id } });
    expect(row!.status).toBe('unreachable');
    expect(row!.coreVersion).toBe('26.3.27');
  });

  it('stops writing the row once a node has settled into unreachable', async () => {
    // The `!== undefined` half of the version guard is not redundant with
    // Prisma treating undefined as "leave it": it also decides whether the row
    // is written AT ALL. Drop it and a stored coreVersion makes every tick
    // disagree with an unreachable poll's `undefined`, so a fleet of nodes that
    // are simply down pays one UPDATE each, every thirty seconds, forever.
    const node = await makeNode({ status: 'online', coreVersion: '26.3.27' });
    health.set(node.address, new Error('connect ECONNREFUSED'));

    await pollNodeStatuses(); // online → unreachable: this one must write
    const settled = await prisma.node.findUnique({ where: { id: node.id } });
    expect(settled!.status).toBe('unreachable');

    await pollNodeStatuses(); // same answer again: this one must not
    const after = await prisma.node.findUnique({ where: { id: node.id } });
    expect(after!.updatedAt.getTime()).toBe(settled!.updatedAt.getTime());
    expect(after!.coreVersion).toBe('26.3.27');
  });

  it('records a core version the poll did observe', async () => {
    const node = await makeNode({ status: 'unknown' });
    health.set(node.address, ok([{ name: 'xray', running: true, version: '26.3.27' }]));

    await pollNodeStatuses();

    expect((await prisma.node.findUnique({ where: { id: node.id } }))!.coreVersion).toBe('26.3.27');
  });

  it('truncates an unreachable node message to what the column holds', async () => {
    const node = await makeNode({ status: 'online' });
    health.set(node.address, new Error('x'.repeat(500)));

    await pollNodeStatuses();

    const row = await prisma.node.findUnique({ where: { id: node.id } });
    expect(row!.lastStatusMessage!.length).toBe(200);
  });
});

describe('pollNodeStatuses: which core\'s restart tally it keeps', () => {
  // One tally per node, and until 2026-08-27 only xray ever sent one, so the
  // pick could be "xray, else the first that reports". Every subprocess-owning
  // adapter reports now, and the old rule would hide a sing-box bouncing every
  // minute behind a quiet xray — or, on a node with neither, pick by adapter
  // registration order.
  function coreWith(name: string, crash: number): HealthcheckResponse['cores'][number] {
    return {
      name: name as HealthcheckResponse['cores'][number]['name'],
      running: true,
      restarts: {
        core: name,
        crash,
        memory: 0,
        sinceAt: '2026-08-27T00:00:00.000Z',
      } as HealthcheckResponse['cores'][number]['restarts'],
    };
  }

  it('keeps the core that is actually restarting, not the alphabetically lucky one', async () => {
    const node = await makeNode({ status: 'online' });
    health.set(node.address, ok([coreWith('xray', 0), coreWith('tuic', 4)]));

    await pollNodeStatuses();

    const row = await prisma.node.findUnique({ where: { id: node.id } });
    const tally = row!.coreRestarts as { core: string; total: number } | null;
    expect(tally, 'no tally was stored at all').not.toBeNull();
    expect(tally!.core, 'a quiet xray hid a core that restarted four times').toBe('tuic');
    expect(tally!.total).toBe(4);
  });

  it('breaks a tie toward xray, so a fleet of quiet nodes reads the same way', async () => {
    const node = await makeNode({ status: 'online' });
    health.set(node.address, ok([coreWith('tuic', 2), coreWith('xray', 2)]));

    await pollNodeStatuses();

    const row = await prisma.node.findUnique({ where: { id: node.id } });
    expect((row!.coreRestarts as { core: string }).core).toBe('xray');
  });
});

describe('pollNodeStatuses: whom it tells', () => {
  it('emits node.status-changed once, only on the tick that moved', async () => {
    const node = await makeNode({ status: 'unknown' });
    health.set(node.address, ok());
    await pollNodeStatuses();
    await pollNodeStatuses(); // identical answer, nothing moved
    // The bus wraps handlers and delivers them on a microtask.
    await new Promise((r) => setTimeout(r, 20));

    const mine = statusEvents.filter((e) => e.nodeId === node.id);
    expect(mine).toEqual([{ nodeId: node.id, from: 'unknown', to: 'online' }]);
  });

  it('re-pushes inbounds for a node that came back DEGRADED, not just online', async () => {
    // Keying this on `online` would have skipped the only nodes it was written
    // for: a node whose core will not start is exactly the one whose config
    // needs re-pushing.
    const node = await makeNode({ status: 'unreachable' });
    health.set(node.address, degraded([{ name: 'xray', running: false }]));

    await pollNodeStatuses();
    await new Promise((r) => setTimeout(r, 20));

    const job = await inboundSyncQueue.getJob(`apply-${node.id}`);
    expect(job, 'a node that came back up got no applyInbounds re-push').not.toBeNull();
    expect(job!.data).toEqual({ nodeId: node.id });
  });

  it('does not re-push for a node that just went unreachable', async () => {
    const node = await makeNode({ status: 'online' });
    health.set(node.address, new Error('connect ECONNREFUSED'));

    await pollNodeStatuses();
    await new Promise((r) => setTimeout(r, 20));

    expect(await inboundSyncQueue.getJob(`apply-${node.id}`)).toBeUndefined();
  });
});

describe('pollNodeMetrics', () => {
  it('caches a sample per node under its own key, with a TTL', async () => {
    const node = await makeNode({ status: 'online' });
    metrics.set(node.address, sampleMetrics(50));

    await expect(pollNodeMetrics()).resolves.toEqual({ ok: 1, failed: 0 });

    const cached = await readCachedNodeMetrics(node.id);
    expect(cached!.memory.usedPercent).toBe(50);
    // Without an expiry the dashboard would show a dead node's last sample
    // forever, and it would look current.
    const ttl = await redis.ttl(nodeMetricsKey(node.id));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('skips disabled and unreachable nodes', async () => {
    const live = await makeNode({ status: 'online' });
    const off = await makeNode({ status: 'disabled' });
    const dead = await makeNode({ status: 'unreachable' });
    metrics.set(live.address, sampleMetrics(10));
    // No stubs for the other two; polling either throws and would show up as
    // a `failed` count rather than being skipped.

    await expect(pollNodeMetrics()).resolves.toEqual({ ok: 1, failed: 0 });
    expect(await readCachedNodeMetrics(off.id)).toBeNull();
    expect(await readCachedNodeMetrics(dead.id)).toBeNull();
  });

  it('polls a degraded node: its host metrics are exactly what an operator needs', async () => {
    const node = await makeNode({ status: 'degraded' });
    metrics.set(node.address, sampleMetrics(97));

    await expect(pollNodeMetrics()).resolves.toEqual({ ok: 1, failed: 0 });
    expect((await readCachedNodeMetrics(node.id))!.memory.usedPercent).toBe(97);
  });

  it('one node failing does not cost the others their sample', async () => {
    const good = await makeNode({ status: 'online' });
    const bad = await makeNode({ status: 'online' });
    const alsoGood = await makeNode({ status: 'online' });
    metrics.set(good.address, sampleMetrics(11));
    metrics.set(bad.address, new NodeRequestError('boom', 500, null));
    metrics.set(alsoGood.address, sampleMetrics(22));

    await expect(pollNodeMetrics()).resolves.toEqual({ ok: 2, failed: 1 });
    expect((await readCachedNodeMetrics(good.id))!.memory.usedPercent).toBe(11);
    expect((await readCachedNodeMetrics(alsoGood.id))!.memory.usedPercent).toBe(22);
    // The failing node keeps whatever it had, which is nothing here.
    expect(await readCachedNodeMetrics(bad.id)).toBeNull();
  });

  it('is a no-op with nothing to poll', async () => {
    await expect(pollNodeMetrics()).resolves.toEqual({ ok: 0, failed: 0 });
  });
});

/**
 * The blast radius of one bad node.
 *
 * `pollNodeStatuses` was the one of the three fan-outs with no per-node guard,
 * and the reasoning for leaving it that way was that `checkOne` swallows its
 * own errors so nothing can throw. That covers the FETCH; the row write, the
 * queue enqueue and the alerts all happen after it, and one of those failing
 * rejects the whole `Promise.all` - abandoning every other node in the same
 * tick, including writes that had not run yet.
 *
 * A stale status is not cosmetic: `status` decides whether a node appears in
 * anybody's subscription, so the nodes that vanish are the ones nothing went
 * wrong with.
 */
describe('one node that cannot be written does not take the tick with it', () => {
  it('still writes the others, and still returns a count', async () => {
    const bad = await makeNode({ status: 'unknown' });
    const good = await makeNode({ status: 'unknown' });
    health.set(bad.address, ok());
    health.set(good.address, ok());

    // Fail the write for exactly one node, the way a constraint violation or a
    // dropped connection would. Not the healthcheck: that path is already
    // guarded, and stubbing it would test the guard that exists.
    const realUpdate = prisma.node.update.bind(prisma.node);
    vi.spyOn(prisma.node, 'update').mockImplementation((async (args: { where: { id: string } }) => {
      if (args.where.id === bad.id) throw new Error('write failed for this node');
      return realUpdate(args as never);
    }) as never);

    const result = await pollNodeStatuses();
    vi.restoreAllMocks();

    // The good node's row moved, which is the whole point.
    const after = await prisma.node.findUnique({ where: { id: good.id } });
    expect(
      after?.status,
      'a healthy node was left in `unknown` because a DIFFERENT node failed to write',
    ).toBe('online');

    // And the tick still answers. Both nodes were reachable and healthy, so
    // both count as ok - the failure was in storing the verdict, not in
    // reaching the node, and reporting it as `down` would say the node is
    // unreachable when it is not.
    expect(result.ok).toBe(2);

    // The bad node keeps its previous status rather than acquiring a wrong one.
    const badAfter = await prisma.node.findUnique({ where: { id: bad.id } });
    expect(badAfter?.status).toBe('unknown');
  });
});
