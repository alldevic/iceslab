// The two live gauges, and the question they answer differently from the rest
// of the panel.
//
// `iceslab_nodes` and `iceslab_users` are the numbers an operator's alerting
// reads. Both are filled by one loop, from two queries ten lines apart, and
// only the node one filtered soft-deleted rows. Deletion in this panel is soft
// and leaves `status` untouched, so every user ever deleted stayed in the gauge
// under the status they were deleted in - `iceslab_users{status="active"}` kept
// counting an account that had been gone for months, while the dashboard, which
// filters, said something else about the same database.
//
// Both directions are asserted here: the filter has to remove the deleted rows
// AND leave the live ones, or "0" would pass for the right reason by accident.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../prisma.js';
import { cleanDatabase } from '../../tests/helpers/db.js';
import { generateUserCredentials } from './credentials.js';
import { registry } from './metrics.js';
import { refreshOnce } from './metrics-refresh.js';

let seq = 0;

async function makeUser(status: string, deleted: boolean): Promise<void> {
  seq += 1;
  const c = generateUserCredentials();
  await prisma.user.create({
    data: {
      username: `gauge-${seq}`,
      status,
      deletedAt: deleted ? new Date() : null,
      shortId: c.shortId,
      subscriptionToken: c.subscriptionToken,
      hysteriaPassword: c.hysteriaPassword,
      naivePassword: c.naivePassword,
      xrayUuid: c.xrayUuid,
      amneziawgPrivateKey: c.amneziawgPrivateKey,
      amneziawgPublicKey: c.amneziawgPublicKey,
    },
  });
}

async function makeNode(status: string, deleted: boolean): Promise<void> {
  seq += 1;
  await prisma.node.create({
    data: {
      name: `gauge-n-${seq}`,
      address: `gauge-n-${seq}.test:1337`,
      status,
      deletedAt: deleted ? new Date() : null,
      heartbeatSecret: Buffer.alloc(32),
    },
  });
}

/**
 * One gauge sample, read out of the process registry the way a scrape would.
 * Returns null when the label set is absent, which is a different answer from
 * zero: `reset()` drops labels rather than zeroing them.
 */
async function gauge(name: string, status: string): Promise<number | null> {
  const text = await registry.getSingleMetricAsString(name);
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue;
    if (!line.includes(`status="${status}"`)) continue;
    return Number(line.trim().split(/\s+/).pop());
  }
  return null;
}

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the live gauges count what still exists', () => {
  it('leaves soft-deleted users out of iceslab_users', async () => {
    await makeUser('active', false);
    await makeUser('active', true);
    await makeUser('active', true);

    await refreshOnce();

    expect(await gauge('iceslab_users', 'active')).toBe(1);
  });

  it('leaves soft-deleted nodes out of iceslab_nodes', async () => {
    await makeNode('online', false);
    await makeNode('online', true);

    await refreshOnce();

    expect(await gauge('iceslab_nodes', 'online')).toBe(1);
  });

  // The control on both: a gauge that reported nothing at all would satisfy
  // "the deleted ones are not counted" while being useless. Statuses that have
  // only deleted rows must drop out entirely rather than report a stale value,
  // which is what reset() is for.
  it('drops a status whose only rows were deleted, and keeps the live ones', async () => {
    await makeUser('active', false);
    await makeUser('limited', true);
    await makeNode('online', false);
    await makeNode('disabled', true);

    await refreshOnce();

    expect(await gauge('iceslab_users', 'active')).toBe(1);
    expect(await gauge('iceslab_users', 'limited')).toBeNull();
    expect(await gauge('iceslab_nodes', 'online')).toBe(1);
    expect(await gauge('iceslab_nodes', 'disabled')).toBeNull();
  });
});
