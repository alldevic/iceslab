// Rebuilding one cascade must not touch another one's wiring.
//
// Saving a v4 cascade replaces its topology wholesale: links, positions and
// directions are wiped and written again inside one transaction. All three
// wipes read correctly (`where: { cascadeId }`) and nothing observed their
// SCOPE — with the filter dropped, editing any cascade unwires every other
// one. The edited cascade still saves and still renders, so the panel shows
// success; what breaks is a fleet the admin was not looking at, and it breaks
// on the next push rather than on the click.
//
// Asked where the effect lands: `getCascadeFragmentsForNode` is what the
// node-agent receives. A cascade whose rows survive but whose fragments come
// back empty is the same outage as one that was deleted.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { createCascade, getCascadeFragmentsForNode, updateCascade } from './cascade.service.js';

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

/** One entry, one direction out — the smallest shape that produces a link. */
async function makeCascade(name: string, entry: string, exit: string) {
  return createCascade({
    name,
    enabled: true,
    positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
    directions: [{ countryCode: 'NL', nodeIds: [exit] }],
  });
}

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('saving one cascade leaves the others wired', () => {
  it('keeps the untouched cascade’s node serving the same fragments', async () => {
    const aEntry = await node('a-entry');
    const aExit = await node('a-exit');
    const bEntry = await node('b-entry');
    const bExit = await node('b-exit');
    const a = await makeCascade('alpha', aEntry, aExit);
    await makeCascade('beta', bEntry, bExit);

    const before = await getCascadeFragmentsForNode(bEntry);
    expect(before?.outbounds.length, 'fixture produced no link to lose').toBeGreaterThan(0);

    // A save that changes nothing about beta. Re-sending alpha's own shape is
    // enough: the wipe runs on every save, not only on a real edit.
    await updateCascade(a.id, {
      positions: [{ position: 0, nodeIds: [aEntry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [{ countryCode: 'NL', nodeIds: [aExit] }],
    });

    expect(
      await getCascadeFragmentsForNode(bEntry),
      'saving alpha unwired beta',
    ).toEqual(before);
    // The exit end of the link too: it terminates what the entry dials, so a
    // half-surviving cascade is a link nobody answers.
    expect((await getCascadeFragmentsForNode(bExit))?.inbounds.length).toBeGreaterThan(0);
  });

  it('leaves the other cascade’s rows in place', async () => {
    const aEntry = await node('a-entry');
    const aExit = await node('a-exit');
    const bEntry = await node('b-entry');
    const bExit = await node('b-exit');
    const a = await makeCascade('alpha', aEntry, aExit);
    const b = await makeCascade('beta', bEntry, bExit);

    await updateCascade(a.id, {
      positions: [{ position: 0, nodeIds: [aEntry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [{ countryCode: 'NL', nodeIds: [aExit] }],
    });

    // Directions carry the tag that travels inside every subscriber's UUID, so
    // losing and re-issuing them is not recoverable by a later save either.
    expect(await prisma.cascadeLink.count({ where: { cascadeId: b.id } })).toBeGreaterThan(0);
    expect(await prisma.cascadePosition.count({ where: { cascadeId: b.id } })).toBeGreaterThan(0);
    expect(await prisma.cascadeDirection.count({ where: { cascadeId: b.id } })).toBeGreaterThan(0);
  });
});
