// What a live inter-hop link authenticates with must survive an unrelated edit.
//
// Writing the topology means replacing its rows: positions, directions and
// links are interdependent, so they are dropped and rebuilt rather than
// diffed. Re-MINTING the credentials in the process is a different thing, and
// it was happening on every save. Measured against the live panel on
// 2026-08-29 with a byte-identical topology and only the name changed:
//
//   before  uuid 39d56fb7-… shortId 2047ad9e1d6a78bb  pub CYk2844OtiPv…
//   after   uuid 25ad2f17-… shortId bc6a29b2ef963810  pub 3xx8JawRvVdY…
//
// The cascade editor sends the whole topology on every save, so a rename or a
// flip of "hide hops" was enough. Each hop then learns the new secret in its
// own push, so the chain is down between them, and a hop whose push fails is
// cut off with nothing saying so.
//
// The push path already reasoned this way - "link creds are read from each
// originating hop's persisted linkConfig ... regenerating uuids/ports per push
// would tear down every live link" - and so does the direction TAG, which
// writeTopologyV4 goes out of its way to match to a stored one by its pool.
// The credentials were the member of that family nobody had asked about.

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

async function links(cascadeId: string) {
  return prisma.cascadeLink.findMany({
    where: { cascadeId },
    select: { fromNodeId: true, toNodeId: true, directionTag: true, config: true },
    orderBy: [{ fromNodeId: 'asc' }, { toNodeId: 'asc' }, { directionTag: 'asc' }],
  });
}

beforeEach(async () => {
  await cleanDatabase();
});
afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('a leg that survives a save keeps its credentials', () => {
  it('a rename changes nothing about any link', async () => {
    const entry = await node('entry');
    const exit = await node('exit');
    const c = await createCascade({
      name: 'identity',
      enabled: false,
      hideHopsFromSub: true,
      autoProfile: false,
      mode: 'chain',
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [{ nodeIds: [exit] }],
    });
    const before = await links(c.id);
    expect(before.length, 'no links to compare').toBeGreaterThan(0);

    await updateCascade(c.id, {
      name: 'identity-renamed',
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [{ nodeIds: [exit] }],
    });

    expect(await links(c.id), 'a rename rotated the secrets of every leg').toEqual(before);
  });

  it('a leg that genuinely changed ends gets a fresh credential', async () => {
    // The other side: the carry must be keyed on the leg, not applied blindly,
    // or a new machine would inherit a retired one's identity.
    const entry = await node('entry');
    const exit = await node('exit');
    const other = await node('other');
    const c = await createCascade({
      name: 'identity-2',
      enabled: false,
      hideHopsFromSub: true,
      autoProfile: false,
      mode: 'chain',
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [{ nodeIds: [exit] }],
    });
    const before = await links(c.id);

    await updateCascade(c.id, {
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [{ nodeIds: [other] }],
    });
    const after = await links(c.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.toNodeId).toBe(other);
    expect(
      (after[0]!.config as { uuid?: string }).uuid,
      'a new exit inherited the retired one\'s identity',
    ).not.toBe((before[0]!.config as { uuid?: string }).uuid);
  });

  it('a leg added into a node that already receives one reuses that node\'s REALITY identity', async () => {
    // One inbound, one keypair: every link into a receiving node lands on its
    // single link-in inbound, and REALITY there has one private key. A save
    // that adds an entry to the pool must join the identity the exit already
    // has, not mint it a second one.
    const entryA = await node('entry-a');
    const entryB = await node('entry-b');
    const exit = await node('exit');
    const c = await createCascade({
      name: 'identity-3',
      enabled: false,
      hideHopsFromSub: true,
      autoProfile: false,
      mode: 'chain',
      positions: [
        { position: 0, nodeIds: [entryA], entryProtocol: 'xray', linkProtocol: 'xray' },
      ],
      directions: [{ nodeIds: [exit] }],
    });
    const first = (await links(c.id))[0]!.config as { reality?: { privateKey: string } };

    await updateCascade(c.id, {
      positions: [
        { position: 0, nodeIds: [entryA, entryB], entryProtocol: 'xray', linkProtocol: 'xray' },
      ],
      directions: [{ nodeIds: [exit] }],
    });
    const all = await links(c.id);
    expect(all.length, 'the added entry produced no leg').toBe(2);
    const keys = new Set(
      all.map((l) => (l.config as { reality?: { privateKey: string } }).reality?.privateKey),
    );
    expect(keys.size, 'one receiving node ended up with two REALITY private keys').toBe(1);
    expect([...keys][0]).toBe(first.reality?.privateKey);
  });

  /**
   * The hop-shaped payload is the other writer of the same decision, and it
   * keeps its cred on the ORIGINATING hop rather than in a link row. Asked
   * separately because "the v4 path is fixed" is not "the family is fixed".
   */
  it('the legacy hop shape keeps its creds across a rename too', async () => {
    const entry = await node('hop-entry');
    const exit = await node('hop-exit');
    const c = await createCascade({
      name: 'identity-hops',
      enabled: false,
      hideHopsFromSub: true,
      autoProfile: false,
      mode: 'chain',
      hops: [
        { nodeId: entry, position: 0, entryProtocol: 'xray', linkProtocol: 'xray' },
        { nodeId: exit, position: 1 },
      ],
    });
    const read = async () =>
      (
        await prisma.cascadeHop.findMany({
          where: { cascadeId: c.id },
          select: { nodeId: true, position: true, linkConfig: true },
          orderBy: { position: 'asc' },
        })
      ).map((h) => JSON.stringify(h));
    const before = await read();
    expect(before.length).toBe(2);

    await updateCascade(c.id, {
      name: 'identity-hops-renamed',
      hops: [
        { nodeId: entry, position: 0, entryProtocol: 'xray', linkProtocol: 'xray' },
        { nodeId: exit, position: 1 },
      ],
    });
    expect(await read(), 'a rename rotated the hop-shaped link cred').toEqual(before);
  });
});
