// The id of a direction must survive a save, because it is the only thing that
// identifies one.
//
// A direction carries a TAG, the tag rides in every subscriber's UUID, and the
// panel keeps the tag across an edit by matching the incoming direction to a
// stored one. It matches on `id` first — the editor sends it back untouched for
// exactly this reason — and falls back to comparing the node POOL.
//
// The fallback is a coincidence, not a contract: it holds only while the pool is
// unchanged, and editing the pool is the ordinary reason to open the form. So
// the id has to be real. It was not: writing the topology meant dropping every
// row and recreating it, so the id an operator (or a deploy script) had just
// read was stale the moment it was used. Measured on the live panel 2026-09-02
// with a byte-identical topology:
//
//   before  ca2d6fed-…
//   after   9ae642d3-…
//
// The tag survived that save on the pool fallback alone. Had the pool moved in
// the same save, every issued UUID would have been routed to a different way out
// — or to the entry's terminal refusal, which is what a v4 entry does with a tag
// it does not know.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createCascade, updateCascade } from './cascade.service.js';
import { prisma } from '../../prisma.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { closeRedis } from '../../lib/redis.js';

let seq = 0;
async function node(name: string): Promise<string> {
  seq += 1;
  const row = await prisma.node.create({
    data: {
      name: `${name}-${seq}`,
      address: `${name}-${seq}.test:1337`,
      heartbeatSecret: Buffer.alloc(32),
    },
  });
  return row.id;
}

async function directions(cascadeId: string) {
  return prisma.cascadeDirection.findMany({
    where: { cascadeId },
    select: {
      id: true,
      tag: true,
      countryCode: true,
      nodes: { select: { nodeId: true }, orderBy: { nodeId: 'asc' } },
    },
    orderBy: { tag: 'asc' },
  });
}

beforeEach(async () => {
  await cleanDatabase();
});
afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('a direction that survives a save keeps its id', () => {
  it('a rename changes nothing about the direction row', async () => {
    const entry = await node('entry');
    const exit = await node('exit');
    const c = await createCascade({
      name: 'dir-identity',
      enabled: false,
      hideHopsFromSub: true,
      autoProfile: false,
      mode: 'chain',
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [{ nodeIds: [exit] }],
    });
    const before = await directions(c.id);
    expect(before).toHaveLength(1);

    await updateCascade(c.id, {
      name: 'dir-identity-renamed',
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [{ id: before[0]!.id, nodeIds: [exit] }],
    });

    expect(await directions(c.id), 'the save re-minted the row the client just named').toEqual(
      before,
    );
  });

  it('the id survives the pool being edited, which is what the fallback cannot do', async () => {
    // The case the pool fallback was always going to lose: the id is sent, the
    // pool is different, and the tag must not move.
    const entry = await node('entry');
    const exitA = await node('exit-a');
    const exitB = await node('exit-b');
    const c = await createCascade({
      name: 'dir-identity-pool',
      enabled: false,
      hideHopsFromSub: true,
      autoProfile: false,
      mode: 'chain',
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [{ nodeIds: [exitA] }],
    });
    const before = await directions(c.id);

    await updateCascade(c.id, {
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [{ id: before[0]!.id, countryCode: 'NL', nodeIds: [exitA, exitB] }],
    });

    const after = await directions(c.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.id, 'the pool moved and the row was replaced').toBe(before[0]!.id);
    expect(after[0]!.tag, 'the tag moved, so every issued UUID now routes elsewhere').toBe(
      before[0]!.tag,
    );
    expect(after[0]!.countryCode).toBe('NL');
    expect(after[0]!.nodes.map((n) => n.nodeId).sort()).toEqual([exitA, exitB].sort());
  });

  it('a direction the payload drops is deleted, and its tag is not reissued', async () => {
    // The other direction of the same rule: keeping rows must not turn into
    // keeping rows nobody asked for, and a freed tag must never be handed on.
    const entry = await node('entry');
    const exitA = await node('exit-a');
    const exitB = await node('exit-b');
    const c = await createCascade({
      name: 'dir-identity-drop',
      enabled: false,
      hideHopsFromSub: true,
      autoProfile: false,
      mode: 'chain',
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [{ nodeIds: [exitA] }, { nodeIds: [exitB] }],
    });
    const before = await directions(c.id);
    expect(before).toHaveLength(2);

    await updateCascade(c.id, {
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [{ id: before[1]!.id, nodeIds: [exitB] }],
    });
    const kept = await directions(c.id);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.id).toBe(before[1]!.id);
    expect(kept[0]!.tag).toBe(before[1]!.tag);

    // Add a third way out: it must draw a NEW tag, not the one just freed.
    const exitC = await node('exit-c');
    await updateCascade(c.id, {
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [{ id: kept[0]!.id, nodeIds: [exitB] }, { nodeIds: [exitC] }],
    });
    const grown = await directions(c.id);
    expect(grown).toHaveLength(2);
    expect(grown.map((d) => d.tag)).not.toContain(before[0]!.tag);
  });
});
