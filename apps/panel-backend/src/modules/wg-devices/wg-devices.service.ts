import { prisma } from '../../prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { eventBus } from '../../lib/infra/event-bus.js';
import { generatePresharedKey, generateWireguardKeyPair } from '../../lib/auth/credentials.js';
import { effectiveHwidLimit } from '../hwid/hwid.service.js';

/**
 * WireGuard devices: a keypair per client of a user (wg_devices).
 *
 * Every client of a user used to hold the same key, so a second client took
 * the endpoint over from the first without a word, and revoking one client
 * meant revoking them all. Now a user holds a few devices, each with its own
 * key, preshared key and address on every AmneziaWG profile; the user's peer
 * on a node carries one entry per device (awg-addresses.ts).
 *
 * Devices are issued when a subscription is rendered (ensureDevices), up to
 * the user's count; a revoked one is replaced on the next render, never
 * brought back. Order is (createdAt, id): device 1 is the oldest live one.
 */

/** No user gets more than this many, whatever their device limit says. */
export const MAX_WG_DEVICES = 10;
/** The count without a device limit (none set, or explicitly unlimited). */
export const DEFAULT_WG_DEVICES = 3;

/**
 * How many devices a user holds: their device limit (A-148: their own, else
 * their squads'), within [1, MAX_WG_DEVICES]; DEFAULT_WG_DEVICES when there
 * is none. The subscription and the node push read it through ensureDevices
 * alone, so the two cannot disagree. Pure.
 */
export function wgDeviceCount(userLimit: number | null, squadLimits: (number | null)[]): number {
  const limit = effectiveHwidLimit(userLimit, squadLimits);
  if (limit === null) return DEFAULT_WG_DEVICES;
  return Math.min(Math.max(limit, 1), MAX_WG_DEVICES);
}

/** What the rest of the panel reads of a device: never the private key. */
export interface WgDeviceRow {
  id: string;
  userId: string;
  label: string | null;
  privateKey: string;
  publicKey: string;
  presharedKey: string | null;
  createdAt: Date;
  revokedAt: Date | null;
  bytesIn: bigint;
  bytesOut: bigint;
  lastSeenAt: Date | null;
}

const ORDER = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];

/** A user's live devices, device 1 first. The id breaks ties: one batch of
 *  devices shares a timestamp. */
export async function listActiveDevices(userId: string): Promise<WgDeviceRow[]> {
  return prisma.wgDevice.findMany({ where: { userId, revokedAt: null }, orderBy: ORDER });
}

/** Live devices of many users at once, each list device 1 first. */
export async function activeDevicesOf(userIds: string[]): Promise<Map<string, WgDeviceRow[]>> {
  const out = new Map<string, WgDeviceRow[]>();
  if (userIds.length === 0) return out;
  const rows = await prisma.wgDevice.findMany({
    where: { userId: { in: userIds }, revokedAt: null },
    orderBy: ORDER,
  });
  for (const r of rows) {
    const list = out.get(r.userId);
    if (list) list.push(r);
    else out.set(r.userId, [r]);
  }
  return out;
}

/** Every device of a user, revoked ones included, with its addresses. */
export async function listDevicesWithPeers(userId: string) {
  return prisma.wgDevice.findMany({
    where: { userId },
    orderBy: ORDER,
    include: { peers: { select: { ip: true, profileId: true }, orderBy: { ip: 'asc' } } },
  });
}

function newDevice(userId: string) {
  const keys = generateWireguardKeyPair();
  return { userId, privateKey: keys.privateKey, publicKey: keys.publicKey, presharedKey: generatePresharedKey() };
}

/**
 * Tops the user up to `count` live devices and returns them, device 1 first.
 * Never takes one away: a lower count later leaves the extra devices working
 * until someone revokes them. Devices from before preshared keys get theirs.
 *
 * Serialised per user (an advisory lock, counted again inside it): two
 * renders of one subscription at once would otherwise both see a shortfall
 * and both fill it. Anything issued or filled in is announced, and the user's
 * peers on the nodes follow.
 */
export async function ensureDevices(userId: string, count: number): Promise<WgDeviceRow[]> {
  const { devices, changed } = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${'wg-devices:' + userId}))`);
    const live = await tx.wgDevice.findMany({ where: { userId, revokedAt: null }, orderBy: ORDER });
    let changed = false;
    const unkeyed = live.filter((d) => d.presharedKey === null);
    for (const d of unkeyed) {
      await tx.wgDevice.update({ where: { id: d.id }, data: { presharedKey: generatePresharedKey() } });
      changed = true;
    }
    const missing = Math.max(0, count - live.length);
    if (missing > 0) {
      await tx.wgDevice.createMany({ data: Array.from({ length: missing }, () => newDevice(userId)) });
      changed = true;
    }
    const devices = changed
      ? await tx.wgDevice.findMany({ where: { userId, revokedAt: null }, orderBy: ORDER })
      : live;
    return { devices, changed };
  });
  if (changed) eventBus.emit('wg-devices.changed', { userId, reason: 'issued' });
  return devices;
}

/** The live device `deviceId` if `userId` owns it, else null. */
export async function findDeviceForUser(deviceId: string, userId: string): Promise<WgDeviceRow | null> {
  return prisma.wgDevice.findFirst({ where: { id: deviceId, userId, revokedAt: null } });
}

/**
 * Revokes a device: the row stays (with its traffic), its addresses go, and
 * its peer comes off every node with the user's next push. The next render of
 * the subscription issues a replacement. Null for no such device; an already
 * revoked one is returned unchanged.
 */
export async function revokeDevice(
  deviceId: string,
  reason: 'revoked' | 'forgotten' = 'revoked',
): Promise<WgDeviceRow | null> {
  const result = await prisma.$transaction(async (tx) => {
    const row = await tx.wgDevice.findUnique({ where: { id: deviceId } });
    if (!row || row.revokedAt) return { row, revoked: false };
    const updated = await tx.wgDevice.update({ where: { id: deviceId }, data: { revokedAt: new Date() } });
    // The address may be handed out again: the key it belonged to is gone
    // from every node with this push, so an old config cannot use it.
    await tx.amneziawgPeer.deleteMany({ where: { deviceId } });
    return { row: updated, revoked: true };
  });
  if (result.revoked && result.row) eventBus.emit('wg-devices.changed', { userId: result.row.userId, reason });
  return result.row;
}
