import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { eventBus } from '../../lib/infra/event-bus.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { generateUserCredentials } from '../../lib/auth/credentials.js';
import {
  DEFAULT_WG_DEVICES,
  MAX_WG_DEVICES,
  ensureDevices,
  findDeviceForUser,
  listActiveDevices,
  revokeDevice,
  wgDeviceCount,
} from './wg-devices.service.js';
import { creditDeviceTraffic } from './wg-devices.stats.js';

async function createUser(username: string): Promise<string> {
  const c = generateUserCredentials();
  const user = await prisma.user.create({
    data: {
      username,
      shortId: c.shortId,
      subscriptionToken: c.subscriptionToken,
      hysteriaPassword: c.hysteriaPassword,
      naivePassword: c.naivePassword,
      xrayUuid: c.xrayUuid,
      amneziawgPrivateKey: c.amneziawgPrivateKey,
      amneziawgPublicKey: c.amneziawgPublicKey,
    },
  });
  return user.id;
}

const events: { name: string; payload: unknown }[] = [];
eventBus.on('wg-devices.changed', (payload) => void events.push({ name: 'wg-devices.changed', payload }));
eventBus.on('wg-devices.first-used', (payload) => void events.push({ name: 'wg-devices.first-used', payload }));
/** The bus runs handlers a tick later: what was announced, once it has run. */
const announced = async () => {
  await new Promise((r) => setImmediate(r));
  return events;
};

beforeEach(async () => {
  await cleanDatabase();
  await announced();
  events.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('wgDeviceCount: the device limit, as a number of keys', () => {
  it('no limit anywhere, or an explicit no-limit (A-148): the default', () => {
    expect(wgDeviceCount(null, [])).toBe(DEFAULT_WG_DEVICES);
    expect(wgDeviceCount(null, [null, null])).toBe(DEFAULT_WG_DEVICES);
    expect(wgDeviceCount(0, [5])).toBe(DEFAULT_WG_DEVICES);
  });
  it("the user's own limit wins over the squads', the most permissive squad over the rest", () => {
    expect(wgDeviceCount(2, [5])).toBe(2);
    expect(wgDeviceCount(null, [2, 4, null])).toBe(4);
  });
  it('never past the ceiling', () => {
    expect(wgDeviceCount(50, [])).toBe(MAX_WG_DEVICES);
  });
});

describe('ensureDevices', () => {
  it('issues distinct keypairs and preshared keys, device 1 first, and says so', async () => {
    const u = await createUser('alice');
    const devices = await ensureDevices(u, 3);
    expect(devices).toHaveLength(3);
    expect(new Set(devices.map((d) => d.publicKey)).size).toBe(3);
    expect(new Set(devices.map((d) => d.privateKey)).size).toBe(3);
    for (const d of devices) {
      expect(d.presharedKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
      expect(d.publicKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    }
    expect(await announced()).toEqual([{ name: 'wg-devices.changed', payload: { userId: u, reason: 'issued' } }]);
  });

  it('is idempotent, keeps the order, and stays quiet when nothing was missing', async () => {
    const u = await createUser('alice');
    const first = await ensureDevices(u, 3);
    await announced();
    events.length = 0;
    const again = await ensureDevices(u, 3);
    expect(again.map((d) => d.id)).toEqual(first.map((d) => d.id));
    expect(await announced()).toEqual([]);
    // One batch shares a timestamp: the id breaks the tie, the same every time.
    expect((await listActiveDevices(u)).map((d) => d.id)).toEqual(first.map((d) => d.id));
  });

  it('never takes a device away when asked for fewer', async () => {
    const u = await createUser('alice');
    await ensureDevices(u, 3);
    expect(await ensureDevices(u, 1)).toHaveLength(3);
  });

  it('issues the shortfall once when two renders top up at the same moment', async () => {
    const u = await createUser('alice');
    await Promise.all([ensureDevices(u, 3), ensureDevices(u, 3), ensureDevices(u, 3)]);
    expect(await prisma.wgDevice.count({ where: { userId: u } })).toBe(3);
  });

  it('keeps users apart', async () => {
    const a = await createUser('alice');
    const b = await createUser('bob');
    await Promise.all([ensureDevices(a, 2), ensureDevices(b, 3)]);
    expect(await prisma.wgDevice.count({ where: { userId: a } })).toBe(2);
    expect(await prisma.wgDevice.count({ where: { userId: b } })).toBe(3);
  });

  it('replaces a revoked device with a new one, never the revoked one', async () => {
    const u = await createUser('alice');
    const [d1, d2, d3] = await ensureDevices(u, 3);
    await revokeDevice(d2!.id);
    const after = await ensureDevices(u, 3);
    expect(after).toHaveLength(3);
    expect(after.map((d) => d.id).slice(0, 2)).toEqual([d1!.id, d3!.id]);
    expect(after.map((d) => d.id)).not.toContain(d2!.id);
  });

  it('gives a device from before preshared keys its own (the migrated device 1)', async () => {
    const u = await createUser('alice');
    const old = await prisma.wgDevice.create({ data: { userId: u, privateKey: 'a'.repeat(44), publicKey: 'b'.repeat(44) } });
    const [d1] = await ensureDevices(u, 1);
    expect(d1!.id).toBe(old.id);
    expect(d1!.presharedKey).toBeTruthy();
    expect((await announced()).map((e) => e.name)).toEqual(['wg-devices.changed']);
  });
});

describe('revokeDevice', () => {
  it('keeps the row and its traffic, drops its addresses, and names the owner', async () => {
    const u = await createUser('alice');
    const [d] = await ensureDevices(u, 1);
    const profile = await prisma.profile.create({ data: { name: 'awg', protocol: 'amneziawg', config: {} } });
    await prisma.amneziawgPeer.create({ data: { profileId: profile.id, userId: u, deviceId: d!.id, ip: '10.66.66.2' } });
    await prisma.wgDevice.update({ where: { id: d!.id }, data: { bytesIn: 123n } });
    await announced();
    events.length = 0;

    const r = await revokeDevice(d!.id);
    expect(r?.revokedAt).toBeInstanceOf(Date);
    const row = await prisma.wgDevice.findUniqueOrThrow({ where: { id: d!.id } });
    expect(row.bytesIn).toBe(123n);
    expect(await prisma.amneziawgPeer.count({ where: { deviceId: d!.id } })).toBe(0);
    expect(await announced()).toEqual([{ name: 'wg-devices.changed', payload: { userId: u, reason: 'revoked' } }]);
    expect(await findDeviceForUser(d!.id, u)).toBeNull();
  });

  it('a second revoke changes nothing and says nothing; no such device is null', async () => {
    const u = await createUser('alice');
    const [d] = await ensureDevices(u, 1);
    await revokeDevice(d!.id);
    await announced();
    events.length = 0;
    const again = await revokeDevice(d!.id);
    expect(again?.id).toBe(d!.id);
    expect(await announced()).toEqual([]);
    expect(await revokeDevice('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it("findDeviceForUser: someone else's device is not theirs", async () => {
    const a = await createUser('alice');
    const b = await createUser('bob');
    const [d] = await ensureDevices(a, 1);
    expect((await findDeviceForUser(d!.id, a))?.id).toBe(d!.id);
    expect(await findDeviceForUser(d!.id, b)).toBeNull();
  });
});

describe('creditDeviceTraffic', () => {
  const now = new Date('2026-10-28T10:00:00Z');

  it("credits each device its own share and announces its first use once", async () => {
    const u = await createUser('alice');
    const [d1, d2] = await ensureDevices(u, 2);
    await announced();
    events.length = 0;
    const first = await creditDeviceTraffic(
      [
        {
          userId: u,
          bytesIn: 150,
          bytesOut: 15,
          peers: [
            { publicKey: d1!.publicKey, bytesIn: 100, bytesOut: 10 },
            { publicKey: d2!.publicKey, bytesIn: 0, bytesOut: 0 },
          ],
        },
        // A second node reporting the same device in the same poll.
        { userId: u, bytesIn: 50, bytesOut: 5, peers: [{ publicKey: d1!.publicKey, bytesIn: 50, bytesOut: 5 }] },
      ],
      now,
    );
    expect(first).toEqual([d1!.id]);
    const [r1, r2] = await Promise.all([
      prisma.wgDevice.findUniqueOrThrow({ where: { id: d1!.id } }),
      prisma.wgDevice.findUniqueOrThrow({ where: { id: d2!.id } }),
    ]);
    expect([r1.bytesIn, r1.bytesOut, r1.lastSeenAt?.toISOString()]).toEqual([150n, 15n, now.toISOString()]);
    // A device that moved nothing is not seen: a handshake is not use.
    expect([r2.bytesIn, r2.lastSeenAt]).toEqual([0n, null]);
    expect(await announced()).toEqual([{ name: 'wg-devices.first-used', payload: { userId: u, deviceId: d1!.id } }]);

    await announced();
    events.length = 0;
    expect(await creditDeviceTraffic([{ userId: u, peers: [{ publicKey: d1!.publicKey, bytesIn: 1, bytesOut: 1 }] }], now)).toEqual([]);
    expect(await announced()).toEqual([]);
  });

  it('two nodes crediting the same new device at once announce it once', async () => {
    const u = await createUser('alice');
    const [d] = await ensureDevices(u, 1);
    await announced();
    events.length = 0;
    const entry = { userId: u, peers: [{ publicKey: d!.publicKey, bytesIn: 10, bytesOut: 1 }] };
    const [a, b] = await Promise.all([creditDeviceTraffic([entry], now), creditDeviceTraffic([entry], now)]);
    expect([...a, ...b]).toEqual([d!.id]);
    expect((await prisma.wgDevice.findUniqueOrThrow({ where: { id: d!.id } })).bytesIn).toBe(20n);
  });

  it('leaves a revoked device, an unknown key and a cumulative entry alone', async () => {
    const u = await createUser('alice');
    const [d1, d2] = await ensureDevices(u, 2);
    await revokeDevice(d1!.id);
    const out = await creditDeviceTraffic(
      [
        { userId: u, peers: [{ publicKey: d1!.publicKey, bytesIn: 10, bytesOut: 1 }, { publicKey: 'unknown', bytesIn: 9, bytesOut: 9 }] },
        { userId: u, cumulative: true, peers: [{ publicKey: d2!.publicKey, bytesIn: 10, bytesOut: 1 }] },
      ],
      now,
    );
    expect(out).toEqual([]);
    const rows = await prisma.wgDevice.findMany({ where: { userId: u }, select: { bytesIn: true } });
    expect(rows.every((r) => r.bytesIn === 0n)).toBe(true);
  });
});
