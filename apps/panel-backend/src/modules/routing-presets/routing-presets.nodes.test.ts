import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { makeNode, makeSquad, makeUser } from '../../../tests/helpers/preset-nodes.js';
import { nodesOfPreset, presetNodeIndex } from './routing-presets.nodes.js';

/** 19.10: which nodes serve the users of a preset. */
beforeEach(cleanDatabase);
afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

const preset = async (name: string) => (await prisma.routingPreset.create({ data: { name }, select: { id: true } })).id;

describe('nodesOfPreset', () => {
  it('two squads with two presets and one shared node: each preset reaches its squad\'s nodes', async () => {
    const [n1, shared, n3] = [await makeNode(), await makeNode(), await makeNode()];
    const pa = await preset('A');
    const pb = await preset('B');
    await makeSquad([n1.id, shared.id], { presetId: pa });
    await makeSquad([shared.id, n3.id], { presetId: pb });
    expect((await nodesOfPreset(pa)).sort()).toEqual([n1.id, shared.id].sort());
    expect((await nodesOfPreset(pb)).sort()).toEqual([shared.id, n3.id].sort());
    expect(await nodesOfPreset(await preset('C'))).toEqual([]);
  });

  it('a user with the preset reaches the nodes of the squads they belong to, and a deleted user none', async () => {
    const [n1, n2] = [await makeNode(), await makeNode()];
    const p = await preset('U');
    const squad = await makeSquad([n1.id]);
    await makeSquad([n2.id]);
    await makeUser({ squadId: squad.id, presetId: p });
    expect(await nodesOfPreset(p)).toEqual([n1.id]);
    await makeUser({ presetId: p }); // in no squad: serves nothing
    expect(await nodesOfPreset(p)).toEqual([n1.id]);
    await prisma.user.updateMany({ data: { deletedAt: new Date() } });
    expect(await nodesOfPreset(p)).toEqual([]);
  });

  it('a binding or a profile that is off reaches nothing', async () => {
    const n = await makeNode();
    const p = await preset('Off');
    const off = await makeSquad([n.id], { presetId: p, enabled: false });
    expect(await nodesOfPreset(p)).toEqual([]);
    await prisma.profile.update({ where: { id: off.profileId }, data: { enabled: true } });
    expect(await nodesOfPreset(p)).toEqual([n.id]);
    await prisma.profileNodeBinding.updateMany({ data: { enabled: false } });
    expect((await presetNodeIndex()).get(p) ?? new Set()).toEqual(new Set());
  });
});
