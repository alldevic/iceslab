// The panel half of the self-destruct handshake.
//
// The node half is tested (apps/node/internal/heartbeat): it counts explicit
// 410s and stops the agent. This endpoint is what decides WHICH answer it gets,
// and until now nothing checked it. Measured: the whole suite of 1542 stayed
// green with a soft-deleted node answered `active`, and green again with an
// invalid token answered 410 instead of 401.
//
// Those two mutants are the two ways this fails, and they fail in opposite
// directions:
//
//   * a deleted node told "active" never self-destructs - the operator removed
//     it from the panel and it keeps serving traffic with the keys it has;
//   * a bad token answered 410 is fleet suicide. The node's own comment names
//     this exact scenario: "any future panel-side bug that broke HMAC
//     verification globally would silently kill every node in the fleet at
//     once." The agent's cold-boot gate only protects an agent that has never
//     seen `active`; every node already running has.
//
// So each test below states which of the four answers is expected AND that the
// other three are not.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { redis, closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { inboundSyncQueue, inboundDirtyKey } from '../inbounds/inbounds.queue.js';
import { signHeartbeatToken } from './heartbeat-token.js';

const URL = '/api/internal/nodes/me/status';

/** Poll an assertion until it holds or the deadline passes. The route fires the
 *  restart-detect without awaiting it, so nothing here can be read straight
 *  after the response. */
async function waitFor(check: () => void, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

let app: FastifyInstance;
let seq = 0;
/** Everything this file put into Redis or the queue, undone after each test. */
let touchedNodeIds: string[] = [];

async function makeNode(opts: { status?: string; deleted?: boolean } = {}) {
  seq += 1;
  const secret = randomBytes(32);
  const node = await prisma.node.create({
    data: {
      name: `hb-${seq}`,
      address: `hb-${seq}.example.com:1337`,
      heartbeatSecret: secret,
      status: opts.status ?? 'online',
      deletedAt: opts.deleted ? new Date() : null,
    },
  });
  touchedNodeIds.push(node.id);
  return { id: node.id, secret, token: signHeartbeatToken(node.id, secret) };
}

function poll(token?: string, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'GET',
    url: URL,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
  });
}

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  touchedNodeIds = [];
});

afterEach(async () => {
  await app.close();
  // The queue and Redis are shared with the rest of the suite (and with a live
  // panel, if one is up). Anything this file enqueued has to go, or the next
  // file's counts are wrong - the burst test already fails that way when a
  // live panel is running.
  for (const id of touchedNodeIds) {
    await redis.del(`node:${id}:agentStartTime`).catch(() => null);
    await redis.del(inboundDirtyKey(id)).catch(() => null);
    const job = await inboundSyncQueue.getJob(`apply-${id}`).catch(() => null);
    if (job) await job.remove().catch(() => null);
  }
});

afterAll(async () => {
  await inboundSyncQueue.close();
  await prisma.$disconnect();
  await closeRedis();
});

describe('a token that does not verify is 401, never 410', () => {
  // Every case here is a node that must STAY ALIVE. 410 is the one answer the
  // agent acts on destructively, so it must be reachable only by deletion.
  it('answers 401 to a missing, malformed or forged bearer', async () => {
    const node = await makeNode();
    const other = await makeNode();

    const cases: Array<[string, string | undefined]> = [
      ['no Authorization header at all', undefined],
      ['an empty bearer', ''],
      ['no dot separator', 'justgarbage'],
      ['a nodeId that is not a uuid', 'not-a-uuid.c2ln'],
      // A well-formed uuid nobody issued: the lookup finds no secret.
      ['a uuid no node has', `${randomUUID()}.c2ln`],
      // Right node, wrong signature: this is the forged-token case.
      [`this node's id signed with another node's secret`,
        signHeartbeatToken(node.id, other.secret)],
      // Right signature, wrong node: the HMAC covers the id, so it must not
      // transfer between nodes.
      ['another node id with this signature',
        `${other.id}.${node.token.split('.')[1]}`],
    ];

    for (const [what, token] of cases) {
      const res = await poll(token);
      expect(res.statusCode, `${what} -> ${res.statusCode} ${res.body}`).toBe(401);
      expect(res.statusCode, `${what} must never be answered 410`).not.toBe(410);
    }
  });

  // A malformed uuid used to reach the UUID column and surface as a Prisma
  // P2023 -> 500. A 5xx is not destructive, but it is also not the answer, and
  // it turns a bad token into a panel error in the logs of every operator.
  it('does not turn a malformed nodeId into a 500', async () => {
    const res = await poll('....');
    expect(res.statusCode).toBe(401);
  });

  // The scheme has to be CHECKED, not assumed and sliced off. `Token <t>` is
  // refused either way (slicing seven characters off it leaves garbage), so it
  // proves nothing on its own - the case that separates the two is a scheme of
  // exactly the same length as "Bearer ", where a blind slice hands the
  // verifier a perfectly good token.
  it('refuses a valid token presented under a different scheme', async () => {
    const node = await makeNode();
    for (const scheme of ['Token', 'Foobar', 'Basic']) {
      const res = await app.inject({
        method: 'GET',
        url: URL,
        headers: { authorization: `${scheme} ${node.token}` },
      });
      expect(res.statusCode, `${scheme} was accepted as if it were Bearer`).toBe(401);
    }
  });
});

describe('the four answers', () => {
  it('tells a registered node it is active', async () => {
    const node = await makeNode();
    const res = await poll(node.token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'active' });
  });

  // Disabled is an admin pause and admins toggle it. Answering 410 here would
  // destroy a node on its way back.
  it('tells a disabled node it is disabled, and does not tell it to go', async () => {
    const node = await makeNode({ status: 'disabled' });
    const res = await poll(node.token);
    expect(res.statusCode, 'a paused node must not be told to self-destruct').toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'disabled' });
  });

  // The one destructive answer, and the only path to it.
  it('tells a soft-deleted node it is gone', async () => {
    const node = await makeNode({ deleted: true });
    const res = await poll(node.token);
    expect(
      res.statusCode,
      'a node the operator deleted must be told 410, or it keeps serving traffic ' +
        'with the keys it already has',
    ).toBe(410);
  });

  // A hard delete (rather than the soft delete the panel uses) takes the
  // secret with the row, so verification fails before the deletedAt check ever
  // runs and the answer is 401, not 410. That is the safe side: the agent
  // keeps waiting instead of destroying itself over a row that might have gone
  // missing for some other reason. Asserted as 401 rather than "401 or 410",
  // because a test that accepts both would not notice either changing.
  it('answers a node whose row is gone entirely with 401, not 410', async () => {
    const node = await makeNode();
    await prisma.node.delete({ where: { id: node.id } });
    const res = await poll(node.token);
    expect(res.statusCode).toBe(401);
  });

  // Status is only about liveness reporting; a node marked down by the poller
  // is still a node the operator wants back.
  it('does not treat an offline node as deleted', async () => {
    const node = await makeNode({ status: 'offline' });
    const res = await poll(node.token);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('active');
  });
});

describe('agent restart is detected from the start-time header', () => {
  // The route fires the restart-detect WITHOUT awaiting it, on purpose: a
  // Redis hiccup must not fail the heartbeat itself. So the assertion has to
  // wait for the work rather than read straight after the response - and the
  // NEGATIVE cases have to wait just as long, or they pass because nothing has
  // happened yet rather than because nothing will.
  const SETTLE_MS = 1500;

  // Why a failure here can be the machine rather than the code.
  //
  // Every case below reads the job out of the REAL `inbound-sync` queue, and
  // that queue lives in the Redis named by .env.test - which on a developer's
  // box is the same Redis a locally running panel uses. That panel runs the
  // worker, so it consumes and removes the job this file enqueued, and
  // `getJob` then answers `null`: identical to "the route never enqueued it".
  // Two hours were spent on that once. So it is asked outright, first, in a
  // case that names the cause instead of leaving it to look like a defect.
  it('runs against a queue nobody else is consuming', async () => {
    const workers = await inboundSyncQueue.getWorkers();
    expect(
      workers.map((w) => w.name),
      'something else is running the inbound-sync worker on this Redis - almost always a panel ' +
        'still up on :3000. It eats the job the cases below look for, and they will read that ' +
        'as "the route did not enqueue". Stop the panel, or point REDIS_URL somewhere else.',
    ).toEqual([]);
  });

  async function queuedResync(nodeId: string) {
    const deadline = Date.now() + SETTLE_MS;
    for (;;) {
      const job = await inboundSyncQueue.getJob(`apply-${nodeId}`);
      if (job) return job;
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  // First contact carries a value the panel has never seen. That is also what
  // a panel cold start looks like (Redis empty) with an agent that never
  // restarted, so it must NOT fan out - it would re-push the whole fleet every
  // time the panel comes up.
  it('does not resync on the first value it ever sees', async () => {
    const node = await makeNode();
    const res = await poll(node.token, { 'x-agent-start-time': '1747000000000000000' });
    expect(res.statusCode).toBe(200);

    expect(await queuedResync(node.id), 'first-seen must not enqueue a re-push').toBeFalsy();
    expect(await redis.get(`node:${node.id}:agentStartTime`)).toBe('1747000000000000000');
  });

  // The gap this closes: an agent restart wipes its in-memory user map, and
  // iOS auth callbacks 404'd until an admin happened to toggle a profile.
  it('resyncs when the value changes', async () => {
    const node = await makeNode();
    await poll(node.token, { 'x-agent-start-time': '1747000000000000000' });
    const res = await poll(node.token, { 'x-agent-start-time': '1747999999999999999' });
    expect(res.statusCode).toBe(200);

    const job = await queuedResync(node.id);
    expect(job, 'a changed start-time means the agent restarted and lost its users').toBeTruthy();
    expect(job!.data).toEqual({ nodeId: node.id });
    // The jobId must be the shared `apply-<nodeId>`: the worker runs with
    // concurrency > 1 and relies on one jobId per node to serialise pushes. A
    // private id let a resync race a binding edit into two simultaneous
    // protocol restarts on one host.
    expect(job!.id).toBe(`apply-${node.id}`);
    // Dirty flag set BEFORE the enqueue, so a push already in flight re-runs
    // at the end instead of swallowing this resync.
    expect(await redis.get(inboundDirtyKey(node.id))).toBe('1');
  });

  it('stays quiet while the value keeps repeating', async () => {
    const node = await makeNode();
    for (let i = 0; i < 3; i += 1) {
      await poll(node.token, { 'x-agent-start-time': '1747000000000000000' });
    }
    expect(
      await queuedResync(node.id),
      'a node polling once a minute would otherwise re-push itself forever',
    ).toBeFalsy();
  });

  // The header is attacker-influenced (it arrives with a token that may have
  // leaked), and it is written into a node-scoped Redis key. Anything that is
  // not the identifier we emit ourselves is dropped rather than stored.
  it('ignores a start-time that is too long or the wrong shape', async () => {
    const node = await makeNode();
    for (const bad of ['x'.repeat(65), 'has spaces', 'semi;colon', '{"json":true}']) {
      const res = await poll(node.token, { 'x-agent-start-time': bad });
      expect(res.statusCode, `${bad} should still be a normal heartbeat`).toBe(200);
      await new Promise((r) => setTimeout(r, 100));
      expect(
        await redis.get(`node:${node.id}:agentStartTime`),
        `${bad} was written into Redis under the node's key`,
      ).toBeNull();
    }
  });

  // What the stored value MEANS, and the only case that tells the two possible
  // meanings apart. "This start-time has been seen" and "the resync for this
  // start-time was enqueued" are the same sentence until the enqueue fails -
  // and then the first one is a lie that never expires, because the next
  // heartbeat reads `previous === startTime` and stays quiet. The agent
  // restarted, its user map is empty, and nothing re-pushes until an admin
  // toggles a profile by hand.
  //
  // The trigger is narrow (BullMQ refusing a job while the app's own Redis
  // client still answers - a panel shutting down, a queue already closed, an
  // OOM that the small SET survives). The cost is not: it is permanent, silent
  // and per node.
  it('does not record a start-time whose resync could not be enqueued', async () => {
    const node = await makeNode();
    await poll(node.token, { 'x-agent-start-time': '1747000000000000000' });

    const add = vi
      .spyOn(inboundSyncQueue, 'add')
      .mockRejectedValueOnce(new Error('queue is closed'));
    const res = await poll(node.token, { 'x-agent-start-time': '1747999999999999999' });
    // The heartbeat itself must still succeed: the resync is fire-and-forget
    // precisely so a Redis hiccup does not take a node's liveness with it.
    expect(res.statusCode).toBe(200);

    // The control: the enqueue has to have been attempted, or the assertion
    // below is about a code path that never ran.
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    add.mockRestore();

    expect(
      await redis.get(`node:${node.id}:agentStartTime`),
      'the marker was advanced for a resync that never got queued; the next heartbeat will stay quiet forever',
    ).toBe('1747000000000000000');

    // And the other half - the next heartbeat, with the same value the failed
    // one carried, still resyncs.
    await poll(node.token, { 'x-agent-start-time': '1747999999999999999' });
    expect(await queuedResync(node.id), 'the retry a minute later must resync').toBeTruthy();
    expect(await redis.get(`node:${node.id}:agentStartTime`)).toBe('1747999999999999999');
  });

  // A heartbeat with no header at all is an older agent. It must keep working.
  it('serves an agent that sends no start-time', async () => {
    const node = await makeNode();
    const res = await poll(node.token);
    expect(res.statusCode).toBe(200);
    expect(await redis.get(`node:${node.id}:agentStartTime`)).toBeNull();
  });
});
