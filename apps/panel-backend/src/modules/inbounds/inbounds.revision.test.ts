import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { Worker } from 'bullmq';
import { prisma } from '../../prisma.js';
import { closeRedis, redis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { stubNodeRoster } from '../../../tests/helpers/node-roster.js';
import { NodeTransport, NodeRequestError } from '../nodes/nodes.transport.js';
import {
  applyInboundsForNode,
  enqueueNodePush,
  inboundSyncQueue,
  reconcileNodeRevisions,
  startInboundSyncWorker,
} from './inbounds.queue.js';
import { getNodeSyncStatus } from '../nodes/nodes.sync-status.js';

/**
 * A-162, on a real Redis with a real BullMQ worker: an edit that lands while
 * a push of the same node is running is pushed too.
 *
 * Before the revision the re-queue ran inside the job, where the jobId was
 * still active, so BullMQ dropped it as a duplicate after the dirty flag had
 * been eaten: the handler ran ONCE and the status then read "applied" for a
 * config the node never got. Now the job acknowledges the revision it read at
 * its start, and the worker queues again when it ends.
 */
let worker: Worker | null = null;

async function node(): Promise<string> {
  const tag = randomBytes(3).toString('hex');
  const n = await prisma.node.create({
    data: {
      name: `rev-${tag}`,
      address: `rev-${tag}.test:8443`,
      protocol: 'xray',
      status: 'online',
      heartbeatSecret: randomBytes(32),
    },
    select: { id: true },
  });
  return n.id;
}

/** A push the test holds until it says so: the "mid-job" window. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
}

const revisions = async (id: string) => {
  const n = await prisma.node.findUniqueOrThrow({ where: { id } });
  return { desired: n.desiredRevision, applied: n.appliedRevision };
};

beforeEach(async () => {
  await cleanDatabase();
  await inboundSyncQueue.obliterate({ force: true });
  const keys = await redis.keys('inbound-sync:reconciled:*');
  if (keys.length > 0) await redis.del(...keys);
  // These nodes answer as an agent older than geo: the push goes straight on.
  vi.spyOn(NodeTransport.prototype, 'listAssets').mockRejectedValue(new NodeRequestError('404', 404, null));
  // Every test here stubs applyInbounds; the roster after it is answered too.
  stubNodeRoster();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await worker?.close();
  worker = null;
});

afterAll(async () => {
  await inboundSyncQueue.obliterate({ force: true });
  await prisma.$disconnect();
  await closeRedis();
});

describe('a push of a node edited while it runs', () => {
  it('is followed by a second push, and the node reads applied only after it', async () => {
    const id = await node();
    const first = gate();
    let calls = 0;
    vi.spyOn(NodeTransport.prototype, 'applyInbounds').mockImplementation(async () => {
      calls++;
      if (calls === 1) await first.opened;
      return { ok: true, applied: 0, skipped: 0 };
    });
    worker = startInboundSyncWorker();

    await enqueueNodePush(id);
    await expect.poll(() => calls, { timeout: 10_000 }).toBe(1);
    // The edit lands mid-job.
    await enqueueNodePush(id);
    expect((await getNodeSyncStatus(id))!.applied).toBe(false);
    first.open();

    await expect.poll(() => calls, { timeout: 10_000 }).toBe(2);
    await expect.poll(async () => (await getNodeSyncStatus(id))!.applied, { timeout: 10_000 }).toBe(true);
    expect(await revisions(id)).toEqual({ desired: 2n, applied: 2n });
  });

  it('an answer to the first push alone does not claim the edit', async () => {
    // The node has no hosts: the job returns right after the acknowledgement,
    // the early return the dirty flag was never checked behind.
    const id = await node();
    const first = gate();
    let calls = 0;
    vi.spyOn(NodeTransport.prototype, 'applyInbounds').mockImplementation(async () => {
      calls++;
      if (calls === 1) await first.opened;
      return { ok: true, applied: 0, skipped: 0 };
    });
    worker = startInboundSyncWorker();
    await enqueueNodePush(id);
    await expect.poll(() => calls, { timeout: 10_000 }).toBe(1);
    await enqueueNodePush(id);
    first.open();
    // Right after the first answer the applied revision is the one it was
    // built for, 1, not the 2 the edit asked for.
    await expect.poll(async () => (await revisions(id)).applied, { timeout: 10_000 }).toBeGreaterThanOrEqual(1n);
    await expect.poll(async () => (await revisions(id)).applied, { timeout: 10_000 }).toBe(2n);
  });

  it('a last attempt that fails leaves the node pending, and the cron brings it to the edit', async () => {
    // The dirty flag lost the edit here: the check sat after the code that
    // threw. With the revision the later attempts READ the edit (they start
    // after it), so when the last one fails nothing is claimed: the node reads
    // pending, and the poll cron pushes it once it answers again.
    const id = await node();
    let calls = 0;
    let failing = true;
    const first = gate();
    vi.spyOn(NodeTransport.prototype, 'applyInbounds').mockImplementation(async () => {
      calls++;
      if (calls === 1) await first.opened;
      if (failing) throw new Error('connect ECONNREFUSED');
      return { ok: true, applied: 0, skipped: 0 };
    });
    worker = startInboundSyncWorker();
    await enqueueNodePush(id);
    await expect.poll(() => calls, { timeout: 10_000 }).toBe(1);
    await enqueueNodePush(id);
    first.open();
    // Three attempts (1 s and 2 s apart), all refused.
    await expect.poll(() => calls, { timeout: 15_000 }).toBe(3);
    await new Promise((r) => setTimeout(r, 300));
    expect(await revisions(id)).toEqual({ desired: 2n, applied: 0n });
    expect((await getNodeSyncStatus(id))!.applied).toBe(false);

    failing = false;
    expect(await reconcileNodeRevisions()).toBe(1);
    await expect.poll(async () => (await revisions(id)).applied, { timeout: 10_000 }).toBe(2n);
    expect(calls).toBe(4);
  }, 40_000);
});

describe('a refusal of the node policy or dns (agent 22.10: 500 ADAPTER_FAILED, before: 200)', () => {
  it('lands on the node as an error and leaves it not applied', async () => {
    const id = await node();
    await enqueueNodePush(id);
    await inboundSyncQueue.obliterate({ force: true });
    const reason = '1/1 sections failed to apply: policy (xray): core rejected the config: exit status 23';
    vi.spyOn(NodeTransport.prototype, 'applyInbounds').mockRejectedValue(
      new NodeRequestError(`Node rev returned 500: ${reason}`, 500, { error: 'ADAPTER_FAILED', message: reason }),
    );
    await expect(applyInboundsForNode(id)).rejects.toThrow();
    const n = await prisma.node.findUniqueOrThrow({ where: { id } });
    expect((n.lastInboundSyncError as { message: string }).message).toContain('policy (xray)');
    expect(n.appliedRevision).toBe(0n);
    expect((await getNodeSyncStatus(id))!.applied).toBe(false);
  });
});

describe('the poll cron brings a node back to its revision (P1)', () => {
  it('queues a push for an online node behind its revision, once per revision', async () => {
    const id = await node();
    await prisma.node.update({ where: { id }, data: { desiredRevision: 3n, appliedRevision: 1n } });
    expect(await reconcileNodeRevisions()).toBe(1);
    // A refused config stays behind as well; it is not retried every tick.
    expect(await reconcileNodeRevisions()).toBe(0);
    const offline = await node();
    await prisma.node.update({ where: { id: offline }, data: { status: 'unreachable', desiredRevision: 2n } });
    expect(await reconcileNodeRevisions()).toBe(0);
  });

  it('takes a degraded node too, once an hour like an online one', async () => {
    const id = await node();
    await prisma.node.update({ where: { id }, data: { status: 'degraded', desiredRevision: 2n, appliedRevision: 1n } });
    expect(await reconcileNodeRevisions()).toBe(1);
    expect(await reconcileNodeRevisions()).toBe(0);
  });
});
