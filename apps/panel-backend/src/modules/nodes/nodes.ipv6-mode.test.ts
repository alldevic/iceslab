import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { eventBus } from '../../lib/infra/event-bus.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { stubNodeRoster } from '../../../tests/helpers/node-roster.js';
import { applyInboundsRequestForNode } from '../inbounds/inbounds.queue.js';
import { requestFingerprint } from '../inbounds/render-drift.js';

/**
 * 18.6: the operator's IPv6 setting of a node. Stored as `ipv6Mode`, read back
 * by the API, and sent to the agent only when it is not `auto`, so a node on
 * the default is sent the bytes it was sent before the field.
 */
let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  token = await registerAndLogin(app);
  stubNodeRoster();
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

async function stored(): Promise<string> {
  const n = await prisma.node.create({
    data: { name: 'v6-node', address: 'v6-node.example.com', protocol: 'xray', status: 'online', heartbeatSecret: randomBytes(32) },
    select: { id: true },
  });
  return n.id;
}

const put = (id: string, payload: unknown) =>
  app.inject({ method: 'PUT', url: `/api/nodes/${id}`, headers: auth(), payload });
const get = async (id: string) =>
  JSON.parse((await app.inject({ method: 'GET', url: `/api/nodes/${id}`, headers: auth() })).body) as { ipv6Mode: string };

describe('the mode on the node API', () => {
  it('a node nobody set reads as auto', async () => {
    expect((await get(await stored())).ipv6Mode).toBe('auto');
  });

  it('is set by an edit, kept, and read back', async () => {
    const id = await stored();
    for (const mode of ['off', 'on', 'auto']) {
      const res = await put(id, { ipv6Mode: mode });
      expect(res.statusCode, res.body).toBe(200);
      expect(JSON.parse(res.body).ipv6Mode).toBe(mode);
      expect((await get(id)).ipv6Mode).toBe(mode);
    }
  });

  it('a value outside auto / on / off is refused, and an edit without it leaves it', async () => {
    const id = await stored();
    expect((await put(id, { ipv6Mode: 'sometimes' })).statusCode).toBe(400);
    await put(id, { ipv6Mode: 'off' });
    await put(id, { name: 'v6-renamed' });
    expect((await get(id)).ipv6Mode).toBe('off');
  });

  it('create takes it, and defaults to auto', async () => {
    const mk = async (name: string, extra: object) =>
      JSON.parse(
        (await app.inject({ method: 'POST', url: '/api/nodes', headers: auth(), payload: { name, address: `${name}.example.com`, ...extra } })).body,
      ) as { ipv6Mode: string };
    expect((await mk('a-node', {})).ipv6Mode).toBe('auto');
    expect((await mk('b-node', { ipv6Mode: 'on' })).ipv6Mode).toBe('on');
  });

  it('the column holds only auto, on, off', async () => {
    const id = await stored();
    await expect(prisma.$executeRaw`UPDATE nodes SET ipv6_mode = 'maybe' WHERE id = ${id}::uuid`).rejects.toThrow();
  });
});

describe('the mode in the request to the agent', () => {
  it('auto writes nothing: the request of a node on the default has the keys and the bytes it had before', async () => {
    const id = await stored();
    const req = (await applyInboundsRequestForNode(id))!;
    expect(Object.keys(req)).toEqual(['inbounds']);
    expect(JSON.stringify(req)).not.toContain('ipv6Mode');
  });

  it('on and off are written, and the drift fingerprint moves with them and back', async () => {
    const id = await stored();
    const sha = async () => requestFingerprint((await applyInboundsRequestForNode(id))!);
    const auto = await sha();
    await prisma.node.update({ where: { id }, data: { ipv6Mode: 'off' } });
    expect((await applyInboundsRequestForNode(id))!.ipv6Mode).toBe('off');
    const off = await sha();
    await prisma.node.update({ where: { id }, data: { ipv6Mode: 'on' } });
    expect((await applyInboundsRequestForNode(id))!.ipv6Mode).toBe('on');
    const on = await sha();
    expect(new Set([auto, off, on]).size).toBe(3);
    await prisma.node.update({ where: { id }, data: { ipv6Mode: 'auto' } });
    expect(await sha()).toBe(auto);
  });
});

describe('a change of mode reaches the node', () => {
  it('an edit that changes it emits node.updated (which queues the push); the same value does not', async () => {
    const id = await stored();
    const emit = vi.spyOn(eventBus, 'emit');
    await put(id, { ipv6Mode: 'off' });
    expect(emit).toHaveBeenCalledWith('node.updated', { nodeId: id, nodeName: 'v6-node' });
    emit.mockClear();
    await put(id, { ipv6Mode: 'off' });
    expect(emit).not.toHaveBeenCalledWith('node.updated', expect.anything());
  });
});
