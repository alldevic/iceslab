import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { generateUserCredentials } from '../../lib/auth/credentials.js';
import {
  DEFAULT_WG_DEVICES,
  MAX_WG_DEVICES,
  ensureDevices,
  ensureDevicesForUsers,
  findDeviceForUser,
  listActiveDevices,
  reissueDevices,
  wgDeviceCount,
} from './wg-devices.service.js';

async function createUser(username: string, hwidDeviceLimit: number | null = null) {
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
      hwidDeviceLimit,
    },
  });
  return { id: user.id, privateKey: creds.amneziawgPrivateKey, publicKey: creds.amneziawgPublicKey };
}

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('wgDeviceCount', () => {
  it('is 3 with no limit anywhere', () => {
    expect(wgDeviceCount(null, [])).toBe(DEFAULT_WG_DEVICES);
    expect(wgDeviceCount(null, [null, null])).toBe(3);
  });

  it("is 3 for the user's explicit 0 (no limit), even over a squad's limit", () => {
    expect(wgDeviceCount(0, [])).toBe(3);
    expect(wgDeviceCount(0, [5])).toBe(3);
  });

  it("is the user's own limit, inside 1..10", () => {
    expect(wgDeviceCount(1, [])).toBe(1);
    expect(wgDeviceCount(2, [8])).toBe(2);
    expect(wgDeviceCount(7, [])).toBe(7);
    expect(wgDeviceCount(50, [])).toBe(MAX_WG_DEVICES);
  });

  it("is the squads' limit (the most permissive) when the user has none", () => {
    expect(wgDeviceCount(null, [2])).toBe(2);
    expect(wgDeviceCount(null, [2, 5, null])).toBe(5);
    expect(wgDeviceCount(null, [40])).toBe(MAX_WG_DEVICES);
  });
});

describe('ensureDevices', () => {
  it("issues up to the count, device 1 being the user's own key", async () => {
    const u = await createUser('alice');
    const { devices, issued } = await ensureDevices(u.id, 3);
    expect(issued).toBe(3);
    expect(devices).toHaveLength(3);
    expect(devices[0]!.publicKey).toBe(u.publicKey);
    expect(devices[0]!.privateKey).toBe(u.privateKey);
    expect(new Set(devices.map((d) => d.publicKey)).size).toBe(3);
    expect(new Set(devices.map((d) => d.privateKey)).size).toBe(3);
  });

  it('is idempotent: a second call issues nothing and returns the same order', async () => {
    const u = await createUser('alice');
    const a = await ensureDevices(u.id, 3);
    const b = await ensureDevices(u.id, 3);
    expect(b.issued).toBe(0);
    expect(b.devices.map((d) => d.id)).toEqual(a.devices.map((d) => d.id));
    expect(await prisma.wgDevice.count({ where: { userId: u.id } })).toBe(3);
  });

  it('does not issue extra devices under parallel calls', async () => {
    const u = await createUser('alice');
    await Promise.all(Array.from({ length: 8 }, () => ensureDevices(u.id, 3)));
    expect(await prisma.wgDevice.count({ where: { userId: u.id } })).toBe(3);
  });

  it('never takes a device away when the count falls, and tops up when it rises', async () => {
    const u = await createUser('alice');
    await ensureDevices(u.id, 5);
    expect((await ensureDevices(u.id, 2)).devices).toHaveLength(5);
    expect((await ensureDevices(u.id, 7)).devices).toHaveLength(7);
  });

  it('keeps the numbers: issued later is numbered later', async () => {
    const u = await createUser('alice');
    const first = (await ensureDevices(u.id, 2)).devices.map((d) => d.id);
    const more = (await ensureDevices(u.id, 4)).devices.map((d) => d.id);
    expect(more.slice(0, 2)).toEqual(first);
  });

  it('leaves a revoked device out of the live ones and does not bring it back', async () => {
    const u = await createUser('alice');
    const { devices } = await ensureDevices(u.id, 3);
    await prisma.wgDevice.update({ where: { id: devices[1]!.id }, data: { revokedAt: new Date() } });
    const live = await listActiveDevices(u.id);
    expect(live.map((d) => d.id)).toEqual([devices[0]!.id, devices[2]!.id]);
    const again = await ensureDevices(u.id, 3);
    expect(again.issued).toBe(1);
    expect(again.devices).toHaveLength(3);
    expect(again.devices.map((d) => d.id)).not.toContain(devices[1]!.id);
    expect((await prisma.wgDevice.findUnique({ where: { id: devices[1]!.id } }))!.revokedAt).not.toBeNull();
  });

  it("gives a user whose key is already a device's a fresh pair instead", async () => {
    const a = await createUser('alice');
    const b = await createUser('bob');
    await prisma.user.update({ where: { id: b.id }, data: { amneziawgPublicKey: a.publicKey, amneziawgPrivateKey: a.privateKey } });
    await ensureDevices(a.id, 1);
    const { devices } = await ensureDevices(b.id, 1);
    expect(devices).toHaveLength(1);
    expect(devices[0]!.publicKey).not.toBe(a.publicKey);
  });
});

describe('ensureDevicesForUsers (the push)', () => {
  it("reads each user's count from their own limit and their squads'", async () => {
    const plain = await createUser('plain');
    const two = await createUser('two', 2);
    const unlimited = await createUser('unlimited', 0);
    const inSquad = await createUser('squad');
    const squad = await prisma.group.create({ data: { name: 'five', hwidDeviceLimit: 5 } });
    await prisma.groupMember.create({ data: { groupId: squad.id, userId: inSquad.id } });

    const { devices, issuedTo } = await ensureDevicesForUsers([plain.id, two.id, unlimited.id, inSquad.id]);
    expect(devices.get(plain.id)).toHaveLength(3);
    expect(devices.get(two.id)).toHaveLength(2);
    expect(devices.get(unlimited.id)).toHaveLength(3);
    expect(devices.get(inSquad.id)).toHaveLength(5);
    expect(issuedTo.sort()).toEqual([plain.id, two.id, unlimited.id, inSquad.id].sort());

    const again = await ensureDevicesForUsers([plain.id, two.id]);
    expect(again.issuedTo).toEqual([]);
    expect(again.devices.get(two.id)!.map((d) => d.id)).toEqual(devices.get(two.id)!.map((d) => d.id));
  });

  it('is the number the subscription would issue (one function)', async () => {
    const u = await createUser('alice', 4);
    const viaPush = (await ensureDevicesForUsers([u.id])).devices.get(u.id)!;
    const viaSub = (await ensureDevices(u.id, wgDeviceCount(4, []))).devices;
    expect(viaSub.map((d) => d.id)).toEqual(viaPush.map((d) => d.id));
  });
});

describe('findDeviceForUser', () => {
  it("finds a live device of that user and nobody else's", async () => {
    const a = await createUser('alice');
    const b = await createUser('bob');
    const { devices } = await ensureDevices(a.id, 2);
    expect((await findDeviceForUser(devices[1]!.id, a.id))?.id).toBe(devices[1]!.id);
    expect(await findDeviceForUser(devices[1]!.id, b.id)).toBeNull();
    await prisma.wgDevice.update({ where: { id: devices[1]!.id }, data: { revokedAt: new Date() } });
    expect(await findDeviceForUser(devices[1]!.id, a.id)).toBeNull();
  });
});

describe('reissueDevices', () => {
  it('gives every live device a new pair, device 1 the one passed, and keeps their number and addresses', async () => {
    const u = await createUser('alice');
    const before = (await ensureDevices(u.id, 3)).devices;
    const profile = await prisma.profile.create({ data: { name: 'p', protocol: 'amneziawg', config: {} } });
    await prisma.amneziawgPeer.create({ data: { profileId: profile.id, userId: u.id, deviceId: before[1]!.id, ip: '10.66.66.5' } });
    const fresh = generateUserCredentials();

    expect(await reissueDevices(u.id, { privateKey: fresh.amneziawgPrivateKey, publicKey: fresh.amneziawgPublicKey })).toBe(3);

    const after = await listActiveDevices(u.id);
    expect(after.map((d) => d.id)).toEqual(before.map((d) => d.id));
    expect(after[0]!.publicKey).toBe(fresh.amneziawgPublicKey);
    for (const [i, d] of after.entries()) {
      expect(d.publicKey).not.toBe(before[i]!.publicKey);
      expect(d.privateKey).not.toBe(before[i]!.privateKey);
    }
    expect(new Set(after.map((d) => d.publicKey)).size).toBe(3);
    expect((await prisma.amneziawgPeer.findFirst({ where: { deviceId: before[1]!.id } }))!.ip).toBe('10.66.66.5');
  });
});

describe('a preshared key per device (9.5)', () => {
  const isKey = (k: string | null) => !!k && /^[A-Za-z0-9+/]{43}=$/.test(k);

  it('is issued with every device, device 1 included, and differs from device to device', async () => {
    const u = await createUser('psk_a');
    const { devices } = await ensureDevices(u.id, 3);
    expect(devices.every((d) => isKey(d.presharedKey))).toBe(true);
    expect(new Set(devices.map((d) => d.presharedKey)).size).toBe(3);
    // Not the keypair's halves.
    for (const d of devices) expect([d.privateKey, d.publicKey]).not.toContain(d.presharedKey);
  });

  it('is kept by later reads and by topping the user up', async () => {
    const u = await createUser('psk_b');
    const first = (await ensureDevices(u.id, 2)).devices;
    const again = (await ensureDevices(u.id, 3)).devices;
    expect(again.slice(0, 2).map((d) => d.presharedKey)).toEqual(first.map((d) => d.presharedKey));
    expect(isKey(again[2]!.presharedKey)).toBe(true);
    const viaPush = await ensureDevicesForUsers([u.id]);
    expect(viaPush.devices.get(u.id)!.map((d) => d.presharedKey)).toEqual(again.map((d) => d.presharedKey));
  });

  it('is given to a device from before the column on the first read, once, by both entrances', async () => {
    const a = await createUser('psk_old_a', 1);
    const b = await createUser('psk_old_b', 1);
    for (const u of [a, b]) {
      await prisma.wgDevice.create({ data: { userId: u.id, privateKey: u.privateKey, publicKey: u.publicKey } });
    }
    expect((await prisma.wgDevice.findMany()).every((d) => d.presharedKey === null)).toBe(true);

    const viaPush = await ensureDevicesForUsers([a.id, b.id]);
    const keyA = viaPush.devices.get(a.id)![0]!.presharedKey;
    expect(isKey(keyA)).toBe(true);
    expect(keyA).not.toBe(viaPush.devices.get(b.id)![0]!.presharedKey);
    expect(viaPush.issuedTo).not.toContain(a.id); // a key is not an issued device: no rollout for it

    const viaSub = await ensureDevices(a.id, 1);
    expect(viaSub.devices[0]!.presharedKey).toBe(keyA);
    expect((await prisma.wgDevice.findFirstOrThrow({ where: { userId: a.id } })).presharedKey).toBe(keyA);
  });

  it('two readers at once leave one key', async () => {
    const u = await createUser('psk_race', 1);
    await prisma.wgDevice.create({ data: { userId: u.id, privateKey: u.privateKey, publicKey: u.publicKey } });
    const [x, y] = await Promise.all([ensureDevicesForUsers([u.id]), ensureDevicesForUsers([u.id])]);
    const stored = (await prisma.wgDevice.findFirstOrThrow({ where: { userId: u.id } })).presharedKey;
    expect(isKey(stored)).toBe(true);
    // Whatever each saw, what is stored is what every later read sees.
    expect((await ensureDevices(u.id, 1)).devices[0]!.presharedKey).toBe(stored);
    void x; void y;
  });

  it('is rotated with the pair when the credentials are reissued', async () => {
    const u = await createUser('psk_reissue');
    const before = (await ensureDevices(u.id, 2)).devices.map((d) => d.presharedKey);
    await reissueDevices(u.id, { privateKey: 'newpriv', publicKey: 'newpub' });
    const after = (await listActiveDevices(u.id)).map((d) => d.presharedKey);
    expect(after).toHaveLength(2);
    for (const [i, k] of after.entries()) {
      expect(isKey(k)).toBe(true);
      expect(k).not.toBe(before[i]);
    }
  });
});
