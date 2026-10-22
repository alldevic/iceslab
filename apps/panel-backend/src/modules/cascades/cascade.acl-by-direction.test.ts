import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { getRouteProfilesByEntryNode } from './cascade.service.js';

/**
 * A-149: a squad's allowed exits are keyed by DIRECTION. Keyed by node they
 * followed machines: replacing the node under DE took DE from every squad
 * narrowed to it, and adding a node to the DE pool opened DE to squads that
 * had that node elsewhere.
 */
let app: FastifyInstance;
let token: string;
let entry: string;
let de1: string;
let nl1: string;
let cascadeId: string;
let deDir: string;
let nlDir: string;

const auth = () => ({ authorization: `Bearer ${token}` });
const tags = (profiles: { tag: number }[] | undefined) => (profiles ?? []).map((p) => p.tag);

async function node(name: string, countryCode: string): Promise<string> {
  const n = await prisma.node.create({
    data: { name, address: `${name}.example.com:1337`, protocol: 'xray', countryCode, heartbeatSecret: randomBytes(32) },
    select: { id: true },
  });
  return n.id;
}

async function squad(exitAcl: unknown): Promise<{ status: number; id?: string; body: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/squads',
    headers: auth(),
    payload: { name: `sq-${randomBytes(3).toString('hex')}`, exitAcl },
  });
  return { status: res.statusCode, id: res.statusCode === 201 ? JSON.parse(res.body).id : undefined, body: res.body };
}

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  token = await registerAndLogin(app);
  entry = await node('ru-01', 'RU');
  de1 = await node('de-01', 'DE');
  nl1 = await node('nl-01', 'NL');
  const c = await prisma.cascade.create({ data: { name: 'ru', enabled: true, mode: 'chain' }, select: { id: true } });
  cascadeId = c.id;
  await prisma.cascadePosition.create({ data: { cascadeId, position: 0, nodes: { create: [{ nodeId: entry }] } } });
  deDir = (
    await prisma.cascadeDirection.create({
      data: { cascadeId, tag: 1, countryCode: 'DE', nodes: { create: [{ nodeId: de1 }] } },
      select: { id: true },
    })
  ).id;
  nlDir = (
    await prisma.cascadeDirection.create({
      data: { cascadeId, tag: 2, countryCode: 'NL', nodes: { create: [{ nodeId: nl1 }] } },
      select: { id: true },
    })
  ).id;
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('an exit allow-list keyed by direction', () => {
  it('replacing the node under DE keeps DE for a squad narrowed to it', async () => {
    const g = await squad([{ cascadeId, directionIds: [deDir] }]);
    expect(g.status, g.body).toBe(201);
    expect(tags((await getRouteProfilesByEntryNode([entry], [g.id!])).get(entry))).toEqual([1]);

    const de2 = await node('de-02', 'DE');
    await prisma.cascadeDirectionNode.deleteMany({ where: { directionId: deDir } });
    await prisma.cascadeDirectionNode.create({ data: { directionId: deDir, nodeId: de2 } });

    expect(tags((await getRouteProfilesByEntryNode([entry], [g.id!])).get(entry))).toEqual([1]);
  });

  it('adding a node to the DE pool does not open DE to a squad that has that node elsewhere', async () => {
    const g = await squad([{ cascadeId, directionIds: [nlDir] }]);
    await prisma.cascadeDirectionNode.create({ data: { directionId: deDir, nodeId: nl1 } });
    expect(tags((await getRouteProfilesByEntryNode([entry], [g.id!])).get(entry))).toEqual([2]);
  });

  it('the old screen sending exitNodeIds is mapped to the directions holding them', async () => {
    const g = await squad([{ cascadeId, exitNodeIds: [de1] }]);
    expect(g.status, g.body).toBe(201);
    const rows = await prisma.groupCascadeExit.findMany({ where: { groupId: g.id } });
    expect(rows.map((r) => [r.directionId, r.exitNodeId])).toEqual([[deDir, null]]);
    const read = JSON.parse(
      (await app.inject({ method: 'GET', url: `/api/squads/${g.id}`, headers: auth() })).body,
    ) as { exitAcl: unknown };
    expect(read.exitAcl).toEqual([{ cascadeId, directionIds: [deDir], exitNodeIds: [de1] }]);
  });

  it('a node in no direction, or a direction of another cascade, is refused, not dropped into "every exit"', async () => {
    const stray = await node('stray', 'FI');
    const a = await squad([{ cascadeId, exitNodeIds: [stray] }]);
    expect(a.status).toBe(400);
    expect(JSON.parse(a.body).error).toBe('EXIT_ACL_INVALID');
    const other = await prisma.cascade.create({ data: { name: 'other', enabled: true, mode: 'chain' } });
    const b = await squad([{ cascadeId: other.id, directionIds: [deDir] }]);
    expect(b.status).toBe(400);
  });

  it('a deleted direction leaves the squad restricted, not open to every exit', async () => {
    const g = await squad([{ cascadeId, directionIds: [deDir] }]);
    await prisma.cascadeDirection.delete({ where: { id: deDir } });
    const row = await prisma.groupCascadeExit.findFirstOrThrow({ where: { groupId: g.id } });
    expect(row.directionId).toBeNull();
    const out = await getRouteProfilesByEntryNode([entry], [g.id!]);
    expect(tags(out.get(entry))).toEqual([]);
  });
});
