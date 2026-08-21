import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createCascade, updateCascade } from './cascade.service.js';
import { CascadeValidationError } from './cascade.validation.js';
import { prisma } from '../../prisma.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { closeRedis } from '../../lib/redis.js';

/**
 * A rule forcing a direction is dropped at render time when the tag no longer
 * resolves — which is right, an unresolved outbound is a config xray refuses.
 * But dropping it silently means an operator saves a split, is told it worked,
 * and never learns it does nothing. So the save has to refuse first.
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

describe('a geo rule may only force a direction the cascade actually has', () => {
  it('refuses a save naming a tag that does not exist, and says which do', async () => {
    const entry = await node('entry');
    const exit = await node('exit');
    await expect(
      createCascade({
        name: 'bad-tag',
        enabled: true,
        positions: [
          {
            position: 0,
            nodeIds: [entry],
            entryProtocol: 'xray',
            linkProtocol: 'xray',
            egressPolicies: {
              [entry]: [{ geosite: ['category-ru'], target: 'direction', directionTag: 99 }],
            },
          },
        ],
        directions: [{ countryCode: 'NL', nodeIds: [exit] }],
      }),
    ).rejects.toThrow(CascadeValidationError);
  });

  it('accepts the tag the cascade just issued, and keeps it across an edit', async () => {
    const entry = await node('entry');
    const exit = await node('exit');
    const made = await createCascade({
      name: 'good-tag',
      enabled: true,
      positions: [
        { position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' },
      ],
      directions: [{ countryCode: 'NL', nodeIds: [exit] }],
    });
    const [dir] = await prisma.cascadeDirection.findMany({
      where: { cascadeId: made.id },
      orderBy: { tag: 'asc' },
      select: { id: true, tag: true },
    });
    const tag = dir!.tag;

    const edited = await updateCascade(made.id, {
      positions: [
        {
          position: 0,
          nodeIds: [entry],
          entryProtocol: 'xray',
          linkProtocol: 'xray',
          egressPolicies: {
            [entry]: [{ geosite: ['category-ru'], target: 'direction', directionTag: tag }],
          },
        },
      ],
      // The id is what carries the tag across the edit; without it the direction
      // would be re-issued and the rule would point at a tag that no longer exists.
      directions: [{ id: dir!.id, countryCode: 'NL', nodeIds: [exit] }],
    });
    expect(edited.positions[0]!.egressPolicies[entry]).toHaveLength(1);
  });

  it('refuses a rule whose direction was deleted in the same save', async () => {
    const entry = await node('entry');
    const a = await node('a');
    const b = await node('b');
    const made = await createCascade({
      name: 'drop-dir',
      enabled: true,
      positions: [
        { position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' },
      ],
      directions: [
        { countryCode: 'NL', nodeIds: [a] },
        { countryCode: 'DE', nodeIds: [b] },
      ],
    });
    const dirs = await prisma.cascadeDirection.findMany({
      where: { cascadeId: made.id },
      orderBy: { tag: 'asc' },
      select: { id: true, tag: true },
    });
    const doomed = dirs[1]!;
    await expect(
      updateCascade(made.id, {
        positions: [
          {
            position: 0,
            nodeIds: [entry],
            entryProtocol: 'xray',
            linkProtocol: 'xray',
            egressPolicies: {
              [entry]: [{ geosite: ['ads'], target: 'direction', directionTag: doomed.tag }],
            },
          },
        ],
        // ...and the direction that rule points at is gone from this payload.
        directions: [{ id: dirs[0]!.id, countryCode: 'NL', nodeIds: [a] }],
      }),
    ).rejects.toThrow(/does not have/);
  });
});

describe('a custom geo category cannot be deleted while a split routes by it', () => {
  it('reports the cascades using it', async () => {
    const { nodesUsingGeoCategory } = await import('./cascade.service.js');
    const entry = await node('entry');
    const exit = await node('exit');
    await createCascade({
      name: 'uses-ads',
      enabled: true,
      positions: [
        {
          position: 0,
          nodeIds: [entry],
          entryProtocol: 'xray',
          linkProtocol: 'xray',
          egressPolicies: {
            [entry]: [{ domain: ['ext:geo-custom.dat:ADS'], target: 'block' }],
          },
        },
      ],
      directions: [{ countryCode: 'NL', nodeIds: [exit] }],
    });

    // Case-insensitive, the way the builder normalises category names.
    expect(await nodesUsingGeoCategory('ads')).toEqual(['uses-ads']);
    expect(await nodesUsingGeoCategory('ADS')).toEqual(['uses-ads']);
    // A category nobody routes by is free to delete.
    expect(await nodesUsingGeoCategory('unused')).toEqual([]);
    // A bundled category is not an ext: reference and must not count.
    expect(await nodesUsingGeoCategory('category-ru')).toEqual([]);
  });
});
