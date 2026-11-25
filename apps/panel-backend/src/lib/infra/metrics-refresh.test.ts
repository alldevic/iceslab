import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { generateUserCredentials } from '../auth/credentials.js';
import { registry } from './metrics.js';
import { refreshOnce } from './metrics-refresh.js';

/**
 * iceslab_users is what an operator's alerting reads. Deletion is soft and
 * leaves `status` untouched, so a gauge that does not filter counts every user
 * ever deleted under the status they had. Both directions are asserted: the
 * deleted rows go AND the live ones stay.
 */

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

/** One sample read out of the registry as a scrape would; null = label absent. */
async function usersGaugeFor(status: string): Promise<number | null> {
  const text = await registry.getSingleMetricAsString('iceslab_users');
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

describe('iceslab_users{status}', () => {
  it('leaves soft-deleted users out of every series', async () => {
    await makeUser('active', false);
    await makeUser('active', true);
    await makeUser('active', true);

    await refreshOnce();

    expect(await usersGaugeFor('active')).toBe(1);
  });

  it('drops a status whose only users were deleted, instead of keeping the last pass value', async () => {
    await makeUser('limited', false);
    await refreshOnce();
    expect(await usersGaugeFor('limited')).toBe(1);

    await prisma.user.updateMany({ data: { deletedAt: new Date() } });
    await makeUser('active', false);
    await refreshOnce();

    expect(await usersGaugeFor('active')).toBe(1);
    expect(await usersGaugeFor('limited')).toBeNull();
  });
});
