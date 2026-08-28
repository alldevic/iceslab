import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createCascade, getCascade } from './cascade.service.js';
import { prisma } from '../../prisma.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { closeRedis } from '../../lib/redis.js';

/**
 * The answer to a create must be the cascade that was created.
 *
 * It was not. `createCascade` captured the row from `tx.cascade.create(...)`
 * and returned it, while the v4 topology - positions, directions, and the
 * direction TAGS - is written after that, in the same transaction. So the
 * create answered `positions: []`, `directions: []` and a `nextDirectionTag`
 * one short, and a GET of the same id a millisecond later disagreed with it.
 * `updateCascade` re-reads and has always been right; this is the same decision
 * with a guard on one of its two writers.
 *
 * The tag is why it matters rather than being cosmetic: it is minted here and
 * nowhere else, it travels inside the user's UUID, and squad ACL cuts access by
 * it. The create response was the one place a client could learn it, and it was
 * the one place that did not carry it.
 */

let seq = 0;
async function node(name: string): Promise<string> {
  seq += 1;
  const row = await prisma.node.create({
    data: { name: `${name}-${seq}`, address: `${name}-${seq}.test:1337`, heartbeatSecret: Buffer.alloc(32) },
  });
  return row.id;
}

beforeEach(async () => {
  await cleanDatabase();
});
afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('the create response is the cascade a read returns', () => {
  it('carries the positions, the directions and their minted tags', async () => {
    const entry = await node('entry');
    const exit = await node('exit');

    const created = await createCascade({
      name: 'create-response',
      enabled: false,
      hideHopsFromSub: true,
      autoProfile: false,
      mode: 'chain',
      positions: [
        {
          position: 0,
          nodeIds: [entry],
          entryProtocol: 'xray',
          linkProtocol: 'xray',
          egressPolicies: { [entry]: [{ geosite: ['category-ads-all'], target: 'block' }] },
        },
      ],
      directions: [{ name: 'nl', nodeIds: [exit] }],
    });

    // The control: a read of the same id, which was already correct. Comparing
    // against it rather than against literals keeps this test about the
    // DISAGREEMENT, so it cannot pass by both sides being wrong together.
    const read = await getCascade(created.id);

    expect(created.directions, 'the create answered with no directions').toEqual(read.directions);
    expect(created.positions, 'the create answered with no positions').toEqual(read.positions);
    expect(
      created.nextDirectionTag,
      'the create answered with the tag counter as it was BEFORE the directions it just minted',
    ).toBe(read.nextDirectionTag);

    // And the part a client cannot compute for itself.
    expect(created.directions).toHaveLength(1);
    expect(created.directions[0]!.tag).toBeGreaterThan(0);
    expect(created.positions[0]!.egressPolicies).toEqual({
      [entry]: [{ geosite: ['category-ads-all'], target: 'block' }],
    });
  });

  it('still answers a cascade sent in the legacy hop shape', async () => {
    // The re-read is conditional on there being a v4 topology to write. This is
    // the other branch: no positions/directions, nothing written after the
    // create, and the row captured by `create` is already current.
    const entry = await node('h-entry');
    const exit = await node('h-exit');
    const created = await createCascade({
      name: 'legacy-hops',
      enabled: false,
      hideHopsFromSub: true,
      autoProfile: false,
      mode: 'chain',
      hops: [
        { nodeId: entry, position: 0, entryProtocol: 'xray', linkProtocol: 'xray' },
        { nodeId: exit, position: 1 },
      ],
    });
    const read = await getCascade(created.id);
    expect(created.hops.map((h) => h.nodeId)).toEqual(read.hops.map((h) => h.nodeId));
  });
});
