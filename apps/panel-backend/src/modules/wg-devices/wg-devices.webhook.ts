import { prisma } from '../../prisma.js';
import { getLogger } from '../../lib/logger.js';
import { emitRemnaWebhookForUser } from '../remnawave-compat/remnawave.webhook.js';
import { describeWgTunnel } from './wg-devices.presentation.js';
import { servedProfileIds } from './wg-devices.service.js';

/**
 * "A config that had never been used has started being used."
 *
 * Every other channel a buyer holds is announced by the APPLICATION: a client
 * that polls the subscription sends `x-hwid`, the panel mints a device row and
 * the shop tells the buyer about it. wg and AmneziaWG have no such moment - the
 * file is imported once and the client never talks to us again - so nothing
 * downstream would ever hear about a tunnel being taken into use. This is the
 * one place that can hear it, and it can hear it FOR REAL: every tunnel has its
 * own keypair, the node counts its bytes by public key, and a buyer cannot
 * forge somebody else's.
 *
 * Once per KEY, at first use, not per connection. All of a buyer's tunnels are
 * live from the moment they pay - they are minted up front, one per allowed
 * device, and sit on the node whether or not anyone ever imports them. So the
 * event worth a message is not "a device connected" but "a config that was
 * lying idle has been taken up", which is either the buyer setting up a new
 * phone (they see a confirmation) or somebody else holding their file (they see
 * it in time to go and disconnect it).
 *
 * The shop needs nothing new: `user_hwid_devices.added` is the event it already
 * handles for HWID clients, `wg:<id>` is the same opaque identifier its
 * disconnect button already round-trips, and its dedupe fingerprint is
 * `hwid + createdAt` - both stable for a tunnel, so a repeat delivery is
 * swallowed rather than shown twice.
 */
export async function announceFirstWgTunnelUse(deviceIds: string[]): Promise<void> {
  if (deviceIds.length === 0) return;
  try {
    const rows = await prisma.wgDevice.findMany({
      where: { id: { in: deviceIds } },
      select: {
        id: true,
        userId: true,
        createdAt: true,
        peers: { select: { ip: true, profileId: true }, orderBy: { ip: 'asc' } },
      },
    });
    // Narrowed per owner, and resolved once each: a poll folds one node's
    // devices, so these are nearly always all the same person. The tunnel has
    // to be named here exactly as the device list names it - a buyer told about
    // an address they cannot find in their list has been told nothing.
    const servedByUser = new Map<string, ReadonlySet<string>>();
    for (const userId of new Set(rows.map((r) => r.userId))) {
      servedByUser.set(userId, await servedProfileIds(userId));
    }
    for (const d of rows) {
      // Fire-and-forget, through the same semaphore and the same "resolve the
      // user inside the slot" path as every other event this facade sends. A
      // notification must never hold up the stats poll it rides on, and a shop
      // that is down must not cost the panel a tick of accounting.
      emitRemnaWebhookForUser('user_hwid_devices.added', d.userId, {}, {
        hwidUserDevice: describeWgTunnel(d, servedByUser.get(d.userId)),
      });
    }
  } catch (err: unknown) {
    // Announcing is the least important thing happening in this poll. The bytes
    // are already committed; losing the message is a message, losing the tick
    // is everybody's traffic.
    getLogger().warn({ err, deviceIds }, '[wg-devices] could not announce first tunnel use');
  }
}
