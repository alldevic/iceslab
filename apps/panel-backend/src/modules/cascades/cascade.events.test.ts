import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerCascadeEventHandlers } from './cascade.events.js';
import { createCascade } from './cascade.service.js';
import { eventBus } from '../../lib/event-bus.js';
import { prisma } from '../../prisma.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { closeRedis } from '../../lib/redis.js';

/**
 * An entry with no reachable exit refuses — every named direction line always
 * did, and the Auto line does since 2026-08-28 instead of quietly egressing
 * from the entry's own country. Refusing is right, and it is also invisible
 * from the panel: the subscriber sees a dead tunnel and the operator sees
 * nothing. So the state has to announce itself.
 *
 * Edge-triggered off `node.status-changed`, because a cascade can only reach
 * "no live exits" when one of its exits flips.
 */

let seq = 0;
async function node(name: string, status: string): Promise<string> {
  seq += 1;
  const row = await prisma.node.create({
    data: {
      name: `${name}-${seq}`,
      address: `${name}-${seq}.test:1337`,
      heartbeatSecret: Buffer.alloc(32),
      status,
    },
  });
  return row.id;
}

/** Collect `cascade.exits-changed` while running `fn`. The bus has `on` and no
 *  `off`, so the collector stays subscribed for the file and each case reads
 *  only what its own action produced. */
const seen: { cascadeId: string; live: number; total: number }[] = [];
eventBus.on('cascade.exits-changed', (p) => {
  seen.push({ cascadeId: p.cascadeId, live: p.live, total: p.total });
});

/** The handler is async and the bus delivers through a microtask. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 30));
}

beforeEach(async () => {
  await cleanDatabase();
  seen.length = 0;
  registerCascadeEventHandlers();
});
afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

async function cascadeWithExits(statuses: string[]): Promise<{ id: string; exits: string[] }> {
  const entry = await node('entry', 'online');
  const exits: string[] = [];
  for (const s of statuses) exits.push(await node('exit', s));
  const c = await createCascade({
    name: `c-${seq}`,
    enabled: true,
    hideHopsFromSub: true,
    autoProfile: false,
    mode: 'chain',
    positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
    directions: exits.map((id) => ({ nodeIds: [id] })),
  });
  return { id: c.id, exits };
}

describe('a cascade with no reachable exit says so', () => {
  it('announces the moment the last exit goes down', async () => {
    const { id, exits } = await cascadeWithExits(['online']);
    await prisma.node.update({ where: { id: exits[0]! }, data: { status: 'unreachable' } });
    eventBus.emit('node.status-changed', { nodeId: exits[0]!, from: 'online', to: 'unreachable' });
    await settle();
    expect(seen).toEqual([{ cascadeId: id, live: 0, total: 1 }]);
  });

  it('stays quiet while another exit is still up', async () => {
    const { exits } = await cascadeWithExits(['online', 'online']);
    await prisma.node.update({ where: { id: exits[0]! }, data: { status: 'unreachable' } });
    eventBus.emit('node.status-changed', { nodeId: exits[0]!, from: 'online', to: 'unreachable' });
    await settle();
    expect(seen, 'one exit down out of two is not an outage').toEqual([]);
  });

  it('announces the recovery, so the alert has an end', async () => {
    const { id, exits } = await cascadeWithExits(['unreachable']);
    await prisma.node.update({ where: { id: exits[0]! }, data: { status: 'online' } });
    eventBus.emit('node.status-changed', { nodeId: exits[0]!, from: 'unreachable', to: 'online' });
    await settle();
    expect(seen).toEqual([{ cascadeId: id, live: 1, total: 1 }]);
  });

  it('counts a degraded exit as no exit: the core it did not start IS the link-in', async () => {
    const { id, exits } = await cascadeWithExits(['online']);
    await prisma.node.update({ where: { id: exits[0]! }, data: { status: 'degraded' } });
    eventBus.emit('node.status-changed', { nodeId: exits[0]!, from: 'online', to: 'degraded' });
    await settle();
    expect(seen).toEqual([{ cascadeId: id, live: 0, total: 1 }]);
  });

  it('says nothing about a disabled cascade', async () => {
    const entry = await node('entry', 'online');
    const exit = await node('exit', 'online');
    await createCascade({
      name: `off-${seq}`,
      enabled: false,
      hideHopsFromSub: true,
      autoProfile: false,
      mode: 'chain',
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [{ nodeIds: [exit] }],
    });
    await prisma.node.update({ where: { id: exit }, data: { status: 'unreachable' } });
    eventBus.emit('node.status-changed', { nodeId: exit, from: 'online', to: 'unreachable' });
    await settle();
    expect(seen).toEqual([]);
  });
});
