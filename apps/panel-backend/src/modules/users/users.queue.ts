import { Queue, Worker, type Job } from 'bullmq';
import type { AddUserRequest, RemoveUserRequest } from '@iceslab/shared';
import { queueRedis } from '../../lib/redis.js';
import { prisma } from '../../prisma.js';
import { NodeTransport, NodeRequestError } from '../nodes/nodes.transport.js';
import { deriveTuicPassword, deriveAnytlsPassword, deriveShadowtlsPassword, deriveMtprotoSecret } from '../../lib/credentials.js';
import { getLogger } from '../../lib/logger.js';
import { mtprotoNodesForUser, mtprotoUsersForNode } from '../inbounds/mtproto-access.js';

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
  connection: queueRedis,
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

async function fetchActiveNodes(): Promise<NodeRow[]> {
  return prisma.node.findMany({
    where: { deletedAt: null, status: { not: 'disabled' } },
    select: { id: true, name: true, address: true },
  });
}

/**
 * Fan-out a single addUser/removeUser call to every active node, awaiting all
 * outcomes (allSettled) so we surface ALL failures rather than short-circuit
 * on the first. Throws if any node failed, BullMQ retries the whole job, so
 * `addUser`/`removeUser` MUST be idempotent on the node side (re-adding an
 * existing user is a no-op).
 */
async function fanOut<T>(
  nodes: NodeRow[],
  call: (node: NodeRow) => Promise<T>,
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

/**
 * The node payload for one user, or why there is none.
 *
 * Exported because the Remnawave-compat facade's connection-drop needs the exact
 * same request to add a user back after removing them, and a second copy of this
 * object is a place for the two to drift: every credential the cores derive
 * (tuic / anytls / shadowtls all hang off xrayUuid) would have to be re-derived
 * identically in both, and a mismatch is a user the node accepts and no client
 * can authenticate as.
 *
 * The status gate lives here too, so both callers inherit it: a user who is not
 * active must never be pushed to a node, whichever path asked.
 */
export type AddUserPayload =
  | { kind: 'ok'; req: AddUserRequest }
  | { kind: 'not-found' }
  | { kind: 'not-active'; status: string };

export async function buildAddUserRequest(userId: string): Promise<AddUserPayload> {
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
      amneziawgPublicKey: true,
      // The MTProto backstops travel with the user, so the push has to read
      // them. Nothing else on this path uses either field.
      expireAt: true,
      trafficLimitBytes: true,
    },
  });
  if (!user) return { kind: 'not-found' };
  // #4 - status-gate. A stale addUser (enqueued before a flip to
  // limited/expired, or racing a removeUser for the same user) must not
  // resurrect a non-active user on the nodes. Together with syncRemoveUser's
  // gate this makes the node user-set converge to the live DB status no matter
  // what order the add/remove jobs happen to run in.
  if (user.status !== 'active') return { kind: 'not-active', status: user.status };
  return {
    kind: 'ok',
    req: {
      userId: user.id,
      shortId: user.shortId,
      username: user.username,
      credentials: {
        hysteriaPassword: user.hysteriaPassword,
        naivePassword: user.naivePassword,
        xrayUuid: user.xrayUuid,
        // No wg credentials from this queue, deliberately. The node needs a
        // public key AND an allocated address to make a peer and returns nil
        // when either is missing - so every wg field sent from here has always
        // been dropped on arrival while `addUser ... ok` was logged. Sending a
        // key that cannot take effect only makes that silence look like a
        // configuration to inspect. Slice 51 turned it from inert into wrong
        // as well: the credential now belongs to a device, and this row's
        // column is the pre-devices seed.
        //
        // wg peers come from the inbound-sync push, which is the only place
        // that knows the bound profiles and therefore the subnets. Enabling a
        // user does NOT restore their wg access on its own; measured
        // 2026-08-31.
        //
        // wireguardPublicKey / amneziawgPublicKey: intentionally absent.
        tuicUuid: user.xrayUuid,
        tuicPassword: deriveTuicPassword(user.xrayUuid),
        anytlsPassword: deriveAnytlsPassword(user.xrayUuid),
        shadowtlsPassword: deriveShadowtlsPassword(user.xrayUuid),
        // NOT here: this request goes to every node, and the MTProto secret is
        // the one credential in this blob that is not inert on arrival — the
        // mtprotoproxy adapter writes what it receives into USERS, so sending it
        // IS granting access. Which node may grant it depends on the squads, so
        // the caller adds it per node (see withMtprotoFor / mtproto-access.ts).
        // Sending it here made every inbound serve everyone the node knew.
        // The two MTProto backstops. The panel is what actually cuts an
        // expired or over-quota user off — it stops pushing them; these bound
        // the window where it cannot reach the node. Quota is the WHOLE
        // allowance, not the remainder: mtprotoproxy counts from zero at every
        // process start and knows nothing about billing periods, so a
        // remainder would cut people well inside their plan.
        mtprotoExpiresAt: user.expireAt ? user.expireAt.toISOString() : undefined,
        mtprotoQuotaBytes:
          user.trafficLimitBytes !== null ? Number(user.trafficLimitBytes) : undefined,
      },
    },
  };
}

/**
 * The same request with the MTProto secret added, or left out, for ONE node.
 *
 * `undefined` is not merely "nothing to say": the mtprotoproxy adapter reads a
 * person record without a secret as "this person is not entitled here" and drops
 * them if it holds them. That is what makes a squad change take effect on the
 * proxy rather than only on the link the buyer is shown.
 */
function withMtprotoFor(
  req: AddUserRequest,
  xrayUuid: string,
  entitled: boolean,
): AddUserRequest {
  return {
    ...req,
    credentials: {
      ...req.credentials,
      mtprotoSecret: entitled ? deriveMtprotoSecret(xrayUuid) : undefined,
    },
  };
}

async function syncAddUser(userId: string): Promise<void> {
  const payload = await buildAddUserRequest(userId);
  if (payload.kind === 'not-found') {
    getLogger().info(`[worker:node-users] addUser ${userId} - user not found, skipping`);
    return;
  }
  if (payload.kind === 'not-active') {
    getLogger().info(
      `[worker:node-users] addUser ${userId} - status=${payload.status}, not active, skipping`,
    );
    return;
  }
  const req = payload.req;

  const nodes = await fetchActiveNodes();
  const mtprotoNodes = await mtprotoNodesForUser(userId);
  await fanOut(
    nodes,
    (node) =>
      new NodeTransport(node).addUser(
        withMtprotoFor(req, req.credentials.xrayUuid ?? '', mtprotoNodes.has(node.id)),
      ),
    `addUser ${userId}`,
  );
}

/**
 * Every id the node knows this person by, so removal can name all of them.
 *
 * A wg peer is dropped by the id it was ADDED under, and it was added under a
 * DEVICE id (`userId: peer.deviceId`, inbounds.queue.ts). The agent keeps peers
 * in `a.peers[userID]` and returns nil on a key it does not hold, without a
 * word. So a removal carrying only the person's id took them out of xray and
 * sing-box and touched no wg peer at all: a disabled buyer kept using WireGuard
 * and AmneziaWG for as long as they liked. Measured on s2 2026-09-01 - after
 * `status: disabled` the panel stopped publishing the peer (3 users + 9 device
 * records pushed, down from 4 and 12) and all three peers stayed on the node.
 *
 * Devices are taken ALL of them, revoked included: `revokeDevice` already sent
 * its own removeUser and a repeat is an idempotent no-op on the agent, whereas
 * skipping a device revoked in the same breath would be a hole.
 *
 * Exported for the test that pins this.
 */
export async function removalTargetsFor(userId: string): Promise<string[]> {
  const devices = await prisma.wgDevice.findMany({
    where: { userId },
    select: { id: true },
  });
  return [userId, ...devices.map((d) => d.id)];
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

  const nodes = await fetchActiveNodes();

  const targets = await removalTargetsFor(userId);
  for (const target of targets) {
    const req: RemoveUserRequest = { userId: target };
    await fanOut(
      nodes,
      (node) => new NodeTransport(node).removeUser(req),
      target === userId ? `removeUser ${userId}` : `removeUser device ${target}`,
    );
  }
}

/**
 * Push every active user to a single freshly-registered node. Run on
 * `node.created` so an empty new node doesn't stay empty until each user
 * is mutated again. AddUser is idempotent on the node side, so this is
 * also safe to re-run (e.g. from a future "Sync users" admin button).
 */
async function syncBackfillNode(nodeId: string): Promise<void> {
  const node = await prisma.node.findFirst({
    where: { id: nodeId, deletedAt: null, status: { not: 'disabled' } },
    select: { id: true, name: true, address: true },
  });
  if (!node) {
    getLogger().info(`[worker:node-users] backfillNode ${nodeId} - node not active, skipping`);
    return;
  }

  // Who this node may serve MTProto to, read once for the whole backfill: the
  // answer is a property of the node's bindings and the squads, and neither
  // moves while the pages are streaming.
  const mtprotoUsers = await mtprotoUsersForNode(nodeId);

  interface BackfillUserRow {
    id: string;
    shortId: string;
    username: string;
    hysteriaPassword: string;
    naivePassword: string;
    xrayUuid: string;
    amneziawgPublicKey: string;
    expireAt: Date | null;
    trafficLimitBytes: bigint | null;
  }

  // B14 - stream active users in id-ordered cursor pages instead of loading the
  // whole active set into memory, and fan out addUser in bounded chunks rather
  // than one unbounded Promise.allSettled (a 1000-user backfill previously fired
  // 1000 simultaneous mTLS calls at the single-process Go agent). PAGE bounds
  // memory; CHUNK bounds in-flight requests (mirrors inbounds.queue's value).
  const BACKFILL_PAGE = 500;
  const ADD_USER_CHUNK = 25;
  const transport = new NodeTransport(node);

  const failures: { username: string; reason: unknown }[] = [];
  let total = 0;
  let cursor: string | undefined;

  for (;;) {
    const page: BackfillUserRow[] = await prisma.user.findMany({
      where: { deletedAt: null, status: 'active' },
      select: {
        id: true,
        shortId: true,
        username: true,
        hysteriaPassword: true,
        naivePassword: true,
        xrayUuid: true,
        amneziawgPublicKey: true,
        expireAt: true,
        trafficLimitBytes: true,
      },
      orderBy: { id: 'asc' },
      take: BACKFILL_PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1]!.id;
    total += page.length;

    for (let i = 0; i < page.length; i += ADD_USER_CHUNK) {
      const chunk = page.slice(i, i + ADD_USER_CHUNK);
      const results = await Promise.allSettled(
        chunk.map((u) => {
          const req: AddUserRequest = {
            userId: u.id,
            shortId: u.shortId,
            username: u.username,
            credentials: {
              hysteriaPassword: u.hysteriaPassword,
              naivePassword: u.naivePassword,
              xrayUuid: u.xrayUuid,
              // Same as above: the node drops wg fields with no address, and
              // the credential is the device's now. See the note in
              // buildAddUserRequest.
              // wireguardPublicKey / amneziawgPublicKey: intentionally absent.
              tuicUuid: u.xrayUuid,
              tuicPassword: deriveTuicPassword(u.xrayUuid),
              anytlsPassword: deriveAnytlsPassword(u.xrayUuid),
              shadowtlsPassword: deriveShadowtlsPassword(u.xrayUuid),
              // Only where a squad of theirs grants an mtproto profile on THIS
              // node; see mtproto-access.ts. Absent is the revocation.
              mtprotoSecret: mtprotoUsers.has(u.id) ? deriveMtprotoSecret(u.xrayUuid) : undefined,
              // See buildAddUserRequest for what these bound and why the quota is
              // the whole allowance.
              mtprotoExpiresAt: u.expireAt ? u.expireAt.toISOString() : undefined,
              mtprotoQuotaBytes:
                u.trafficLimitBytes !== null ? Number(u.trafficLimitBytes) : undefined,
            },
          };
          return transport.addUser(req);
        }),
      );
      for (let j = 0; j < results.length; j++) {
        const r = results[j]!;
        if (r.status === 'rejected') {
          const reason = r.reason;
          const detail =
            reason instanceof NodeRequestError
              ? `${reason.status} ${reason.message}`
              : String(reason);
          getLogger().info(
            `[worker:node-users] backfillNode ${node.name} → ${chunk[j]!.username} FAILED: ${detail}`,
          );
          failures.push({ username: chunk[j]!.username, reason });
        }
      }
    }

    if (page.length < BACKFILL_PAGE) break;
  }

  if (total === 0) {
    getLogger().info(`[worker:node-users] backfillNode ${node.name} - no active users, skipping`);
    return;
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((f) => f.reason),
      `${failures.length}/${total} users failed to backfill onto ${node.name}`,
    );
  }
  getLogger().info(`[worker:node-users] backfillNode ${node.name} - ${total} user(s) ok`);
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
      connection: queueRedis,
      concurrency: 5,
    },
  );
}
