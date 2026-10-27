import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { generateUserCredentials } from '../../lib/auth/credentials.js';
import {
  DEFAULT_SUBNET,
  IpExhaustedError,
  allocatePeer,
  getPeer,
  listPeers,
  preallocatePeers,
  releasePeer,
} from './amneziawg.service.js';

// Slice 27: peer allocation is keyed on profileId (the logical AmneziaWG
// inbound), not the per-node Inbound row. Tests now seed Profile rows.
// Since devices, on (profile, device): createUser hands back the device.

async function createProfile(name = 'awg0'): Promise<string> {
  const profile = await prisma.profile.create({
    data: {
      name,
      protocol: 'amneziawg',
      config: { subnet: DEFAULT_SUBNET },
    },
  });
  return profile.id;
}

/** A user with one WireGuard device: the device is what holds an address. */
async function createUser(username: string): Promise<{ id: string; userId: string }> {
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
  const device = await prisma.wgDevice.create({
    data: { userId: user.id, privateKey: creds.amneziawgPrivateKey, publicKey: creds.amneziawgPublicKey },
  });
  return { id: device.id, userId: user.id };
}

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('allocatePeer', () => {
  it('hands out the lowest free IP starting at .2', async () => {
    const profileId = await createProfile();
    const u1 = await createUser('alice');
    const u2 = await createUser('bob');

    const a = await allocatePeer(profileId, u1);
    const b = await allocatePeer(profileId, u2);

    expect(a.ip).toBe('10.66.66.2');
    expect(b.ip).toBe('10.66.66.3');
  });

  it('is idempotent for the same (profile, device)', async () => {
    const profileId = await createProfile();
    const u = await createUser('alice');

    const a = await allocatePeer(profileId, u);
    const b = await allocatePeer(profileId, u);

    expect(a.id).toBe(b.id);
    expect(a.ip).toBe(b.ip);
  });

  it('reuses gaps after a release', async () => {
    const profileId = await createProfile();
    const u1 = await createUser('alice');
    const u2 = await createUser('bob');
    const u3 = await createUser('carol');

    await allocatePeer(profileId, u1); // .2
    const peer2 = await allocatePeer(profileId, u2); // .3
    expect(peer2.ip).toBe('10.66.66.3');

    await releasePeer(profileId, u2.userId);
    const peer3 = await allocatePeer(profileId, u3);
    expect(peer3.ip).toBe('10.66.66.3');
  });

  it('isolates allocations per profile', async () => {
    const p1 = await createProfile('awg-a');
    const p2 = await createProfile('awg-b');
    const u = await createUser('alice');

    const a1 = await allocatePeer(p1, u);
    const a2 = await allocatePeer(p2, u);

    expect(a1.ip).toBe('10.66.66.2');
    expect(a2.ip).toBe('10.66.66.2');
  });

  it('respects a custom subnet', async () => {
    const profileId = await createProfile();
    const u = await createUser('alice');

    const p = await allocatePeer(profileId, u, '172.16.0.0/24');
    expect(p.ip).toBe('172.16.0.2');
  });

  it('throws IpExhaustedError when the range is full', async () => {
    const profileId = await createProfile();
    // /30 has 4 addresses, .0 net + .1 server + .3 broadcast → exactly one usable (.2)
    const u1 = await createUser('alice');
    const u2 = await createUser('bob');

    await allocatePeer(profileId, u1, '10.99.0.0/30');
    await expect(
      allocatePeer(profileId, u2, '10.99.0.0/30'),
    ).rejects.toBeInstanceOf(IpExhaustedError);
  });
});

describe('getPeer / listPeers / releasePeer', () => {
  it('returns null when no allocation exists', async () => {
    const profileId = await createProfile();
    const u = await createUser('alice');
    expect(await getPeer(profileId, u.id)).toBeNull();
  });

  it('lists peers in IP order', async () => {
    const profileId = await createProfile();
    const u1 = await createUser('alice');
    const u2 = await createUser('bob');
    const u3 = await createUser('carol');

    await allocatePeer(profileId, u2);
    await allocatePeer(profileId, u1);
    await allocatePeer(profileId, u3);

    const peers = await listPeers(profileId);
    expect(peers.map((p) => p.ip)).toEqual(['10.66.66.2', '10.66.66.3', '10.66.66.4']);
  });

  it('release is a no-op when nothing is allocated', async () => {
    const profileId = await createProfile();
    const u = await createUser('alice');
    await expect(releasePeer(profileId, u.userId)).resolves.toBeUndefined();
  });
});

describe('preallocatePeers (B7 bulk)', () => {
  it('hands out distinct lowest free IPs to every user in one call', async () => {
    const profileId = await createProfile();
    const ids = [
      await createUser('alice'),
      await createUser('bob'),
      await createUser('carol'),
    ];

    const map = await preallocatePeers(profileId, ids);
    expect(map.size).toBe(3);
    const ips = [...map.values()].sort();
    expect(ips).toEqual(['10.66.66.2', '10.66.66.3', '10.66.66.4']);
    expect(new Set(ips).size).toBe(3); // distinct
  });

  it('preserves existing peers and only fills the rest', async () => {
    const profileId = await createProfile();
    const u1 = await createUser('alice');
    const u2 = await createUser('bob');
    const existing = await allocatePeer(profileId, u1); // takes .2

    const map = await preallocatePeers(profileId, [u1, u2]);
    expect(map.get(u1.id)).toBe(existing.ip); // unchanged
    expect(map.get(u2.id)).toBe('10.66.66.3'); // next free
  });

  it('reuses a gap left by a release', async () => {
    const profileId = await createProfile();
    const u1 = await createUser('alice');
    const u2 = await createUser('bob');
    const u3 = await createUser('carol');
    await allocatePeer(profileId, u1); // .2
    await allocatePeer(profileId, u2); // .3
    await releasePeer(profileId, u1.userId); // frees .2

    const map = await preallocatePeers(profileId, [u3]);
    expect(map.get(u3.id)).toBe('10.66.66.2'); // lowest free reused
  });

  it('is a no-op second call (idempotent), returning the same IPs', async () => {
    const profileId = await createProfile();
    const ids = [await createUser('alice'), await createUser('bob')];
    const first = await preallocatePeers(profileId, ids);
    const second = await preallocatePeers(profileId, ids);
    expect([...second.entries()].sort()).toEqual([...first.entries()].sort());
    const all = await listPeers(profileId);
    expect(all).toHaveLength(2); // no duplicate rows
  });

  it('returns an empty map for no users', async () => {
    const profileId = await createProfile();
    const map = await preallocatePeers(profileId, []);
    expect(map.size).toBe(0);
  });

  it('partially fills then leaves the overflow for the caller when exhausted', async () => {
    const profileId = await createProfile();
    const u1 = await createUser('alice');
    const u2 = await createUser('bob');
    // /30 has exactly one usable host (.2).
    const map = await preallocatePeers(profileId, [u1, u2], '10.99.0.0/30');
    expect(map.size).toBe(1); // only one user could be placed
    expect([...map.values()]).toEqual(['10.99.0.2']);
  });
});

describe('per device', () => {
  it("gives two devices of one user two addresses on one profile, and the bulk path agrees", async () => {
    const profileId = await createProfile();
    const phone = await createUser('alice');
    const laptop = await prisma.wgDevice.create({
      data: { userId: phone.userId, privateKey: 'k'.repeat(44), publicKey: 'p'.repeat(44) },
    });
    const a = await allocatePeer(profileId, phone);
    const b = await allocatePeer(profileId, { id: laptop.id, userId: phone.userId });
    expect(a.ip).not.toBe(b.ip);
    expect([a.deviceId, b.deviceId]).toEqual([phone.id, laptop.id]);
    expect(a.userId).toBe(b.userId);

    const map = await preallocatePeers(profileId, [phone, { id: laptop.id, userId: phone.userId }]);
    expect(map.get(phone.id)).toBe(a.ip);
    expect(map.get(laptop.id)).toBe(b.ip);
  });
});
