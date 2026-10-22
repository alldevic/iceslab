import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { createCascade, updateCascade, CascadePositionMovedError } from './cascade.service.js';

/**
 * A-140: leg settings of a position are kept by its NUMBER, so a client that
 * swaps two transits without sending linkParams would hand each leg the
 * other's settings. The save is refused instead; with linkParams it goes
 * through and the settings travel with their pools.
 */
async function node(name: string): Promise<string> {
  const n = await prisma.node.create({
    data: { name, address: `${name}.example.com`, protocol: 'xray', heartbeatSecret: randomBytes(32) },
    select: { id: true },
  });
  return n.id;
}

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

async function cascadeWithTwoTransits() {
  const [entry, a, b, nl] = [await node('ru-in'), await node('tr-a'), await node('tr-b'), await node('nl-out')];
  const c = await createCascade({
    name: 'two-transits',
    enabled: false,
    positions: [
      { position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'tuic' },
      { position: 1, nodeIds: [a], linkProtocol: 'tuic', linkParams: { congestion: 'bbr' } },
      { position: 2, nodeIds: [b], linkProtocol: 'tuic', linkParams: { congestion: 'cubic' } },
    ],
    directions: [{ countryCode: 'NL', nodeIds: [nl] }],
  } as never);
  const dir = await prisma.cascadeDirection.findFirstOrThrow({ where: { cascadeId: c.id } });
  return { id: c.id, entry, a, b, nl, dirId: dir.id };
}

const positions = async (cascadeId: string) =>
  (
    await prisma.cascadePosition.findMany({
      where: { cascadeId },
      orderBy: { position: 'asc' },
      select: { position: true, linkParams: true, nodes: { select: { nodeId: true } } },
    })
  ).map((p) => ({ position: p.position, nodeIds: p.nodes.map((n) => n.nodeId), linkParams: p.linkParams }));

describe('moving a transit position', () => {
  it('swapping two transits without linkParams is refused, and nothing is written', async () => {
    const c = await cascadeWithTwoTransits();
    const before = await positions(c.id);
    const swap = updateCascade(c.id, {
      positions: [
        { position: 0, nodeIds: [c.entry], entryProtocol: 'xray', linkProtocol: 'tuic' },
        { position: 1, nodeIds: [c.b], linkProtocol: 'tuic' },
        { position: 2, nodeIds: [c.a], linkProtocol: 'tuic' },
      ],
      directions: [{ id: c.dirId }],
    } as never);
    await expect(swap).rejects.toBeInstanceOf(CascadePositionMovedError);
    await expect(swap).rejects.toThrow('position 1 holds the nodes stored at position 2');
    expect(await positions(c.id)).toEqual(before);
  });

  it('the same swap with linkParams is saved, and the settings move with their pools', async () => {
    const c = await cascadeWithTwoTransits();
    await updateCascade(c.id, {
      positions: [
        { position: 0, nodeIds: [c.entry], entryProtocol: 'xray', linkProtocol: 'tuic' },
        { position: 1, nodeIds: [c.b], linkProtocol: 'tuic', linkParams: { congestion: 'cubic' } },
        { position: 2, nodeIds: [c.a], linkProtocol: 'tuic', linkParams: { congestion: 'bbr' } },
      ],
      directions: [{ id: c.dirId }],
    } as never);
    const after = await positions(c.id);
    expect(after[1]).toMatchObject({ nodeIds: [c.b], linkParams: { congestion: 'cubic' } });
    expect(after[2]).toMatchObject({ nodeIds: [c.a], linkParams: { congestion: 'bbr' } });
  });

  it('an edit that keeps every pool in its place may still leave the knobs out', async () => {
    const c = await cascadeWithTwoTransits();
    await updateCascade(c.id, {
      positions: [
        { position: 0, nodeIds: [c.entry], entryProtocol: 'xray', linkProtocol: 'tuic' },
        { position: 1, nodeIds: [c.a], linkProtocol: 'tuic' },
        { position: 2, nodeIds: [c.b], linkProtocol: 'tuic' },
      ],
      directions: [{ id: c.dirId }],
    } as never);
    const after = await positions(c.id);
    expect(after[1]!.linkParams).toEqual({ congestion: 'bbr' });
    expect(after[2]!.linkParams).toEqual({ congestion: 'cubic' });
  });
});
