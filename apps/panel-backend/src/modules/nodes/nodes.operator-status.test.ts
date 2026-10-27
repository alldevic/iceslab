import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { eventBus } from '../../lib/infra/event-bus.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';

/**
 * The operator's half of a node's status, and the cold-pool labels that ride
 * in its hardening blob. `disabled` is how a node sits in the cold pool and
 * what a hotswap leaves a burned node in; without a way to set and clear it
 * through the API, a node could be put there only by SQL and never brought
 * back.
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
  const put = (id: string, payload: unknown) => app.inject({ method: 'PUT', url: `/api/nodes/${id}`, headers: auth(), payload });

  async function node(): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/nodes', headers: auth(), payload: { name: 'os1', address: 'os1.test' } });
    expect(res.statusCode, res.body).toBe(201);
    return (JSON.parse(res.body) as { id: string }).id;
  }

  it('disabled is written and announced; active brings it back as unknown, for the poller to decide', async () => {
    const id = await node();
    await prisma.node.update({ where: { id }, data: { status: 'online' } });
    const emit = vi.spyOn(eventBus, 'emit');

    const off = await put(id, { status: 'disabled' });
    expect(off.statusCode, off.body).toBe(200);
    expect((await prisma.node.findUniqueOrThrow({ where: { id } })).status).toBe('disabled');
    expect(emit).toHaveBeenCalledWith('node.status-changed', { nodeId: id, from: 'online', to: 'disabled' });

    const on = await put(id, { status: 'active' });
    expect(on.statusCode, on.body).toBe(200);
    expect((await prisma.node.findUniqueOrThrow({ where: { id } })).status).toBe('unknown');
  });

  it('active on a node in service changes nothing the poller said', async () => {
    const id = await node();
    await prisma.node.update({ where: { id }, data: { status: 'degraded' } });
    expect((await put(id, { status: 'active' })).statusCode).toBe(200);
    expect((await prisma.node.findUniqueOrThrow({ where: { id } })).status).toBe('degraded');
  });

  it('refuses the poller\'s statuses', async () => {
    const id = await node();
    expect((await put(id, { status: 'online' })).statusCode).toBe(400);
  });

  // The node form knows nothing of the pool. Saving it must not put a burned
  // IP back among the spares.
  it('an edit whose hardening does not name the pool keeps the labels', async () => {
    const id = await node();
    await prisma.node.update({ where: { id }, data: { hardening: { fail2ban: true, pool: { asn: 'AS1', burned: true } } } });

    expect((await put(id, { hardening: { ufwLockdown: true } })).statusCode).toBe(200);
    expect((await prisma.node.findUniqueOrThrow({ where: { id } })).hardening).toEqual({
      ufwLockdown: true,
      pool: { asn: 'AS1', burned: true },
    });

    expect((await put(id, { hardening: null })).statusCode).toBe(200);
    expect((await prisma.node.findUniqueOrThrow({ where: { id } })).hardening).toEqual({ pool: { asn: 'AS1', burned: true } });

    expect((await put(id, { hardening: { pool: { asn: 'AS2' } } })).statusCode).toBe(200);
    expect((await prisma.node.findUniqueOrThrow({ where: { id } })).hardening).toEqual({ pool: { asn: 'AS2' } });
  });
});
