import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { getChainForNode, getRouteProfilesByEntryNode, invalidateHiddenCascadeNodeCache } from './cascade.service.js';
import { deadCascadeIds, findBlindTransitCascades, findCascadeNodeConflicts } from './cascade-exclusive.js';
import { eventBus } from '../../lib/infra/event-bus.js';

/**
 * A-101: a node carries one ENABLED cascade. The second one on a node was not
 * drawn there at all (one chain config, one role, link port 24000 and socks
 * 26000 claimed twice), and which of the two the node got was a findFirst
 * without an order. The save refuses it; a pair stored before the rule is
 * held by the oldest cascade and named at start.
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

const auth = () => ({ authorization: `Bearer ${token}` });
async function send(method: 'POST' | 'PUT', url: string, payload: unknown) {
  const res = await app.inject({ method, url, headers: auth(), payload });
  return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

async function node(name: string, country: string, host: string): Promise<string> {
  return (
    await prisma.node.create({
      data: {
        name,
        address: host,
        protocol: 'xray',
        countryCode: country,
        heartbeatSecret: randomBytes(32),
        cores: {
          observedAt: new Date().toISOString(),
          cores: [
            { name: 'xray', engine: 'xray' },
            { name: 'tuic', engine: 'singbox' },
          ],
        } as unknown as object,
      },
      select: { id: true },
    })
  ).id;
}

const cascadeBody = (name: string, entry: string, exit: string, enabled = true) => ({
  name,
  enabled,
  positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'vless' }],
  directions: [{ countryCode: 'NL', nodeIds: [exit] }],
});

describe('one enabled cascade per node', () => {
  let ru: string;
  let de: string;
  let nl: string;
  let first: string;

  beforeEach(async () => {
    ru = await node('ru-entry', 'RU', '10.0.0.1');
    de = await node('de-entry', 'DE', '10.0.0.2');
    nl = await node('nl-exit', 'NL', '10.0.0.3');
    const a = await send('POST', '/api/cascades', cascadeBody('first', ru, nl));
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    first = a.body.id as string;
  });

  it('refuses a second enabled cascade on a shared node, by name', async () => {
    const b = await send('POST', '/api/cascades', cascadeBody('second', de, nl));
    expect(b.status).toBe(409);
    expect(b.body).toMatchObject({ error: 'NODE_IN_OTHER_CASCADE', nodeName: 'nl-exit', cascadeId: first, cascadeName: 'first' });
    expect(String(b.body.message)).toContain('nl-exit');
  });

  it('saves it switched off, and refuses the toggle that switches it on', async () => {
    const b = await send('POST', '/api/cascades', cascadeBody('second', de, nl, false));
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    const on = await send('PUT', `/api/cascades/${b.body.id as string}`, { enabled: true });
    expect(on.status).toBe(409);
    expect(on.body).toMatchObject({ error: 'NODE_IN_OTHER_CASCADE', nodeName: 'nl-exit', cascadeName: 'first' });
    // The first one switched off frees the node.
    expect((await send('PUT', `/api/cascades/${first}`, { enabled: false })).status).toBe(200);
    expect((await send('PUT', `/api/cascades/${b.body.id as string}`, { enabled: true })).status).toBe(200);
  });

  it('a pair stored before the rule: the oldest holds the node, the start-up check names it, a rename passes', async () => {
    const b = await send('POST', '/api/cascades', cascadeBody('second', de, nl, false));
    const second = b.body.id as string;
    // Stored past the gate, as a database from before A-101 holds it.
    await prisma.cascade.update({ where: { id: second }, data: { enabled: true } });

    // The node runs the OLDEST cascade: its leg comes from the first entry.
    const chain = await getChainForNode(nl);
    expect(chain?.linkIngress?.[0]?.allowFrom).toEqual(['10.0.0.1']);

    expect(await findCascadeNodeConflicts()).toEqual([
      { nodeName: 'nl-exit', ownerCascade: 'first', deadCascade: 'second' },
    ]);
    // A save that changes no members and switches nothing on is not refused
    // for a pair it did not make.
    expect((await send('PUT', `/api/cascades/${second}`, { name: 'second-renamed' })).status).toBe(200);

    // And the list answers in the same order, oldest first.
    const list = await app.inject({ method: 'GET', url: '/api/cascades', headers: auth() });
    const names = (JSON.parse(list.body) as { cascades: { name: string }[] }).cascades.map((c) => c.name);
    expect(names).toEqual(['first', 'second-renamed']);
  });
});

/**
 * A-223: the cascade that loses a shared node is dead as a WHOLE. Its legs end
 * in a node that takes only the owner's legs, so it is drawn on none of its
 * nodes and none of its lines reach a subscription; switching the owner off
 * brings it back, and its own nodes are pushed for that.
 */
/**
 * A-102: a cascade stored before the save refused a blind transit step now
 * drops its traffic at the transit. The start-up check names it with the
 * position and the cell, so the operator hears it before the users do.
 */
describe('the start-up report of blind transits', () => {
  it('names an enabled cascade whose transit takes a shadowsocks leg with two directions, and nothing else', async () => {
    const ru = await node('ru-entry', 'RU', '10.0.0.1');
    const tr = await node('tr', 'DE', '10.0.0.2');
    const nl = await node('nl-exit', 'NL', '10.0.0.3');
    const se = await node('se-exit', 'SE', '10.0.0.4');
    const two = {
      name: 'blind',
      enabled: true,
      positions: [
        { position: 0, nodeIds: [ru], entryProtocol: 'xray', linkProtocol: 'vless' },
        { position: 1, nodeIds: [tr], linkProtocol: 'vless' },
      ],
      directions: [
        { countryCode: 'NL', nodeIds: [nl] },
        { countryCode: 'SE', nodeIds: [se] },
      ],
    };
    const saved = await send('POST', '/api/cascades', two);
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(await findBlindTransitCascades()).toEqual([]);
    // Stored past the gate, as a database from before A-102 holds it.
    await prisma.cascadePosition.updateMany({
      where: { cascadeId: saved.body.id as string, position: 0 },
      data: { linkProtocol: 'shadowsocks' },
    });
    expect(await findBlindTransitCascades()).toEqual([
      { cascadeName: 'blind', fromPosition: 0, transitPosition: 1, cell: 'shadowsocks' },
    ]);
    // The save itself refuses the shape now.
    const again = await send('POST', '/api/cascades', {
      ...two,
      name: 'blind-2',
      enabled: false,
      positions: [{ ...two.positions[0]!, linkProtocol: 'shadowsocks' }, two.positions[1]!],
    });
    expect(again.status).toBe(400);
    expect(String(again.body.message)).toContain('cannot tell them apart');
  });
});

// The bus has no `off`: one listener for the file, emptied by the test.
const pushed: string[][] = [];
eventBus.on('cascade.changed', ({ nodeIds }) => {
  pushed.push(nodeIds);
});

describe('a dead cascade, and one that comes back to life', () => {
  it('is drawn nowhere and offers no line, until the owner goes; the dead set and the start-up report agree', async () => {
    const ru = await node('ru-entry', 'RU', '10.0.0.1');
    const de = await node('de-entry', 'DE', '10.0.0.2');
    const nl = await node('nl-exit', 'NL', '10.0.0.3');
    const a = await send('POST', '/api/cascades', cascadeBody('first', ru, nl));
    const b = await send('POST', '/api/cascades', cascadeBody('second', de, nl, false));
    const first = a.body.id as string;
    const second = b.body.id as string;
    await prisma.cascade.update({ where: { id: second }, data: { enabled: true } });
    invalidateHiddenCascadeNodeCache();

    // One reading, two projections.
    const dead = await deadCascadeIds();
    expect([...dead]).toEqual([second]);
    const reported = (await findCascadeNodeConflicts()).map((c) => c.deadCascade);
    const names = new Map((await prisma.cascade.findMany({ select: { id: true, name: true } })).map((c) => [c.id, c.name]));
    expect(new Set(reported)).toEqual(new Set([...dead].map((id) => names.get(id))));

    // No line of the dead cascade on its entry; the owner's lines on its own.
    expect((await getRouteProfilesByEntryNode([de])).get(de) ?? []).toEqual([]);
    expect(((await getRouteProfilesByEntryNode([ru])).get(ru) ?? []).length).toBeGreaterThan(0);
    // And its own entry draws no chain into a way out that is not there.
    expect(await getChainForNode(de)).toBeNull();
    expect(await getChainForNode(ru)).not.toBeNull();

    // The owner switched off: the dead one lives, its own nodes are pushed.
    pushed.length = 0;
    expect((await send('PUT', `/api/cascades/${first}`, { enabled: false })).status).toBe(200);
    await expect.poll(() => pushed.flat(), { timeout: 3000 }).toContain(de);
    expect(await getChainForNode(de)).not.toBeNull();
    expect(((await getRouteProfilesByEntryNode([de])).get(de) ?? []).length).toBeGreaterThan(0);
  });
});
