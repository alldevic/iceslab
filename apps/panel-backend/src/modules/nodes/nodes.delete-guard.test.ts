import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { createCascade } from '../cascades/cascade.service.js';

/**
 * A live cascade keeps its node.
 *
 * THE INCIDENT, 2026-09-22. A node was deleted while an enabled cascade routed
 * a direction through it. Nothing stopped that: delete drops cascades the node
 * is a legacy HOP of, and the v4 topology, where this node was a direction
 * member, was left pointing at a row with no address. The renderer then refused
 * to build a push for the cascade's entries at all, rather than half-render a
 * chain that sends people out of the wrong country, so the two RU entries
 * stopped receiving config and nobody found out until their cores were
 * restarted a day later and came up empty.
 */
let app: FastifyInstance;
let token: string;
let seq = 0;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  token = await registerAndLogin(app);
  seq = 0;
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

const auth = () => ({ authorization: `Bearer ${token}` });

async function makeNode(name: string): Promise<string> {
  seq += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/api/nodes',
    headers: auth(),
    payload: { name, address: `del-${seq}.test`, protocol: 'xray' },
  });
  expect(res.statusCode, res.body).toBe(201);
  return JSON.parse(res.body).id as string;
}

async function makeCascade(name: string, entry: string, exits: string[], enabled = true) {
  await createCascade({
    name,
    enabled,
    positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
    directions: exits.map((nodeId, i) => ({
      tag: i + 1,
      countryCode: i === 0 ? 'NL' : 'SE',
      nodeIds: [nodeId],
    })),
  } as never);
}

const del = (id: string) =>
  app.inject({ method: 'DELETE', url: `/api/nodes/${id}`, headers: auth() });

describe('deleting a node a cascade runs through', () => {
  it('refuses when the node is a WAY OUT of an enabled cascade', async () => {
    const entry = await makeNode('ru-01');
    const nl = await makeNode('nl-exit');
    const se = await makeNode('se-exit');
    await makeCascade('ru', entry, [nl, se]);

    const res = await del(nl);
    expect(res.statusCode, res.body).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('NODE_IN_USE_BY_CASCADE');
    expect(body.cascades).toEqual(['ru']);
    expect(body.message).toContain('nl-exit');

    // And the node is still there: a refusal that half-deleted would be worse
    // than the deletion it refused.
    const still = await prisma.node.findUnique({ where: { id: nl } });
    expect(still?.deletedAt).toBeNull();
  });

  it('refuses for the ENTRY as well', async () => {
    const entry = await makeNode('ru-01');
    const nl = await makeNode('nl-exit');
    const se = await makeNode('se-exit');
    await makeCascade('ru', entry, [nl, se]);

    const res = await del(entry);
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.parse(res.body).cascades).toEqual(['ru']);
  });

  it('names every cascade that holds the node', async () => {
    // One node can be a way out of several. Fixing them one refusal at a time
    // is the same walk the cascade port conflicts avoid.
    const entryA = await makeNode('ru-01');
    const entryB = await makeNode('ru-02');
    const shared = await makeNode('nl-exit');
    const other = await makeNode('se-exit');
    await makeCascade('ru-a', entryA, [shared, other]);
    await makeCascade('ru-b', entryB, [shared, other]);

    const body = JSON.parse((await del(shared)).body);
    expect(body.cascades.sort()).toEqual(['ru-a', 'ru-b']);
  });

  it('refuses when the cascade is switched OFF too (A-126)', async () => {
    // It was allowed, as "serving nobody", and the v4 rows kept pointing at
    // the deleted node; one toggle later the entries got no config at all.
    const entry = await makeNode('ru-01');
    const nl = await makeNode('nl-exit');
    const se = await makeNode('se-exit');
    await makeCascade('ru', entry, [nl, se], false);

    const res = await del(nl);
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.parse(res.body).cascades).toEqual(['ru']);
    const still = await prisma.node.findUnique({ where: { id: nl } });
    expect(still?.deletedAt).toBeNull();
  });

  it('a switched-off cascade that already holds a deleted node is not switched on by the toggle', async () => {
    // The state a panel can already be in: a node deleted under a disabled
    // cascade before the guard above. The toggle sends `enabled` alone.
    const entry = await makeNode('ru-01');
    const nl = await makeNode('nl-exit');
    const se = await makeNode('se-exit');
    await makeCascade('ru', entry, [nl, se], false);
    await prisma.node.update({ where: { id: nl }, data: { deletedAt: new Date() } });
    const cascade = await prisma.cascade.findFirstOrThrow({ where: { name: 'ru' } });

    const res = await app.inject({
      method: 'PUT',
      url: `/api/cascades/${cascade.id}`,
      headers: auth(),
      payload: { enabled: true },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.body).toContain(nl);
    expect((await prisma.cascade.findUniqueOrThrow({ where: { id: cascade.id } })).enabled).toBe(false);
  });

  it('the toggle still switches on a sound cascade, and rewrites none of its legs', async () => {
    const entry = await makeNode('ru-01');
    const nl = await makeNode('nl-exit');
    const se = await makeNode('se-exit');
    await makeCascade('ru', entry, [nl, se], false);
    const cascade = await prisma.cascade.findFirstOrThrow({ where: { name: 'ru' } });
    const linksBefore = await prisma.cascadeLink.findMany({ where: { cascadeId: cascade.id }, orderBy: { id: 'asc' } });

    const res = await app.inject({
      method: 'PUT',
      url: `/api/cascades/${cascade.id}`,
      headers: auth(),
      payload: { enabled: true },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await prisma.cascade.findUniqueOrThrow({ where: { id: cascade.id } })).enabled).toBe(true);
    expect(await prisma.cascadeLink.findMany({ where: { cascadeId: cascade.id }, orderBy: { id: 'asc' } })).toEqual(
      linksBefore,
    );
  });

  it('allows it when no cascade touches the node', async () => {
    const lonely = await makeNode('spare-1');
    expect((await del(lonely)).statusCode).toBe(204);
  });
});
