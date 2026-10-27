import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { rotateHysteriaTls, ensureHysteriaTls } from '../nodes/hysteria-tls.js';
import { ensureAwg3Geometry } from '../nodes/awg3-geometry.js';
import { getCachedBindings } from './subscription.bindings-cache.js';

/**
 * A-165: the pin and the 3.1 geometry are written at push time, straight to
 * the node row the subscription caches. Each write drops the cache, or for a
 * minute every subscription handed out the old pin and a client that took it
 * stayed off until its next refresh, a day by default.
 */

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

async function node(address: string): Promise<string> {
  const n = await prisma.node.create({
    data: { name: `pc-${address}`, address, protocol: 'hysteria', heartbeatSecret: Buffer.alloc(32) },
    select: { id: true },
  });
  return n.id;
}

/** Loads through the cache and reports whether the loader ran. */
async function loaded(): Promise<boolean> {
  let ran = false;
  await getCachedBindings('pc', Date.now(), async () => {
    ran = true;
    return [];
  });
  return ran;
}

describe('the subscription cache after a write at push time', () => {
  it('a pin minted, a pin rotated and a geometry minted each drop it; a pin or geometry already there does not', async () => {
    const id = await node('203.0.113.20');
    await loaded();
    expect(await loaded(), 'cached').toBe(false);

    await ensureHysteriaTls(id);
    expect(await loaded(), 'pin minted').toBe(true);
    await ensureHysteriaTls(id);
    expect(await loaded(), 'pin already there').toBe(false);

    await rotateHysteriaTls(id);
    expect(await loaded(), 'pin rotated').toBe(true);

    await ensureAwg3Geometry(id);
    expect(await loaded(), 'geometry minted').toBe(true);
    await ensureAwg3Geometry(id);
    expect(await loaded(), 'geometry already there').toBe(false);
  });
});
