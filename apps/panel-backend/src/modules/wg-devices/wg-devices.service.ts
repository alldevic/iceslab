import { prisma } from '../../prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { WgDevice } from '../../generated/prisma/client.js';
import { generateWireguardKeyPair } from '../../lib/auth/credentials.js';
import { effectiveHwidLimit } from '../hwid/hwid.service.js';

/**
 * WireGuard devices: a keypair per client of a user (wg_devices), milestone 9.4.
 *
 * Every client of a user used to hold the same key, so a second client took the
 * endpoint over from the first without a word. Now a user holds a few devices,
 * each with its own key and its own address on every WireGuard-family profile
 * (AmneziaWG 1.x and 3.1, plain WireGuard); the user's peer on a node is one
 * record under the user's id carrying one entry per device (awg-addresses.ts).
 *
 * Devices are issued up front, to the user's count, when the panel first needs
 * them: a subscription render or a push to a node (ensureDevices). Order is
 * (createdAt, id): device 1 is the oldest live one, and for a user from before
 * devices it is their old keypair. Revoking, listing and traffic per device are
 * milestone 9.6; a revoked row is already left out of everything here.
 */

/** No user gets more than this many, whatever their device limit says. */
export const MAX_WG_DEVICES = 10;
/** The count without a device limit (none set, or explicitly unlimited). */
export const DEFAULT_WG_DEVICES = 3;

/**
 * How many devices a user holds: their device limit (the user's own, else
 * their squads', by the one rule the HWID gate uses), within [1, MAX_WG_DEVICES];
 * DEFAULT_WG_DEVICES when there is none. A user's `0` is the explicit "no
 * limit" and so gives the default: unlimited cannot be issued up front. The
 * subscription and the push both read it, so they cannot disagree. Pure.
 */
export function wgDeviceCount(userLimit: number | null, squadLimits: (number | null)[]): number {
  const limit = effectiveHwidLimit(userLimit, squadLimits);
  if (limit === null) return DEFAULT_WG_DEVICES;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_WG_DEVICES);
}

export type WgDeviceRow = WgDevice;

const ORDER = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];

/** Users per query: a roster of tens of thousands would run past Postgres's
 *  bind-parameter cap in one `in` list. */
const CHUNK = 2000;

/** A user's live devices, device 1 first. The id breaks ties. */
export async function listActiveDevices(userId: string): Promise<WgDeviceRow[]> {
  return prisma.wgDevice.findMany({ where: { userId, revokedAt: null }, orderBy: ORDER });
}

/** The live device `deviceId` if `userId` owns it, else null. */
export async function findDeviceForUser(deviceId: string, userId: string): Promise<WgDeviceRow | null> {
  return prisma.wgDevice.findFirst({ where: { id: deviceId, userId, revokedAt: null } });
}

/**
 * Tops the user up to `count` live devices and returns them, device 1 first,
 * with how many it issued. Never takes one away: a lower count later leaves the
 * extra devices working. Idempotent and serialised per user (an advisory lock,
 * counted again inside it): two renders of one subscription at once would
 * otherwise both see a shortfall and both fill it.
 *
 * A user with no device gets the one their own key makes (users.amneziawg_*):
 * device 1 of a user created after the migration is the keypair the user row
 * holds, as it is for the ones the migration seeded, so what a single-key agent
 * is told stays the same key.
 */
export async function ensureDevices(
  userId: string,
  count: number,
): Promise<{ devices: WgDeviceRow[]; issued: number }> {
  const want = Math.min(Math.max(Math.trunc(count), 1), MAX_WG_DEVICES);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${'wg-devices:' + userId}))`);
    const live = await tx.wgDevice.findMany({ where: { userId, revokedAt: null }, orderBy: ORDER });
    const missing = Math.max(0, want - live.length);
    if (missing === 0) return { devices: live, issued: 0 };

    const rows: { userId: string; privateKey: string; publicKey: string; createdAt: Date }[] = [];
    // Distinct, increasing stamps: one createMany is one transaction time, and
    // the order of devices issued together must be the order they were issued.
    const t0 = Date.now();
    for (let i = 0; i < missing; i++) {
      let keys: { privateKey: string; publicKey: string } | null = null;
      if (live.length === 0 && i === 0) {
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { amneziawgPrivateKey: true, amneziawgPublicKey: true },
        });
        if (user && user.amneziawgPublicKey && !(await tx.wgDevice.findUnique({ where: { publicKey: user.amneziawgPublicKey } }))) {
          keys = { privateKey: user.amneziawgPrivateKey, publicKey: user.amneziawgPublicKey };
        }
      }
      keys ??= generateWireguardKeyPair();
      rows.push({ userId, ...keys, createdAt: new Date(t0 + i) });
    }
    await tx.wgDevice.createMany({ data: rows });
    const devices = await tx.wgDevice.findMany({ where: { userId, revokedAt: null }, orderBy: ORDER });
    return { devices, issued: missing };
  });
}

/**
 * ensureDevices for many users, for the node push: the count of each from their
 * own limit and their squads' (the same wgDeviceCount the subscription reads),
 * the devices of the whole set in a query per chunk, and a locked top-up only
 * for the users who are short. Returns userId -> live devices, device 1 first,
 * for every user asked about, and the ids of the users who were issued some.
 */
export async function ensureDevicesForUsers(
  userIds: string[],
): Promise<{ devices: Map<string, WgDeviceRow[]>; issuedTo: string[] }> {
  const devices = new Map<string, WgDeviceRow[]>();
  const issuedTo: string[] = [];
  for (let i = 0; i < userIds.length; i += CHUNK) {
    const ids = userIds.slice(i, i + CHUNK);
    const [users, live] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, hwidDeviceLimit: true, groupMembers: { select: { group: { select: { hwidDeviceLimit: true } } } } },
      }),
      prisma.wgDevice.findMany({ where: { userId: { in: ids }, revokedAt: null }, orderBy: ORDER }),
    ]);
    for (const id of ids) devices.set(id, []);
    for (const d of live) devices.get(d.userId)?.push(d);
    for (const u of users) {
      const want = wgDeviceCount(u.hwidDeviceLimit, u.groupMembers.map((m) => m.group.hwidDeviceLimit));
      if ((devices.get(u.id)?.length ?? 0) >= want) continue;
      const res = await ensureDevices(u.id, want);
      devices.set(u.id, res.devices);
      if (res.issued > 0) issuedTo.push(u.id);
    }
  }
  return { devices, issuedTo };
}

/**
 * The credentials of a user, issued again (A-053): the first live device takes
 * the new pair the user row got (so the user's key and device 1 stay one), every
 * other live device gets a fresh pair of its own. Rows, numbers and addresses
 * stay: the user holds as many devices as before. Revoked devices are left as
 * they are. Nothing to do for a user with no device yet; the next ensureDevices
 * seeds device 1 from the user's new key.
 */
export async function reissueDevices(
  userId: string,
  first: { privateKey: string; publicKey: string },
): Promise<number> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${'wg-devices:' + userId}))`);
    const live = await tx.wgDevice.findMany({ where: { userId, revokedAt: null }, orderBy: ORDER });
    for (const [i, d] of live.entries()) {
      const keys = i === 0 ? first : generateWireguardKeyPair();
      await tx.wgDevice.update({ where: { id: d.id }, data: { privateKey: keys.privateKey, publicKey: keys.publicKey } });
    }
    return live.length;
  });
}
