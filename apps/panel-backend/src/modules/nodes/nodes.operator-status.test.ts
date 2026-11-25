import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { eventBus } from '../../lib/infra/event-bus.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { inboundSyncQueue } from '../inbounds/inbounds.queue.js';
import { NodeTransport } from './nodes.transport.js';
import { pollNodeStatuses } from './nodes.cron.js';

/**
 * The operator's half of a node's status. `disabled` is read in eight places
 * (subscription, both pollers, the queues, the heartbeat answer); without a way
 * to set and clear it through the API it could be done only by SQL.
 */
describe('a node taken out of service and back', () => {
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
  const put = (id: string, payload: unknown) =>
    app.inject({ method: 'PUT', url: `/api/nodes/${id}`, headers: auth(), payload });
  const row = (id: string) => prisma.node.findUniqueOrThrow({ where: { id } });

  async function node(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: auth(),
      payload: { name: 'os1', address: 'os1.test' },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (JSON.parse(res.body) as { id: string }).id;
  }

  it('disabled is written, moves lastStatusChange and is announced', async () => {
    const id = await node();
    const before = new Date(Date.now() - 3600_000);
    await prisma.node.update({ where: { id }, data: { status: 'online', lastStatusChange: before } });
    const emit = vi.spyOn(eventBus, 'emit');

    const res = await put(id, { status: 'disabled' });
    expect(res.statusCode, res.body).toBe(200);
    const after = await row(id);
    expect(after.status).toBe('disabled');
    expect(after.lastStatusChange!.getTime()).toBeGreaterThan(before.getTime());
    expect(emit).toHaveBeenCalledWith('node.status-changed', { nodeId: id, from: 'online', to: 'disabled' });
  });

  it('active brings a disabled node back as unknown, for the poller to decide', async () => {
    const id = await node();
    const before = new Date(Date.now() - 3600_000);
    await prisma.node.update({ where: { id }, data: { status: 'disabled', lastStatusChange: before } });
    const emit = vi.spyOn(eventBus, 'emit');

    const res = await put(id, { status: 'active' });
    expect(res.statusCode, res.body).toBe(200);
    const after = await row(id);
    expect(after.status).toBe('unknown');
    expect(after.lastStatusChange!.getTime()).toBeGreaterThan(before.getTime());
    expect(emit).toHaveBeenCalledWith('node.status-changed', { nodeId: id, from: 'disabled', to: 'unknown' });
  });

  it('active on a node in service changes nothing the poller said', async () => {
    const id = await node();
    const emit = vi.spyOn(eventBus, 'emit');
    for (const status of ['online', 'unreachable'] as const) {
      const at = new Date(Date.now() - 3600_000);
      await prisma.node.update({ where: { id }, data: { status, lastStatusChange: at } });
      expect((await put(id, { status: 'active' })).statusCode).toBe(200);
      const after = await row(id);
      expect(after.status).toBe(status);
      expect(after.lastStatusChange!.getTime()).toBe(at.getTime());
    }
    expect(emit).not.toHaveBeenCalledWith('node.status-changed', expect.anything());
  });

  it('refuses the poller\'s statuses', async () => {
    const id = await node();
    for (const status of ['online', 'degraded', 'unreachable', 'unknown']) {
      expect((await put(id, { status })).statusCode, status).toBe(400);
    }
  });

  it('a save without status leaves status, lastStatusChange and the event alone', async () => {
    const id = await node();
    const at = new Date(Date.now() - 3600_000);
    await prisma.node.update({ where: { id }, data: { status: 'disabled', lastStatusChange: at } });
    const emit = vi.spyOn(eventBus, 'emit');

    expect((await put(id, { name: 'os1-renamed' })).statusCode).toBe(200);
    const after = await row(id);
    expect(after.status).toBe('disabled');
    expect(after.lastStatusChange!.getTime()).toBe(at.getTime());
    expect(emit).not.toHaveBeenCalledWith('node.status-changed', expect.anything());
  });

  it('a returned node: the next tick answers it, queues apply-<id> and sets online', async () => {
    const id = await node();
    await prisma.node.update({ where: { id }, data: { status: 'disabled' } });
    const add = vi.spyOn(inboundSyncQueue, 'add').mockResolvedValue({} as never);
    vi.spyOn(NodeTransport.prototype, 'presentedCert').mockRejectedValue(new Error('no node here'));
    const health = vi.spyOn(NodeTransport.prototype, 'healthcheck').mockResolvedValue({ status: 'ok', cores: [] } as never);

    // While out of service the poller does not ask.
    await pollNodeStatuses();
    expect(health).not.toHaveBeenCalled();
    expect((await row(id)).status).toBe('disabled');

    expect((await put(id, { status: 'active' })).statusCode).toBe(200);
    await pollNodeStatuses();
    expect(health).toHaveBeenCalledTimes(1);
    expect((await row(id)).status).toBe('online');
    expect(add).toHaveBeenCalledWith('applyNodeInbounds', { nodeId: id }, { jobId: `apply-${id}` });
  });
});
