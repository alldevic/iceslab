import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CoreStatus } from '@iceslab/shared';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { observedCores } from '../nodes/nodes.cron.js';
import { assertPortHoppingFitsNode, PortHoppingOutsideNodeRangeError } from './profiles.service.js';

/**
 * A-284: a hysteria profile's port hopping range, both bounds or neither and
 * the end above the start, on create and on edit. Before, a half or reversed
 * range was saved and handed to every client as it was.
 */
let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  token = await registerAndLogin(app);
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

const call = (method: 'POST' | 'PUT', url: string, payload: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });

const create = (config: Record<string, unknown>, name = 'hy') =>
  call('POST', '/api/profiles', { name, protocol: 'hysteria', config });

/** The issue the screen reads: its field and its words. */
function issueOf(body: string): { path: (string | number)[]; message: string } {
  const b = JSON.parse(body) as { error: string; issues: { path: (string | number)[]; message: string }[] };
  expect(b.error).toBe('VALIDATION_ERROR');
  return b.issues[0]!;
}

describe('a hysteria profile is created', () => {
  it.each([
    [{ portHoppingStart: 20000 }, 'portHoppingEnd'],
    [{ portHoppingEnd: 30000 }, 'portHoppingStart'],
    [{ portHoppingStart: 20000, portHoppingEnd: 20000 }, 'portHoppingEnd'],
    [{ portHoppingStart: 30000, portHoppingEnd: 20000 }, 'portHoppingEnd'],
  ])('%j is refused, 400 on config.%s', async (config, field) => {
    const res = await create(config);
    expect(res.statusCode, res.body).toBe(400);
    expect(issueOf(res.body).path).toEqual(['config', field]);
    expect(await prisma.profile.count()).toBe(0);
  });

  it('a range in order and no range at all are saved', async () => {
    expect((await create({ portHoppingStart: 20000, portHoppingEnd: 30000 }, 'ranged')).statusCode).toBe(201);
    expect((await create({}, 'plain')).statusCode).toBe(201);
  });
});

describe('a hysteria profile is edited', () => {
  it('one bound moved past the stored other one is refused, and the stored range stays', async () => {
    const res = await create({ portHoppingStart: 20000, portHoppingEnd: 30000 });
    const id = (JSON.parse(res.body) as { id: string }).id;
    const put = await call('PUT', `/api/profiles/${id}`, { config: { portHoppingStart: 35000, portHoppingEnd: 30000 } });
    expect(put.statusCode, put.body).toBe(400);
    expect(issueOf(put.body).path).toEqual(['config', 'portHoppingEnd']);
    const stored = (await prisma.profile.findUniqueOrThrow({ where: { id } })).config as Record<string, unknown>;
    expect([stored.portHoppingStart, stored.portHoppingEnd]).toEqual([20000, 30000]);

    // One bound dropped: refused too.
    const half = await call('PUT', `/api/profiles/${id}`, { config: { portHoppingStart: 20000 } });
    expect(half.statusCode).toBe(400);
    expect(issueOf(half.body).path).toEqual(['config', 'portHoppingEnd']);

    // A range in order, and none: saved.
    expect((await call('PUT', `/api/profiles/${id}`, { config: { portHoppingStart: 21000, portHoppingEnd: 31000 } })).statusCode).toBe(200);
    expect((await call('PUT', `/api/profiles/${id}`, { config: {} })).statusCode).toBe(200);
  });
});

/**
 * Whether a node catches the range a profile hops over is a fact about the
 * machine, reported by its agent (NodeCores.portHopping): three doors into the
 * pair (the profile's edit, a new binding, a binding's overrides), and the host
 * form that makes a binding too (profiles.binding-gate.test.ts). A node that
 * reported nothing, or that says it redirects none, is not judged.
 */
describe('a port-hopping range against the range a node reports', () => {
  let seq = 0;

  async function node(range?: { start: number; end: number }): Promise<{ id: string; name: string }> {
    seq += 1;
    const res = await call('POST', '/api/nodes', { name: `ph-node-${seq}`, address: `ph-${seq}.test`, protocol: 'hysteria' });
    expect(res.statusCode, res.body).toBe(201);
    const id = (JSON.parse(res.body) as { id: string }).id;
    await prisma.node.update({
      where: { id },
      data: {
        cores: observedCores(
          [{ name: 'hysteria', engine: 'hysteria', installed: true, running: true } as CoreStatus],
          new Date().toISOString(),
          undefined,
          undefined,
          range,
        ) as unknown as object,
      },
    });
    return { id, name: `ph-node-${seq}` };
  }

  async function profile(start: number, end: number): Promise<string> {
    const res = await create({ portHoppingStart: start, portHoppingEnd: end }, `ph-${(seq += 1)}`);
    expect(res.statusCode, res.body).toBe(201);
    return (JSON.parse(res.body) as { id: string }).id;
  }

  const bind = (profileId: string, nodeId: string, overrides?: unknown, port = 443) =>
    call('POST', '/api/bindings', { profileId, nodeId, port, ...(overrides ? { overrides } : {}) });

  function refusedFor(res: { statusCode: number; body: string }, nodeName: string) {
    expect(res.statusCode, res.body).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'PORT_HOPPING_OUTSIDE_NODE_RANGE', nodeName });
  }

  it('refuses a profile edit that goes past the range of a deployed node, and keeps the stored range', async () => {
    const n = await node({ start: 20000, end: 50000 });
    const id = await profile(30000, 40000);
    expect((await bind(id, n.id)).statusCode).toBe(201);

    refusedFor(await call('PUT', `/api/profiles/${id}`, { config: { portHoppingStart: 10000, portHoppingEnd: 40000 } }), n.name);
    const stored = (await prisma.profile.findUniqueOrThrow({ where: { id } })).config as Record<string, unknown>;
    expect([stored.portHoppingStart, stored.portHoppingEnd]).toEqual([30000, 40000]);

    // Nested, and the same: saved.
    expect((await call('PUT', `/api/profiles/${id}`, { config: { portHoppingStart: 20000, portHoppingEnd: 50000 } })).statusCode).toBe(200);
  });

  it('refuses a new binding on a node that does not catch the profile range', async () => {
    const n = await node({ start: 30000, end: 40000 });
    const id = await profile(20000, 50000);
    refusedFor(await bind(id, n.id), n.name);
    expect(await prisma.profileNodeBinding.count()).toBe(0);
  });

  it('refuses an override that moves the range off the node, and one that stays inside is saved', async () => {
    const n = await node({ start: 20000, end: 50000 });
    const id = await profile(30000, 40000);
    const bound = await bind(id, n.id);
    expect(bound.statusCode, bound.body).toBe(201);
    const bindingId = (JSON.parse(bound.body) as { id: string }).id;

    refusedFor(await call('PUT', `/api/bindings/${bindingId}`, { overrides: { portHoppingStart: 1100, portHoppingEnd: 1200 } }), n.name);
    expect((await call('PUT', `/api/bindings/${bindingId}`, { overrides: { portHoppingStart: 25000, portHoppingEnd: 26000 } })).statusCode).toBe(200);
    // A binding is judged by the range it ends up with, not only the profile's.
    refusedFor(await bind(id, n.id, { portHoppingStart: 1100, portHoppingEnd: 1200 }, 8443), n.name);
  });

  it('does not judge a node that reported no range', async () => {
    const n = await node();
    const id = await profile(1100, 1200);
    expect((await bind(id, n.id)).statusCode).toBe(201);
    expect((await call('PUT', `/api/profiles/${id}`, { config: { portHoppingStart: 1024, portHoppingEnd: 65000 } })).statusCode).toBe(200);
  });

  it('does not judge a node that says it redirects none (as fork-integration: not told from no report)', async () => {
    const n = await node({ start: 0, end: 0 });
    const id = await profile(1100, 1200);
    expect((await bind(id, n.id)).statusCode).toBe(201);
  });

  it('judges each node on its own range, naming the one that does not catch it', () => {
    const cores = (start: number, end: number) => ({ observedAt: 'x', cores: [], portHopping: { start, end } });
    const cfg = { portHoppingStart: 20000, portHoppingEnd: 50000 };
    const p = { protocol: 'hysteria', name: 'hy-1' };
    expect(() => assertPortHoppingFitsNode({ name: 'wide', cores: cores(20000, 50000) }, p, cfg)).not.toThrow();
    expect(() => assertPortHoppingFitsNode({ name: 'narrow', cores: cores(30000, 40000) }, p, cfg)).toThrow(PortHoppingOutsideNodeRangeError);
    // Only the hopping range of a hysteria profile.
    expect(() => assertPortHoppingFitsNode({ name: 'narrow', cores: cores(30000, 40000) }, { protocol: 'xray', name: 'x' }, cfg)).not.toThrow();
    expect(() => assertPortHoppingFitsNode({ name: 'n', cores: cores(30000, 40000) }, p, {})).not.toThrow();
    expect(() => assertPortHoppingFitsNode({ name: 'n', cores: null }, p, cfg)).not.toThrow();
  });
});
