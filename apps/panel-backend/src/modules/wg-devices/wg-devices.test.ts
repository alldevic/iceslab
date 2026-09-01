// Per-device wg credentials, and what the node's numbers mean once they are
// per device.
//
// Both halves here exist because their failure is silent. A device set that
// drifts hands a buyer a config the node has no peer for - a tunnel that
// handshakes with nothing. A fold that loses a device id bills that traffic to
// nobody: quota stops counting, the "top users" card under-reports, and the
// only symptom is a number that is too small.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { generateUserCredentials } from '../../lib/credentials.js';
import {
  DEFAULT_WG_DEVICES,
  MAX_WG_DEVICES,
  ensureDevices,
  ensureDevicesForUsers,
  listActiveDevices,
  resolveWgDeviceCount,
  revokeDevice,
} from './wg-devices.service.js';
import { foldDeviceStats } from './wg-devices.stats.js';

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

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('ensureDevices', () => {
  it('mints distinct keypairs, one per device', async () => {
    const userId = await createUser('u1');
    const devices = await ensureDevices(userId, 3);
    expect(devices).toHaveLength(3);
    // The whole point: WireGuard tells peers apart by public key and by
    // nothing else, so a repeated key is a repeated peer.
    expect(new Set(devices.map((d) => d.publicKey)).size).toBe(3);
    expect(new Set(devices.map((d) => d.privateKey)).size).toBe(3);
  });

  it('is idempotent and keeps device order stable', async () => {
    const userId = await createUser('u1');
    const first = await ensureDevices(userId, 2);
    const again = await ensureDevices(userId, 2);
    expect(again.map((d) => d.id)).toEqual(first.map((d) => d.id));
  });

  it('orders deterministically when a whole batch shares one timestamp', async () => {
    // Postgres stamps the TRANSACTION, so devices minted in one createMany
    // carry the same created_at to the millisecond. Ordering on it alone left
    // their positions to the planner - and position is what the buyer's
    // "?device=2" link selects on, so a reshuffle hands them a config already
    // running on another phone. Measured on production: three devices, two
    // sharing a timestamp.
    const userId = await createUser('u1');
    const minted = await ensureDevices(userId, 5);
    const stamps = new Set(minted.map((d) => d.createdAt.getTime()));
    expect(stamps.size).toBeLessThan(minted.length); // the collision is real
    for (let i = 0; i < 5; i += 1) {
      const again = await listActiveDevices(userId);
      expect(again.map((d) => d.id)).toEqual(minted.map((d) => d.id));
    }
  });

  it('never takes a device away when asked for fewer', async () => {
    // Lowering a tariff must not silently cut somebody's tunnel; that is what
    // revokeDevice is for, and it leaves a trail.
    const userId = await createUser('u1');
    await ensureDevices(userId, 3);
    expect(await ensureDevices(userId, 1)).toHaveLength(3);
  });

  it('tops up in bulk without mixing users up', async () => {
    const a = await createUser('a');
    const b = await createUser('b');
    await ensureDevices(a, 2);
    const byUser = await ensureDevicesForUsers([
      { userId: a, count: 2 },
      { userId: b, count: 2 },
    ]);
    expect(byUser.get(a)).toHaveLength(2);
    expect(byUser.get(b)).toHaveLength(2);
    const keysA = new Set((byUser.get(a) ?? []).map((d) => d.publicKey));
    for (const d of byUser.get(b) ?? []) expect(keysA.has(d.publicKey)).toBe(false);
  });

  it('gives each user their OWN number in one batch', async () => {
    // A single count for the batch would hand somebody else's tariff to
    // somebody: three devices for one person and five for the next is the
    // normal case, not the exotic one.
    const a = await createUser('a');
    const b = await createUser('b');
    const byUser = await ensureDevicesForUsers([
      { userId: a, count: 1 },
      { userId: b, count: 3 },
    ]);
    expect(byUser.get(a)).toHaveLength(1);
    expect(byUser.get(b)).toHaveLength(3);
  });

  it('re-mints after a revocation instead of handing back the dead device', async () => {
    const userId = await createUser('u1');
    const [only] = await ensureDevices(userId, 1);
    await revokeDevice(only!.id);
    const after = await ensureDevices(userId, 1);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).not.toBe(only!.id);
    // The revoked row stays: its traffic history is the reason it exists, and
    // freeing its address would make an old config work again for someone else.
    expect(await prisma.wgDevice.count({ where: { userId } })).toBe(2);
    expect(await listActiveDevices(userId)).toHaveLength(1);
  });
});

describe('resolveWgDeviceCount', () => {
  it('falls back when there is no policy, because "unlimited" cannot be pre-cut', () => {
    expect(resolveWgDeviceCount(null)).toBe(DEFAULT_WG_DEVICES);
    expect(resolveWgDeviceCount(null, [], 5)).toBe(5);
  });

  it('honours a policy but never past the hard ceiling', () => {
    expect(resolveWgDeviceCount(2)).toBe(2);
    expect(resolveWgDeviceCount(MAX_WG_DEVICES + 50)).toBe(MAX_WG_DEVICES);
  });

  it('falls back to the most permissive squad, and the user still wins over it', () => {
    // Same most-permissive-wins rule the HWID gate applies, from the same
    // function - two readings of one entitlement is how a person ends up with
    // four devices in the subscription and three on the node.
    expect(resolveWgDeviceCount(null, [2, null, 5])).toBe(5);
    expect(resolveWgDeviceCount(1, [2, 5])).toBe(1);
    expect(resolveWgDeviceCount(null, [null, null])).toBe(DEFAULT_WG_DEVICES);
  });

  it('never returns zero: a buyer with no tunnel at all is not a tariff, it is an outage', () => {
    expect(resolveWgDeviceCount(0)).toBe(1);
    expect(resolveWgDeviceCount(-3)).toBe(1);
  });
});

describe('foldDeviceStats', () => {
  it('bills a device to its owner and accumulates the device counters', async () => {
    const userId = await createUser('u1');
    const [device] = await ensureDevices(userId, 1);

    const out = await foldDeviceStats([
      { userId: device!.id, bytesIn: 100, bytesOut: 50 },
    ]);

    expect(out).toEqual([{ userId, bytesIn: 100, bytesOut: 50 }]);
    const row = await prisma.wgDevice.findUnique({ where: { id: device!.id } });
    expect(row?.bytesIn).toBe(100n);
    expect(row?.bytesOut).toBe(50n);
    expect(row?.lastSeenAt).toBeInstanceOf(Date);
  });

  it('SUMS two devices of one person instead of letting one overwrite the other', async () => {
    // The snapshot upsert downstream is keyed on (node, user); two rows with
    // the same userId would not add up there, they would race.
    const userId = await createUser('u1');
    const devices = await ensureDevices(userId, 2);

    const out = await foldDeviceStats([
      { userId: devices[0]!.id, bytesIn: 10, bytesOut: 1 },
      { userId: devices[1]!.id, bytesIn: 20, bytesOut: 2 },
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ userId, bytesIn: 30, bytesOut: 3 });
  });

  it('passes non-device entries through untouched', async () => {
    const userId = await createUser('u1');
    await ensureDevices(userId, 1);
    const entries = [{ userId, bytesIn: 7, bytesOut: 8, cumulative: true }];
    expect(await foldDeviceStats(entries)).toEqual(entries);
  });

  it('does not stamp lastSeenAt for a poll that moved nothing', async () => {
    // A peer that exists but is idle reports zeroes every 30 seconds. Treating
    // that as "seen" would make every device look permanently in use.
    const userId = await createUser('u1');
    const [device] = await ensureDevices(userId, 1);
    await foldDeviceStats([{ userId: device!.id, bytesIn: 0, bytesOut: 0 }]);
    const row = await prisma.wgDevice.findUnique({ where: { id: device!.id } });
    expect(row?.lastSeenAt).toBeNull();
    expect(row?.bytesIn).toBe(0n);
  });

  it('keeps a cumulative entry apart from a delta one for the same person', async () => {
    // Merging them would add a since-boot counter to a per-poll delta.
    const userId = await createUser('u1');
    const [device] = await ensureDevices(userId, 1);
    const out = await foldDeviceStats([
      { userId, bytesIn: 1000, bytesOut: 0, cumulative: true },
      { userId: device!.id, bytesIn: 5, bytesOut: 0 },
    ]);
    expect(out).toHaveLength(2);
    expect(out.every((e) => e.userId === userId)).toBe(true);
    expect(out.find((e) => e.cumulative)?.bytesIn).toBe(1000);
    expect(out.find((e) => !e.cumulative)?.bytesIn).toBe(5);
  });
});
