import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis, redis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import * as queue from '../inbounds/inbounds.queue.js';
import { signHeartbeatToken } from './heartbeat-token.js';

/**
 * The heartbeat's agent-restart detection. The marker `node:<id>:agentStartTime`
 * says "this start-time has been seen", so it is written after the resync it
 * stands for has been queued: a failed enqueue must leave the old value, or the
 * next heartbeat reads "unchanged" and the restarted agent is never re-pushed.
 */
let app: FastifyInstance;
let nodeId: string;
let token: string;
const markerKey = () => `node:${nodeId}:agentStartTime`;

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
