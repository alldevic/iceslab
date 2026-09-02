// A minted or revoked wg device has to reach the node (2026-09-02).
//
// Reported from live use as "deleted a device, downloaded the config again, it
// will not connect", and it is not the download that is wrong. Peers reach a
// node only through an inbound sync, and nothing ordered one when a device was
// minted - so the panel handed out a complete, correct `.conf` whose key
// existed nowhere on the machine. The handshake then fails silently, and it
// never heals: the periodic re-push only fires when a node's STATUS flips.
//
// Reproduced with a service account before the fix: the replacement device had
// its addresses in the panel and its public key was on neither wg0 nor awg0.
//
// The same failure is already described in inbounds.events.ts for
// `user.created` - "a valid .conf with a key the node does not have". It was
// closed there for the user lifecycle and left open for the device lifecycle,
// which is why these watch the EVENT: the event is what was missing, and the
// handler that turns it into a push is shared with the user events that work.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { generateUserCredentials } from '../../lib/credentials.js';
import { eventBus } from '../../lib/event-bus.js';
import { ensureDevices, revokeDevice } from './wg-devices.service.js';

const seen: { userId: string; reason: string }[] = [];
const record = (e: { userId: string; reason: string }) => void seen.push(e);

async function createUser(username: string): Promise<string> {
  const creds = generateUserCredentials();
  const user = await prisma.user.create({
    data: {
      username,
      shortId: creds.shortId,
      subscriptionToken: creds.subscriptionToken,
      hysteriaPassword: creds.hysteriaPassword,
      naivePassword: creds.naivePassword,
      xrayUuid: creds.xrayUuid,
      amneziawgPrivateKey: creds.amneziawgPrivateKey,
      amneziawgPublicKey: creds.amneziawgPublicKey,
    },
  });
  return user.id;
}

// Subscribed ONCE for the file. The bus has no `off` on purpose - every real
// subscription lasts for the life of the process - so a per-test `on` would
// stack handlers and each event would be recorded as many times as there had
// been tests.
beforeAll(() => {
  eventBus.on('wg-devices.changed', record);
});
beforeEach(async () => {
  await cleanDatabase();
  seen.length = 0;
});

/** The bus delivers on a microtask, so an assertion in the same tick as the
 *  emit reads an empty array and calls a working event missing. */
const settled = () => new Promise((r) => setTimeout(r, 0));
afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('a wg device that appears or leaves announces itself', () => {
  it('announces when devices are actually minted', async () => {
    const userId = await createUser('wgsync-mint');
    await ensureDevices(userId, 2);
    await settled();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.userId).toBe(userId);
  });

  it('stays quiet when the user already has enough', async () => {
    // The subscription calls this on EVERY wg fetch. Announcing each time would
    // order a push per poll on every wg-bearing node, for nothing: a mint is
    // the rare event, and the noisy version is the one that gets turned off.
    const userId = await createUser('wgsync-noop');
    await ensureDevices(userId, 2);
    seen.length = 0;
    await ensureDevices(userId, 2);
    await settled();
    expect(seen).toHaveLength(0);
  });

  it('announces the top-up that replaces a revoked device', async () => {
    // The reported case, end to end: revoke one, ask for the count again, and
    // the replacement must be announced. Before the fix the mint was silent and
    // the buyer's new config met a node that had never heard of it.
    const userId = await createUser('wgsync-replace');
    const devices = await ensureDevices(userId, 3);
    seen.length = 0;

    await revokeDevice(devices[0]!.id);
    await settled();
    expect(seen.map((e) => e.reason)).toContain('device revoked');

    seen.length = 0;
    const after = await ensureDevices(userId, 3);
    await settled();
    expect(after).toHaveLength(3);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.userId).toBe(userId);
  });

  it('names the device OWNER on a revoke, not the device', async () => {
    // The handler fans out over wg-bearing nodes for a user; the device id
    // would look right in the log and select nobody.
    const userId = await createUser('wgsync-owner');
    const devices = await ensureDevices(userId, 1);
    seen.length = 0;
    await revokeDevice(devices[0]!.id);
    await settled();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.userId).toBe(userId);
  });

  it('stays quiet when there was nothing to revoke', async () => {
    await revokeDevice('00000000-0000-4000-8000-000000000000');
    await settled();
    expect(seen).toHaveLength(0);
  });
});
