import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { closeRedis } from '../../lib/redis.js';
import { egressCatalogue, UNLABELLED_AS } from './egress.catalogue.js';

/**
 * The catalogue's job is to turn one node's measurement into something the next
 * box on that uplink can start from. So what it must get right is the grouping
 * (by the network the DPI belongs to) and the ordering (the most recent
 * observation, because a censor that changed last week invalidates June).
 */

let seq = 0;
async function node(opts: {
  asn?: string;
  args?: string;
  observedAt?: string;
}): Promise<string> {
  seq += 1;
  const n = await prisma.node.create({
    data: {
      name: `cat-${seq}`,
      address: `cat-${seq}.test:1337`,
      heartbeatSecret: Buffer.alloc(32),
      ...(opts.asn ? { hardening: { pool: { asn: opts.asn } } as never } : {}),
      ...(opts.args !== undefined
        ? {
            egressTune: {
              domain: 'rutracker.org',
              protocol: 'HTTPS/TLS1.3',
              args: opts.args,
              total: 42,
              working: 3,
              observedAt: opts.observedAt ?? '2026-08-01T00:00:00.000Z',
            } as never,
          }
        : {}),
    },
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

describe('egressCatalogue', () => {
  it('is empty until a node has reported', async () => {
    await node({ asn: 'AS12345' });
    expect(await egressCatalogue()).toEqual([]);
  });

  // Two boxes on one carrier agreeing is the signal an operator adopts from;
  // one box on its own is a data point.
  it('groups nodes that found the same strategy on the same AS', async () => {
    await node({ asn: 'AS12345', args: '--lua-desync=A' });
    await node({ asn: 'AS12345', args: '--lua-desync=A' });
    await node({ asn: 'AS12345', args: '--lua-desync=B' });

    const groups = await egressCatalogue();
    expect(groups).toHaveLength(1);
    expect(groups[0].asn).toBe('AS12345');
    const byArgs = Object.fromEntries(groups[0].strategies.map((s) => [s.args, s.nodes.length]));
    expect(byArgs).toEqual({ '--lua-desync=A': 2, '--lua-desync=B': 1 });
  });

  // The DPI belongs to the carrier, so two boxes in one country on different
  // carriers are different questions.
  it('keeps different networks apart', async () => {
    await node({ asn: 'AS1', args: '--lua-desync=A' });
    await node({ asn: 'AS2', args: '--lua-desync=A' });
    expect((await egressCatalogue()).map((g) => g.asn)).toEqual(['AS1', 'AS2']);
  });

  it('still lists a node nobody labelled', async () => {
    await node({ args: '--lua-desync=A' });
    const groups = await egressCatalogue();
    expect(groups[0].asn).toBe(UNLABELLED_AS);
  });

  it('puts the most recently observed strategy first', async () => {
    await node({ asn: 'AS1', args: '--lua-desync=old', observedAt: '2026-06-01T00:00:00.000Z' });
    await node({ asn: 'AS1', args: '--lua-desync=new', observedAt: '2026-08-20T00:00:00.000Z' });
    expect((await egressCatalogue())[0].strategies.map((s) => s.args)).toEqual([
      '--lua-desync=new',
      '--lua-desync=old',
    ]);
  });

  // "Nothing here needed a bypass" is a real and useful report, but it is not a
  // strategy to copy.
  it('skips a report that found no strategy', async () => {
    await node({ asn: 'AS1', args: '' });
    expect(await egressCatalogue()).toEqual([]);
  });
});
