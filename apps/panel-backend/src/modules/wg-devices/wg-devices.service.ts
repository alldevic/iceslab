import { generateWireguardKeyPair, generatePresharedKey } from '../../lib/credentials.js';
import { prisma } from '../../prisma.js';
import { resolveSquadHwidLimit } from '../hwid/hwid.service.js';
import { nodeUsersQueue } from '../users/users.queue.js';
import { eventBus } from '../../lib/event-bus.js';
import type { WgDevice } from '../../generated/prisma/client.js';

/**
 * A buyer's WireGuard devices: one keypair, one address and one config file
 * each.
 *
 * Why a device and not a header. WireGuard tells peers apart by public key and
 * by nothing else, so one keypair per user IS one peer however many phones
 * hold it - the panel cannot count them, cannot cap them, and the server
 * retargets its return path to whichever of them handshaked last (that last
 * one is not a theory: it took the operator's tunnel down on 2026-08-31). HWID
 * answers a different question and answers it on trust: the client states an
 * id when it polls /sub, only some clients state one at all, and a wg client
 * never polls. A device here is a credential, so the count is the node's own
 * peer list and the cap is arithmetic - a device with no key does not connect.
 */

/**
 * Absolute ceiling on devices we will mint for one person, whatever a tariff
 * says. Each device costs a keypair, an address in every wg profile's subnet
 * and a peer on every node the profile is bound to, so a fat-fingered limit
 * would be paid for on the nodes, not in the form that accepted it.
 */
export const MAX_WG_DEVICES = 10;

/**
 * Default when nobody has said otherwise. Devices are PRE-CUT rather than
 * created on demand: the shop renders its install screen from the document our
 * panel hands it, so a fixed set of "Device 1..N" links needs no button and no
 * change to the shop - but it does need a number, and "unlimited" is not one.
 */
export const DEFAULT_WG_DEVICES = 3;

/**
 * How many devices this person gets.
 *
 * `userLimit` is their own `hwidDeviceLimit`; `squadLimits` are their squads'
 * defaults, resolved most-permissive-wins by the same `resolveSquadHwidLimit`
 * the HWID gate uses - one rule, so a person cannot be entitled to four
 * devices by one reading and three by another.
 *
 * NULL at the end of that chain means "no policy", which for HWID means
 * unlimited - and unlimited cannot be pre-cut, so it becomes the default
 * rather than a refusal.
 *
 * BOTH the subscription and the node push have to call this with the same
 * inputs. They ran on different answers once (push topped up to one device,
 * subscription to three): the extra devices got a peer row and an address in
 * the database, the node never heard of them, and the buyer downloaded a
 * second config that handshakes with nothing.
 */
export function resolveWgDeviceCount(
  userLimit: number | null,
  squadLimits: (number | null)[] = [],
  fallback: number = DEFAULT_WG_DEVICES,
): number {
  const limit = userLimit ?? resolveSquadHwidLimit(squadLimits);
  const wanted = limit === null ? fallback : limit;
  return Math.min(Math.max(1, Math.trunc(wanted)), MAX_WG_DEVICES);
}

/** Devices that still have access. Revoked rows stay for their history. */
export async function listActiveDevices(userId: string): Promise<WgDevice[]> {
  return prisma.wgDevice.findMany({
    where: { userId, revokedAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

export async function listDevices(userId: string): Promise<WgDevice[]> {
  return prisma.wgDevice.findMany({ where: { userId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
}

/**
 * Devices with the addresses they hold, for the admin list.
 *
 * Revoked rows are included: their traffic is the reason revocation keeps the
 * row, and an operator asking "what did that phone do before I cut it off"
 * needs to see it. They carry no peers, so the address column is empty for
 * them, which reads correctly.
 */
export async function listDevicesWithPeers(userId: string) {
  return prisma.wgDevice.findMany({
    where: { userId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { peers: { select: { ip: true }, orderBy: { ip: 'asc' } } },
  });
}

/**
 * Bring the user up to `count` active devices, minting keypairs for the
 * missing ones. Returns every active device, oldest first, so the caller can
 * index them stably: device #1 keeps being device #1 across calls, which is
 * what makes "Device 2" on the buyer's install screen mean the same tunnel
 * tomorrow.
 *
 * The order is `(createdAt, id)`, and the id half is load-bearing rather than
 * decorative. Devices minted in one `createMany` share a `created_at` to the
 * millisecond - Postgres stamps the transaction, not the row - so ordering by
 * the timestamp alone leaves their relative position up to the planner.
 * Measured on production right after the first deploy: two devices, one
 * timestamp. A buyer's "Device 2" link would then resolve to a different
 * tunnel from one poll to the next, and the config they imported second would
 * be the one already running on another phone - two devices under one key,
 * which is the exact failure devices exist to prevent.
 *
 * Idempotent and never destructive: a `count` below what the user already has
 * returns the existing set untouched. Taking access away is `revokeDevice`,
 * an explicit act with an explicit audit trail - not a side effect of someone
 * editing a tariff downwards.
 */
export async function ensureDevices(userId: string, count: number): Promise<WgDevice[]> {
  const want = Math.max(1, Math.trunc(count));
  const have = await listActiveDevices(userId);
  if (have.length >= want) return have;

  // Count, then create, UNDER A LOCK. Read-then-write here is the shape that
  // hands a buyer more devices than their limit, and it is not theoretical:
  // revoking one device enqueues a sync per node, the syncs run at once, both
  // read "two live" and both mint the third. Measured 2026-09-02 on a service
  // account - two devices created in the same millisecond, four live against a
  // limit of three.
  //
  // The damage is not the extra row. Each sync pushes the peer set IT computed,
  // so the device minted by the other one is on that node and missing from this
  // one: the panel then hands out a config whose key exists on the exit and not
  // on the ENTRY, and the buyer's tunnel handshakes with nothing. That is the
  // "deleted a device, downloaded the config again, will not connect" report.
  //
  // Same instrument the HWID gate already uses for the same reason
  // (`pg_advisory_xact_lock` in hwid.service.ts): a per-user lock, held for the
  // transaction, so concurrent top-ups queue instead of racing. Per USER rather
  // than global - two different buyers have nothing to serialize.
  const created = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
    // Re-read inside the lock: the value read before it is exactly what the
    // loser of the race was acting on.
    const fresh = await tx.wgDevice.count({ where: { userId, revokedAt: null } });
    const missing = want - fresh;
    if (missing <= 0) return 0;
    const rows = Array.from({ length: missing }, () => {
      const kp = generateWireguardKeyPair();
      return {
        userId,
        privateKey: kp.privateKey,
        publicKey: kp.publicKey,
        presharedKey: generatePresharedKey(),
      };
    });
    await tx.wgDevice.createMany({ data: rows });
    return rows.length;
  });
  if (created === 0) return listActiveDevices(userId);
  // A minted device is a keypair the node has never heard of.
  //
  // The peer row and its address are written by whoever asked for the device -
  // the subscription render allocates one per binding - so the panel is
  // immediately able to hand out a complete, correct .conf. The NODE is not:
  // peers reach it only through an inbound sync, and nothing here used to order
  // one. So the buyer downloaded a valid config carrying a key that existed
  // nowhere on the machine, and the handshake failed silently and permanently -
  // the periodic re-push only fires on a node status flip, so nothing healed it
  // until an unrelated edit.
  //
  // Reported from live use as "deleted a device, downloaded the config again,
  // it will not connect", and reproduced on 2026-09-02 with a service account:
  // the replacement device had addresses in the panel and its public key was on
  // neither wg0 nor awg0.
  //
  // This is the same failure inbounds.events.ts already describes for
  // user.created - "a valid .conf with a key the node does not have" - closed
  // there for the user lifecycle and left open for the device lifecycle.
  eventBus.emit('wg-devices.changed', { userId, reason: `${created} device(s) minted` });
  return listActiveDevices(userId);
}

/**
 * `ensureDevices` for many users in two queries instead of two per user.
 *
 * The node push calls this for every active user on every sync, so the
 * per-user shape was ~2N round-trips on a path the rest of this module already
 * bulk-loads (see preallocatePeers). Returns userId -> devices, oldest first,
 * for every user asked about.
 */
export async function ensureDevicesForUsers(
  wanted: { userId: string; count: number }[],
): Promise<Map<string, WgDevice[]>> {
  const byUser = new Map<string, WgDevice[]>();
  if (wanted.length === 0) return byUser;
  const userIds = wanted.map((w) => w.userId);
  // Per user, because the count is a per-user policy: one person's tariff
  // gives three devices and the next one's five, and a single `count` for the
  // batch would quietly hand somebody the wrong number.
  const wantByUser = new Map(wanted.map((w) => [w.userId, Math.max(1, Math.trunc(w.count))]));

  const existing = await prisma.wgDevice.findMany({
    where: { userId: { in: userIds }, revokedAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  // Devices created before the column exists have no preshared key. Fill them
  // here rather than in the migration: a profile that turns preshared keys on
  // must find every one of its peers holding a key, or the buyer whose device
  // predates the column is the only one whose tunnel silently refuses to
  // handshake. Idempotent - a device is backfilled once and never again.
  const needKey = existing.filter((d) => !d.presharedKey);
  if (needKey.length > 0) {
    await Promise.all(
      needKey.map((d) =>
        prisma.wgDevice.update({
          where: { id: d.id },
          data: { presharedKey: generatePresharedKey() },
        }),
      ),
    );
  }

  for (const id of userIds) byUser.set(id, []);
  for (const d of existing) byUser.get(d.userId)?.push(d);

  const toCreate: {
    userId: string;
    privateKey: string;
    publicKey: string;
    presharedKey: string;
  }[] = [];
  for (const id of userIds) {
    const missing = (wantByUser.get(id) ?? 1) - (byUser.get(id)?.length ?? 0);
    for (let i = 0; i < missing; i += 1) {
      const kp = generateWireguardKeyPair();
      toCreate.push({
        userId: id,
        privateKey: kp.privateKey,
        publicKey: kp.publicKey,
        presharedKey: generatePresharedKey(),
      });
    }
  }
  if (toCreate.length === 0 && needKey.length === 0) return byUser;

  if (toCreate.length > 0) {
    // Under the same per-user lock as ensureDevices, and re-counted inside it.
    // This is the path that actually raced: revoking a device enqueues one sync
    // per node, and each sync calls this for the whole active set. Both read the
    // same "two live" and both minted a third, so one node got a device the
    // other had never heard of.
    //
    // One transaction over the batch, taking each user's lock in a stable order
    // (the ids are already sorted by the caller's query): locks acquired in a
    // fixed order cannot deadlock against another batch doing the same.
    await prisma.$transaction(async (tx) => {
      const byUserToCreate = new Map<string, typeof toCreate>();
      for (const row of toCreate) {
        const list = byUserToCreate.get(row.userId) ?? [];
        list.push(row);
        byUserToCreate.set(row.userId, list);
      }
      const finalRows: typeof toCreate = [];
      for (const id of [...byUserToCreate.keys()].sort()) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
        const fresh = await tx.wgDevice.count({ where: { userId: id, revokedAt: null } });
        const missing = (wantByUser.get(id) ?? 1) - fresh;
        // Whatever this batch prepared, only the shortfall that still exists
        // under the lock gets written. The loser of a race writes nothing.
        finalRows.push(...(byUserToCreate.get(id) ?? []).slice(0, Math.max(0, missing)));
      }
      if (finalRows.length > 0) await tx.wgDevice.createMany({ data: finalRows });
    });
  }
  const refreshed = await prisma.wgDevice.findMany({
    where: { userId: { in: userIds }, revokedAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  for (const id of userIds) byUser.set(id, []);
  for (const d of refreshed) byUser.get(d.userId)?.push(d);
  return byUser;
}

/**
 * Drop a device's access while keeping the row.
 *
 * Deleting instead would cascade its peers away, and freeing that IP hands it
 * to the next device allocated - at which point the revoked config is a
 * WORKING config again, for somebody else's tunnel. Revocation has to be a
 * tombstone.
 *
 * The removal is pushed to the nodes here too, and it has to be: the agent
 * keeps its own peer map and never re-reads ours, so a device dropped only in
 * the database keeps working until something unrelated triggers a full
 * re-push. `removeUser` is addressed by the id the peer was pushed under -
 * the DEVICE id - which is exactly why devices are keyed separately from
 * their owner: revoking one must not reach into the user's xray or hysteria
 * access.
 */
/**
 * The device with this id IF it belongs to this user and still has access.
 *
 * Exists because `revokeDevice` is addressed by device id alone and is shared
 * with the admin path, where the caller is trusted with every user. On the
 * buyer-facing path the id arrives from their own browser, so the owner has to
 * be established before anything is revoked - not after, which would revoke
 * first and discover the theft second.
 *
 * Already-revoked reads as absent: revoking twice is a no-op worth reporting
 * as "nothing happened" rather than as success.
 */
export async function findDeviceForUser(
  deviceId: string,
  userId: string,
): Promise<WgDevice | null> {
  return prisma.wgDevice.findFirst({ where: { id: deviceId, userId, revokedAt: null } });
}

export async function revokeDevice(deviceId: string): Promise<WgDevice | null> {
  const device = await prisma.wgDevice.findUnique({ where: { id: deviceId } });
  if (!device || device.revokedAt) return device;
  const [updated] = await prisma.$transaction([
    prisma.wgDevice.update({ where: { id: deviceId }, data: { revokedAt: new Date() } }),
    prisma.amneziawgPeer.deleteMany({ where: { deviceId } }),
  ]);
  await nodeUsersQueue.add('removeUser', { userId: deviceId });
  // `removeUser` names the node one device id, which is enough when it lands.
  // The sync is ordered as well because only it reconciles the whole set
  // (`/retainUsers`), so a revoke that raced a push in flight cannot leave the
  // peer behind - the same reason user.deleted orders one.
  eventBus.emit('wg-devices.changed', { userId: device.userId, reason: 'device revoked' });
  return updated;
}
