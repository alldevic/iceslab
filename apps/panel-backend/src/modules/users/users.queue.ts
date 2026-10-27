import { Queue, Worker, type Job } from 'bullmq';
import type { AddUserRequest, RemoveUserRequest } from '@iceslab/shared';
import { redis } from '../../lib/infra/redis.js';
import { prisma } from '../../prisma.js';
import { NodeTransport, NodeRequestError } from '../nodes/nodes.transport.js';
import { deriveTuicPassword, deriveAnytlsPassword, deriveShadowtlsPassword, deriveMtprotoSecret } from '../../lib/auth/credentials.js';
import { getLogger } from '../../lib/infra/logger.js';
import { reachOfUsers } from './user-reach.js';
import { enqueueNodePush } from '../inbounds/inbounds.queue.js';
import { awgBindingsOfNode, awgCredentialsOf } from '../amneziawg/awg-addresses.js';

// ───── Job data shapes ─────

export interface AddUserJobData {
  userId: string;
}

export interface RemoveUserJobData {
  userId: string;
}

export interface BackfillNodeJobData {
  nodeId: string;
}

export type NodeUserJobData = AddUserJobData | RemoveUserJobData | BackfillNodeJobData;

// ───── Queue ─────

const QUEUE_NAME = 'node-users';

export const nodeUsersQueue = new Queue<NodeUserJobData>(QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },     // 1s, 2s, 4s
    removeOnComplete: { age: 3600, count: 1000 },      // keep 1h or last 1000
    removeOnFail: { age: 86400 },                      // keep 24h on fail
  },
});

// ───── Sync helpers ─────

interface NodeRow {
  id: string;
  name: string;
  address: string;
}

async function fetchActiveNodes(): Promise<(NodeRow & { lastInboundSyncAt: Date | null })[]> {
  return prisma.node.findMany({
    where: { deletedAt: null, status: { not: 'disabled' } },
    select: { id: true, name: true, address: true, lastInboundSyncAt: true },
  });
}

/**
 * Fan-out a single addUser/removeUser call to every active node, awaiting all
 * outcomes (allSettled) so we surface ALL failures rather than short-circuit
 * on the first. Throws if any node failed, BullMQ retries the whole job, so
 * `addUser`/`removeUser` MUST be idempotent on the node side (re-adding an
 * existing user is a no-op).
 */
async function fanOut<T, N extends NodeRow>(
  nodes: N[],
  call: (node: N) => Promise<T>,
  label: string,
): Promise<void> {
  if (nodes.length === 0) {
    getLogger().info(`[worker:node-users] ${label} - no active nodes, skipping`);
    return;
  }
  const results = await Promise.allSettled(
    nodes.map(async (node) => {
      await call(node);
      getLogger().info(`[worker:node-users] ${label} → ${node.name} ok`);
    }),
  );
  const failures = results.flatMap((r, i) =>
    r.status === 'rejected' ? [{ node: nodes[i]!, reason: r.reason }] : [],
  );
  for (const f of failures) {
    const detail =
      f.reason instanceof NodeRequestError
        ? `${f.reason.status} ${f.reason.message}`
        : String(f.reason);
    getLogger().info(`[worker:node-users] ${label} → ${f.node.name} FAILED: ${detail}`);
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((f) => f.reason),
      `${failures.length}/${nodes.length} nodes failed for ${label}`,
    );
  }
}

export async function syncAddUser(userId: string): Promise<void> {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: {
      id: true,
      status: true,
      shortId: true,
      username: true,
      hysteriaPassword: true,
      naivePassword: true,
      xrayUuid: true,
    },
  });
  if (!user) {
    getLogger().info(`[worker:node-users] addUser ${userId} - user not found, skipping`);
    return;
  }
  // #4 - status-gate. A stale addUser (enqueued before a flip to
  // limited/expired, or racing a removeUser for the same user) must not
  // resurrect a non-active user on the nodes. Together with syncRemoveUser's
  // gate this makes the node user-set converge to the live DB status no matter
  // what order the add/remove jobs happen to run in.
  if (user.status !== 'active') {
    getLogger().info(
      `[worker:node-users] addUser ${userId} - status=${user.status}, not active, skipping`,
    );
    return;
  }

  const base: AddUserRequest = {
    userId: user.id,
    shortId: user.shortId,
    username: user.username,
    credentials: {
      hysteriaPassword: user.hysteriaPassword,
      naivePassword: user.naivePassword,
      xrayUuid: user.xrayUuid,
      tuicUuid: user.xrayUuid,
      tuicPassword: deriveTuicPassword(user.xrayUuid),
      anytlsPassword: deriveAnytlsPassword(user.xrayUuid),
      shadowtlsPassword: deriveShadowtlsPassword(user.xrayUuid),
      mtprotoSecret: deriveMtprotoSecret(user.xrayUuid),
    },
  };

  /**
   * A-022: per node, and only where the user's squads reach. A node they
   * reach gets the user on exactly those inbounds (inboundIds); every other
   * node takes the user off. Before, one request went to the whole fleet and
   * put the user on every inbound of every node, whatever their squads.
   *
   * ⚠ A node that has never taken a push is skipped: an inbound list it cannot
   * match yet would take the user off everything there, and its first push
   * hands every user out anyway (the push job, after the agent applied).
   *
   * A-164: with the AmneziaWG peers of the user's devices, an address on each
   * generation the node serves and the user reaches, by the same rule as the
   * push. Without them the agent put no 1.x peer and took the user off 3.1.
   */
  const nodes = await fetchActiveNodes();
  const reach = (await reachOfUsers([userId])).get(userId) ?? new Map<string, string[]>();
  await fanOut(
    nodes,
    async (node) => {
      const transport = new NodeTransport(node);
      const inboundIds = reach.get(node.id);
      if (!inboundIds) {
        await transport.removeUser({ userId });
        return;
      }
      if (node.lastInboundSyncAt === null) return;
      const awg = await awgBindingsOfNode(node.id);
      const awgCreds = await awgCredentialsOf(awg, [
        {
          id: user.id,
          username: user.username,
          reachesOne: !!awg.one && inboundIds.includes(awg.one),
          reachesThree: !!awg.three && inboundIds.includes(awg.three),
        },
      ]);
      await transport.addUser({
        ...base,
        inboundIds,
        credentials: { ...base.credentials, ...awgCreds.get(user.id) },
      });
    },
    `addUser ${userId}`,
  );

  /**
   * A-134: the cascade entries this user reaches draw who may take which tag,
   * and a user they have not seen yet falls into the trap there (closed by
   * default). So each such entry is pushed again, and the push carries the
   * user's tags. The jobId folds a wave of these into one push per entry.
   */
  const entries = await prisma.cascadePosition.findMany({
    where: {
      position: 0,
      cascade: { enabled: true },
      nodes: { some: { nodeId: { in: [...reach.keys()] } } },
    },
    select: { nodes: { select: { nodeId: true } } },
  });
  const toPush = new Set(entries.flatMap((e) => e.nodes.map((n) => n.nodeId)).filter((id) => reach.has(id)));
  for (const nodeId of toPush) await enqueueNodePush(nodeId);
}

async function syncRemoveUser(userId: string): Promise<void> {
  // #4 - status-gate. Skip the removal if the user is currently active and not
  // soft-deleted: a stale removeUser (the user was flipped back to active by a
  // traffic reset after this job was enqueued, or it races an addUser) must
  // not drop a live user. A non-active, soft-deleted, or missing user proceeds
  // to removal (idempotent node-side no-op if it is already gone). Pairs with
  // syncAddUser's gate so the terminal node state always matches DB status.
  const user = await prisma.user.findFirst({
    where: { id: userId },
    select: { status: true, deletedAt: true },
  });
  if (user && user.deletedAt === null && user.status === 'active') {
    getLogger().info(`[worker:node-users] removeUser ${userId} - user is active, skipping`);
    return;
  }

  const req: RemoveUserRequest = { userId };
  const nodes = await fetchActiveNodes();
  await fanOut(
    nodes,
    (node) => new NodeTransport(node).removeUser(req),
    `removeUser ${userId}`,
  );
}

/**
 * A freshly registered node gets its users from its first inbound push
 * (node.created queues it): the push job hands each user out on exactly the
 * inbounds their squads reach, after the agent has applied them (A-022).
 *
 * This used to send every active user here with no inbound list. Kept as a
 * job name so jobs already queued drain quietly; it no longer sends anything,
 * since an inbound list sent before the first push would take the user off
 * everything on a node that knows no inbound yet.
 */
async function syncBackfillNode(nodeId: string): Promise<void> {
  getLogger().info(`[worker:node-users] backfillNode ${nodeId} - users come with the node's first push, nothing to do`);
}
// ───── Worker ─────

export function startNodeUsersWorker(): Worker<NodeUserJobData> {
  return new Worker<NodeUserJobData>(
    QUEUE_NAME,
    async (job: Job<NodeUserJobData>) => {
      switch (job.name) {
        case 'addUser': {
          const { userId } = job.data as AddUserJobData;
          await syncAddUser(userId);
          break;
        }
        case 'removeUser': {
          const { userId } = job.data as RemoveUserJobData;
          await syncRemoveUser(userId);
          break;
        }
        case 'backfillNode': {
          const { nodeId } = job.data as BackfillNodeJobData;
          await syncBackfillNode(nodeId);
          break;
        }
        default:
          throw new Error(`Unknown job name: ${job.name}`);
      }
    },
    {
      connection: redis,
      concurrency: 5,
    },
  );
}
