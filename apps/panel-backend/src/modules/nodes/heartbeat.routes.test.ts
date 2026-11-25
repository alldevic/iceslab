import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis, redis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import * as queue from '../inbounds/inbounds.queue.js';
import { signHeartbeatToken } from './heartbeat-token.js';

/**
 * The heartbeat route: which of its answers a node receives, and the
 * agent-restart detection. The marker `node:<id>:agentStartTime`
 * says "this start-time has been seen", so it is written after the resync it
 * stands for has been queued: a failed enqueue must leave the old value, or the
 * next heartbeat reads "unchanged" and the restarted agent is never re-pushed.
 */
let app: FastifyInstance;
let nodeId: string;
let token: string;
const markerKey = () => `node:${nodeId}:agentStartTime`;

const revisionOf = async (id: string) =>
  (await prisma.node.findUniqueOrThrow({ where: { id }, select: { desiredRevision: true } })).desiredRevision;

const URL = '/api/internal/nodes/me/status';

async function makeNode(opts: { status?: string; deleted?: boolean } = {}) {
  const secret = randomBytes(32);
  const node = await prisma.node.create({
    data: {
      name: `hb-x-${randomBytes(3).toString('hex')}`,
      address: 'hbx.example.test:1337',
      protocol: 'xray',
      status: opts.status ?? 'online',
      deletedAt: opts.deleted ? new Date() : null,
      heartbeatSecret: secret,
    },
    select: { id: true },
  });
  return { id: node.id, secret, token: signHeartbeatToken(node.id, secret) };
}

const poll = (bearer?: string, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'GET',
    url: URL,
    headers: { ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }), ...headers },
  });

const beat = (startTime: string) =>
  app.inject({
    method: 'GET',
    url: '/api/internal/nodes/me/status',
    headers: { authorization: `Bearer ${token}`, 'x-agent-start-time': startTime },
  });

/** trackAgentStart runs after the reply is sent; wait for the marker or the queue to settle. */
const settle = () => new Promise((r) => setTimeout(r, 150));

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  await queue.inboundSyncQueue.obliterate({ force: true });
  const secret = randomBytes(32);
  const n = await prisma.node.create({
    data: {
      name: `hb-${randomBytes(3).toString('hex')}`,
      address: 'hb.example.test:1337',
      protocol: 'xray',
      status: 'online',
      heartbeatSecret: secret,
    },
    select: { id: true },
  });
  nodeId = n.id;
  token = signHeartbeatToken(nodeId, secret);
  await redis.del(markerKey());
});

afterEach(async () => {
  vi.restoreAllMocks();
  await redis.del(markerKey());
  await queue.inboundSyncQueue.obliterate({ force: true });
  await app.close();
});

afterAll(async () => {
  await queue.inboundSyncQueue.close();
  await prisma.$disconnect();
  await closeRedis();
});

describe('heartbeat: agent restart marker', () => {
  it('the first heartbeat writes the marker and queues no resync', async () => {
    const res = await beat('1000');
    expect(res.statusCode).toBe(200);
    await settle();

    expect(await redis.get(markerKey())).toBe('1000');
    expect(await queue.inboundSyncQueue.getJob(`apply-${nodeId}`)).toBeUndefined();
  });

  it('a changed start time queues apply-<nodeId> and moves the marker', async () => {
    await redis.set(markerKey(), '1000');

    const res = await beat('2000');
    expect(res.statusCode).toBe(200);
    await settle();

    expect(await queue.inboundSyncQueue.getJob(`apply-${nodeId}`)).toBeTruthy();
    expect(await redis.get(markerKey())).toBe('2000');
  });

  it('a failed enqueue answers 200, keeps the old marker, and the next heartbeat queues the resync', async () => {
    await redis.set(markerKey(), '1000');
    // Both failure points of the push count: the revision UPDATE and the queue
    // add sit behind enqueueNodePush, which is what the heartbeat calls.
    const push = vi.spyOn(queue, 'enqueueNodePush').mockRejectedValueOnce(new Error('queue down'));

    const failed = await beat('2000');
    expect(failed.statusCode).toBe(200);
    await settle();
    expect(push).toHaveBeenCalledTimes(1);
    expect(await redis.get(markerKey()), 'the marker moved although the resync was never queued').toBe('1000');
    expect(await queue.inboundSyncQueue.getJob(`apply-${nodeId}`)).toBeUndefined();

    // Same value again, the queue is back (the stub only failed once).
    push.mockRestore();
    const retry = await beat('2000');
    expect(retry.statusCode).toBe(200);
    await settle();
    expect(await queue.inboundSyncQueue.getJob(`apply-${nodeId}`)).toBeTruthy();
    expect(await redis.get(markerKey())).toBe('2000');
  });
});

describe('a token that does not verify is 401, never 410', () => {
  // 410 is the one answer the agent acts on destructively: it must be reachable
  // only through deletion, never through a bad credential.
  it('answers 401 to a missing, malformed or forged bearer', async () => {
    const other = await makeNode();

    const cases: Array<[string, string | undefined]> = [
      ['no Authorization header at all', undefined],
      ['an empty bearer', ''],
      ['no dot separator', 'justgarbage'],
      ['a nodeId that is not a uuid', 'not-a-uuid.c2ln'],
      ['a uuid no node has', `${randomUUID()}.c2ln`],
      ["this node's id signed with another node's secret", signHeartbeatToken(nodeId, other.secret)],
      ['another node id with this signature', `${other.id}.${token.split('.')[1]}`],
    ];

    for (const [what, bearer] of cases) {
      const res = await poll(bearer);
      expect(res.statusCode, `${what} -> ${res.statusCode} ${res.body}`).toBe(401);
      expect(res.statusCode, `${what} must never be answered 410`).not.toBe(410);
    }
  });

  it('does not turn a malformed nodeId into a 500', async () => {
    expect((await poll('....')).statusCode).toBe(401);
  });

  it('refuses a valid token presented under a different scheme, even one as long as "Bearer "', async () => {
    for (const scheme of ['Token', 'Foobar', 'Basic']) {
      const res = await app.inject({ method: 'GET', url: URL, headers: { authorization: `${scheme} ${token}` } });
      expect(res.statusCode, `${scheme} was accepted as if it were Bearer`).toBe(401);
    }
  });

  it('answers 401 for a node that never existed and for a hard-deleted row', async () => {
    const ghost = signHeartbeatToken(randomUUID(), randomBytes(32));
    expect((await poll(ghost)).statusCode).toBe(401);

    const gone = await makeNode();
    await prisma.node.delete({ where: { id: gone.id } });
    expect((await poll(gone.token)).statusCode).toBe(401);
  });
});

describe('heartbeat: the answers for a valid token', () => {
  it('an active node is told active', async () => {
    const res = await poll(token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'active' });
  });

  it('an offline node is still active, not deleted', async () => {
    const n = await makeNode({ status: 'offline' });
    const res = await poll(n.token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'active' });
  });

  it('a disabled node is told disabled, not to go', async () => {
    const n = await makeNode({ status: 'disabled' });
    const res = await poll(n.token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'disabled' });
  });

  it('a soft-deleted node is told 410 GONE', async () => {
    const n = await makeNode({ deleted: true });
    const res = await poll(n.token);
    expect(res.statusCode).toBe(410);
    expect(res.json()).toEqual({ error: 'GONE' });
  });
});

describe('heartbeat: start-time header handling', () => {
  it('a changed start time queues exactly one resync with the shared apply-<nodeId> job id', async () => {
    await redis.set(markerKey(), '1000');
    const before = await revisionOf(nodeId);

    expect((await beat('2000')).statusCode).toBe(200);
    await settle();

    const job = await queue.inboundSyncQueue.getJob(`apply-${nodeId}`);
    expect(job?.data).toEqual({ nodeId });
    expect(await revisionOf(nodeId)).toBe(before + 1n);
  });

  it('the same value again queues nothing and leaves the revision alone', async () => {
    await redis.set(markerKey(), '1000');
    const before = await revisionOf(nodeId);

    for (let i = 0; i < 3; i += 1) await beat('1000');
    await settle();

    expect(await queue.inboundSyncQueue.getJob(`apply-${nodeId}`)).toBeUndefined();
    expect(await revisionOf(nodeId)).toBe(before);
  });

  it('a start time that is too long or the wrong shape is ignored and never stored', async () => {
    for (const bad of ['x'.repeat(65), 'has spaces', 'semi;colon', '{"json":true}']) {
      expect((await beat(bad)).statusCode, `${bad} should still be a normal heartbeat`).toBe(200);
    }
    await settle();
    expect(await redis.get(markerKey())).toBeNull();
  });

  it('a heartbeat without the header still answers and touches nothing', async () => {
    const res = await poll(token);
    expect(res.statusCode).toBe(200);
    await settle();
    expect(await redis.get(markerKey())).toBeNull();
    expect(await queue.inboundSyncQueue.getJob(`apply-${nodeId}`)).toBeUndefined();
  });
});
