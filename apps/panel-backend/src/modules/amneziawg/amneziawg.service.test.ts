import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { generateUserCredentials } from '../../lib/credentials.js';
import {
  DEFAULT_SUBNET,
  IpExhaustedError,
  allocatePeer,
  getPeer,
  listPeers,
  preallocatePeers,
  releasePeer,
} from './amneziawg.service.js';
import { ensureDevices } from '../wg-devices/wg-devices.service.js';

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

// Slice 51: an allocation belongs to a DEVICE, so a fixture user is not a
// subject on its own - it needs the device that carries the keypair. Returned
// together because every call below needs both: the device is what the address
// is keyed on, the user is what its traffic is billed to.
interface Subject {
  userId: string;
  deviceId: string;
}

async function createUser(username: string): Promise<Subject> {
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
  const [device] = await ensureDevices(user.id, 1);
  return { userId: user.id, deviceId: device!.id };
}

/** A second device for the same person - two peers, one owner. */
async function addDevice(subject: Subject): Promise<Subject> {
  const devices = await ensureDevices(subject.userId, 2);
  return { userId: subject.userId, deviceId: devices[1]!.id };
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

    const a = await allocatePeer(profileId, u1.deviceId, u1.userId);
    const b = await allocatePeer(profileId, u2.deviceId, u2.userId);

    expect(a.ip).toBe('10.66.66.2');
    expect(b.ip).toBe('10.66.66.3');
  });

  it('is idempotent for the same (profile, user)', async () => {
    const profileId = await createProfile();
    const u = await createUser('alice');

    const a = await allocatePeer(profileId, u.deviceId, u.userId);
    const b = await allocatePeer(profileId, u.deviceId, u.userId);

    expect(a.id).toBe(b.id);
    expect(a.ip).toBe(b.ip);
  });

  it('reuses gaps after a release', async () => {
    const profileId = await createProfile();
    const u1 = await createUser('alice');
    const u2 = await createUser('bob');
    const u3 = await createUser('carol');

    await allocatePeer(profileId, u1.deviceId, u1.userId); // .2
    const peer2 = await allocatePeer(profileId, u2.deviceId, u2.userId); // .3
    expect(peer2.ip).toBe('10.66.66.3');

    await releasePeer(profileId, u2.userId);
    const peer3 = await allocatePeer(profileId, u3.deviceId, u3.userId);
    expect(peer3.ip).toBe('10.66.66.3');
  });

  it('isolates allocations per profile', async () => {
    const p1 = await createProfile('awg-a');
    const p2 = await createProfile('awg-b');
    const u = await createUser('alice');

    const a1 = await allocatePeer(p1, u.deviceId, u.userId);
    const a2 = await allocatePeer(p2, u.deviceId, u.userId);

    expect(a1.ip).toBe('10.66.66.2');
    expect(a2.ip).toBe('10.66.66.2');
  });

  it('respects a custom subnet', async () => {
    const profileId = await createProfile();
    const u = await createUser('alice');

    const p = await allocatePeer(profileId, u.deviceId, u.userId, '172.16.0.0/24');
    expect(p.ip).toBe('172.16.0.2');
  });

  it('throws IpExhaustedError when the range is full', async () => {
    const profileId = await createProfile();
    // /30 has 4 addresses, .0 net + .1 server + .3 broadcast → exactly one usable (.2)
    const u1 = await createUser('alice');
    const u2 = await createUser('bob');

    await allocatePeer(profileId, u1.deviceId, u1.userId, '10.99.0.0/30');
    await expect(
      allocatePeer(profileId, u2.deviceId, u2.userId, '10.99.0.0/30'),
    ).rejects.toBeInstanceOf(IpExhaustedError);
  });
});

describe('getPeer / listPeers / releasePeer', () => {
  it('returns null when no allocation exists', async () => {
    const profileId = await createProfile();
    const u = await createUser('alice');
    expect(await getPeer(profileId, u.deviceId)).toBeNull();
  });

  it('lists peers in IP order', async () => {
    const profileId = await createProfile();
    const u1 = await createUser('alice');
    const u2 = await createUser('bob');
    const u3 = await createUser('carol');

    await allocatePeer(profileId, u2.deviceId, u2.userId);
    await allocatePeer(profileId, u1.deviceId, u1.userId);
    await allocatePeer(profileId, u3.deviceId, u3.userId);

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
    const existing = await allocatePeer(profileId, u1.deviceId, u1.userId); // takes .2

    const map = await preallocatePeers(profileId, [u1, u2]);
    expect(map.get(u1.deviceId)).toBe(existing.ip); // unchanged
    expect(map.get(u2.deviceId)).toBe('10.66.66.3'); // next free
  });

  it('reuses a gap left by a release', async () => {
    const profileId = await createProfile();
    const u1 = await createUser('alice');
    const u2 = await createUser('bob');
    const u3 = await createUser('carol');
    await allocatePeer(profileId, u1.deviceId, u1.userId); // .2
    await allocatePeer(profileId, u2.deviceId, u2.userId); // .3
    await releasePeer(profileId, u1.userId); // frees .2

    const map = await preallocatePeers(profileId, [u3]);
    expect(map.get(u3.deviceId)).toBe('10.66.66.2'); // lowest free reused
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

  it('gives two devices of ONE person two different addresses', async () => {
    // The reason the key moved off the user: WireGuard tells peers apart by
    // public key, so two devices sharing one address would be one peer, and
    // the server would send the return path to whichever handshaked last.
    const profileId = await createProfile();
    const first = await createUser('alice');
    const second = await addDevice(first);

    const map = await preallocatePeers(profileId, [first, second]);
    expect(map.size).toBe(2);
    expect(new Set(map.values()).size).toBe(2);
    const all = await listPeers(profileId);
    expect(all.map((p) => p.userId)).toEqual([first.userId, first.userId]);
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
