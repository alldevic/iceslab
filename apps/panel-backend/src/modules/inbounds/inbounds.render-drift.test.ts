import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis, redis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { stubNodeRoster } from '../../../tests/helpers/node-roster.js';
import { NodeRequestError, NodeTransport } from '../nodes/nodes.transport.js';
import { applyInboundsForNode, applyInboundsRequestForNode, inboundSyncQueue } from './inbounds.queue.js';
import { checkRenderDrift, requestFingerprint } from './render-drift.js';

/**
 * A-278, the stand 26.10: a deploy changed what the panel draws for a node
 * (A-277), and the node kept the old drawing, because a deploy is no event
 * and the last push had come from the old panel. The push now records the
 * sha of what it sent; the check builds the request again and pushes where
 * the two differ or nothing was recorded.
 */
let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  token = await registerAndLogin(app);
  const keys = await redis.keys('node:*:pushedSha');
  if (keys.length > 0) await redis.del(...keys);
  // These nodes answer as an agent older than geo: the push goes straight on.
  vi.spyOn(NodeTransport.prototype, 'listAssets').mockRejectedValue(new NodeRequestError('404', 404, null));
  stubNodeRoster();
  // The push's own queue is not reached by these tests.
  vi.spyOn(inboundSyncQueue, 'add').mockResolvedValue({} as never);
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
async function post(url: string, payload: unknown) {
  const res = await app.inject({ method: 'POST', url, headers: auth(), payload });
  expect(res.statusCode, res.body).toBe(201);
  return JSON.parse(res.body);
}

async function node(name: string, country: string): Promise<string> {
  const n = await prisma.node.create({
    data: {
      name,
      address: `${name}.example.com`,
      protocol: 'xray',
      status: 'online',
      countryCode: country,
      heartbeatSecret: randomBytes(32),
      cores: { observedAt: new Date().toISOString(), cores: [{ name: 'xray', engine: 'xray' }] } as unknown as object,
    },
    select: { id: true },
  });
  return n.id;
}

/** An entry with a full drawing: two hosts on one port pair, a cascade with
 *  a gate, a node policy into it, squads and users. */
async function stand(): Promise<{ ru: string }> {
  const ru = await node('ru-entry', 'RU');
  const nl = await node('nl-exit', 'NL');
  const se = await node('se-exit', 'SE');
  const c = await post('/api/cascades', {
    name: 'stand',
    enabled: true,
    positions: [{ position: 0, nodeIds: [ru], entryProtocol: 'xray', linkProtocol: 'vless' }],
    directions: [
      { countryCode: 'NL', nodeIds: [nl] },
      { countryCode: 'SE', nodeIds: [se] },
    ],
  });
  const dirs = await prisma.cascadeDirection.findMany({ where: { cascadeId: c.id }, orderBy: { tag: 'asc' } });
  const profile = await post('/api/profiles', {
    name: 'entry-vless',
    protocol: 'xray',
    config: {
      security: 'reality',
      realityDest: 'www.microsoft.com:443',
      realityServerNames: ['www.microsoft.com'],
      realityPrivateKey: 'k'.repeat(43),
      realityPublicKey: 'p'.repeat(43),
      realityShortIds: ['0123abcd'],
      network: 'raw',
    },
  });
  await post('/api/hosts', { profileId: profile.id, nodeId: ru, port: 443 });
  const off = await post('/api/squads', { name: 'off', profileIds: [profile.id], exitAcl: [{ cascadeId: c.id, directionIds: [] }] });
  const open = await post('/api/squads', { name: 'open', profileIds: [profile.id] });
  for (const [i, g] of [off, open, open, off, open].entries()) {
    await post('/api/users', { username: `drift_${i}`, groupIds: [g.id] });
  }
  const policy = await prisma.nodePolicy.create({
    data: {
      name: 'to-se',
      rules: {
        create: [
          { position: 0, matchDomain: ['ifconfig.me'], matchIp: [], matchProtocol: [], actionKind: 'cascade', direction: { connect: { id: dirs[1]!.id } } },
          { position: 1, matchDomain: ['ads.example'], matchIp: [], matchProtocol: [], actionKind: 'block' },
        ],
      },
    },
  });
  await prisma.node.update({ where: { id: ru }, data: { policyId: policy.id } });
  return { ru };
}

const sha = async (nodeId: string) => requestFingerprint((await applyInboundsRequestForNode(nodeId))!);

/** Rewrite every row of a table in reverse of its current scan order: each
 *  UPDATE puts a new tuple at the end, so a query with no ORDER BY reads
 *  them the other way round. */
async function reverseScanOrder(table: string, column: string): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<{ c: string }[]>(`SELECT ctid::text AS c FROM ${table}`);
  for (const { c } of rows.reverse()) {
    await prisma.$executeRawUnsafe(`UPDATE ${table} SET ${column} = ${column} WHERE ctid = '${c}'::tid`);
  }
}

describe('the fingerprint', () => {
  it('two builds in a row give one sha, and so does a build after the rows are read in another order', async () => {
    const { ru } = await stand();
    const first = await sha(ru);
    expect(await sha(ru)).toBe(first);

    const before = await prisma.$queryRawUnsafe<{ id: string }[]>('SELECT id::text AS id FROM users');
    for (const [table, column] of [
      ['users', 'username'],
      ['group_members', 'user_id'],
      ['groups', 'name'],
      ['profile_node_bindings', 'port'],
      ['hosts', 'remark'],
      ['node_policy_rules', 'position'],
      ['cascade_directions', 'tag'],
      ['cascade_direction_nodes', 'node_id'],
      ['cascade_position_nodes', 'node_id'],
      ['cascade_links', 'direction_tag'],
    ] as const) {
      await reverseScanOrder(table, column);
    }
    const after = await prisma.$queryRawUnsafe<{ id: string }[]>('SELECT id::text AS id FROM users');
    // The shuffle took: the same rows, read in another order.
    expect(after.map((r) => r.id)).not.toEqual(before.map((r) => r.id));
    expect(await sha(ru)).toBe(first);
  });

  it('is a sha, not the request: no secret of the push is in what is kept', async () => {
    const { ru } = await stand();
    vi.spyOn(NodeTransport.prototype, 'applyInbounds').mockResolvedValue({ applied: 1, skipped: 0 } as never);
    await applyInboundsForNode(ru);
    const kept = await redis.get(`node:${ru}:pushedSha`);
    expect(kept).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the check', () => {
  const run = (push: (id: string) => Promise<void>) => checkRenderDrift((id) => applyInboundsRequestForNode(id), push);

  it('after a push the node applied: nothing to do; a second start with the same drawing queues none', async () => {
    await stand();
    vi.spyOn(NodeTransport.prototype, 'applyInbounds').mockResolvedValue({ applied: 1, skipped: 0 } as never);
    // Every node of the stand applied its push, the entry and both exits.
    for (const { id } of await prisma.node.findMany({ select: { id: true } })) await applyInboundsForNode(id);
    const push = vi.fn(async () => {});
    expect(await run(push)).toBe(0);
    expect(await run(push)).toBe(0);
    expect(push).not.toHaveBeenCalled();
  });

  it('a drawing changed without an event (a rule edited in the database) is pushed', async () => {
    const { ru } = await stand();
    vi.spyOn(NodeTransport.prototype, 'applyInbounds').mockResolvedValue({ applied: 1, skipped: 0 } as never);
    for (const { id } of await prisma.node.findMany({ select: { id: true } })) await applyInboundsForNode(id);
    await prisma.nodePolicyRule.updateMany({ where: { position: 1 }, data: { matchDomain: ['ads2.example'] } });
    const push = vi.fn(async () => {});
    // Only the node whose drawing changed: the exits draw no policy.
    expect(await run(push)).toBe(1);
    expect(push).toHaveBeenCalledWith(ru);
  });

  it('nothing recorded: one wave, and none after the push it asked for', async () => {
    const { ru } = await stand();
    const push = vi.fn(async () => {});
    await run(push);
    expect(push).toHaveBeenCalledWith(ru);
    vi.spyOn(NodeTransport.prototype, 'applyInbounds').mockResolvedValue({ applied: 1, skipped: 0 } as never);
    await applyInboundsForNode(ru);
    push.mockClear();
    await run(push);
    expect(push).not.toHaveBeenCalledWith(ru);
  });

  it('a partial push (ADAPTER_FAILED, A-275) records no success: the next check pushes again', async () => {
    const { ru } = await stand();
    vi.spyOn(NodeTransport.prototype, 'applyInbounds').mockRejectedValue(
      new NodeRequestError('500', 500, { error: 'ADAPTER_FAILED', message: 'active adapters failed: mieru' }),
    );
    await expect(applyInboundsForNode(ru)).rejects.toThrow();
    expect(await redis.get(`node:${ru}:pushedSha`)).toBeNull();
    // The failed push leaves the node behind its revision until it converges;
    // as far as this check goes, the drawing is still not delivered.
    await prisma.$executeRaw`UPDATE nodes SET applied_revision = desired_revision WHERE id = ${ru}::uuid`;
    const push = vi.fn(async () => {});
    await run(push);
    expect(push).toHaveBeenCalledWith(ru);
  });

  it('a node behind its revision is the reconcile\'s, not this check\'s', async () => {
    const { ru } = await stand();
    await prisma.$executeRaw`UPDATE nodes SET desired_revision = applied_revision + 1 WHERE id = ${ru}::uuid`;
    const push = vi.fn(async () => {});
    await run(push);
    expect(push).not.toHaveBeenCalledWith(ru);
  });
});
