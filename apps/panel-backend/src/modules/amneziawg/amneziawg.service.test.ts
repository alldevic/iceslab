import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { generateUserCredentials, generateWireguardKeyPair } from '../../lib/auth/credentials.js';
import {
  DEFAULT_SUBNET,
  IpExhaustedError,
  allocatePeer,
  getPeer,
  listPeers,
  preallocatePeers,
  releasePeer,
  type PeerDevice,
} from './amneziawg.service.js';

// Slice 27: peer allocation is keyed on profileId (the logical AmneziaWG
// inbound), not the per-node Inbound row. Tests now seed Profile rows.

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

// A user with their device 1: what the allocator places.
async function createUser(username: string): Promise<PeerDevice> {
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

async function addDevice(userId: string): Promise<PeerDevice> {
  const keys = generateWireguardKeyPair();
  const d = await prisma.wgDevice.create({ data: { userId, privateKey: keys.privateKey, publicKey: keys.publicKey } });
  return { id: d.id, userId };
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

  it("gives each device of one user an address of its own, and device 1 keeps the one it had", async () => {
    const profileId = await createProfile();
    const d1 = await createUser('alice');
    const first = await allocatePeer(profileId, d1); // .2
    const d2 = await addDevice(d1.userId);
    const d3 = await addDevice(d1.userId);

    const second = await allocatePeer(profileId, d2);
    const third = await allocatePeer(profileId, d3);
    expect([first.ip, second.ip, third.ip]).toEqual(['10.66.66.2', '10.66.66.3', '10.66.66.4']);
    expect(second.userId).toBe(d1.userId);
    expect((await allocatePeer(profileId, d1)).ip).toBe('10.66.66.2');
    // The one address per (profile, device) is a database rule, not a habit.
    await expect(
      prisma.amneziawgPeer.create({ data: { profileId, userId: d2.userId, deviceId: d2.id, ip: '10.66.66.99' } }),
    ).rejects.toThrow();
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

  it('places every device of a user, each at its own address', async () => {
    const profileId = await createProfile();
    const d1 = await createUser('alice');
    const d2 = await addDevice(d1.userId);
    const map = await preallocatePeers(profileId, [d1, d2]);
    expect(new Set([map.get(d1.id), map.get(d2.id)])).toEqual(new Set(['10.66.66.2', '10.66.66.3']));
    expect(await listPeers(profileId)).toHaveLength(2);
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
