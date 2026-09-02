import { prisma } from '../../prisma.js';
import type { StatsUserEntry } from '../stats/stats.compute.js';
import { announceFirstWgTunnelUse } from './wg-devices.webhook.js';

/**
 * Fold the wg device records a node reports back onto the people who own them.
 *
 * The node keys its peer map on whatever string the panel sent, and since
 * slice 51 that string is a DEVICE id for wg peers. Its stats call therefore
 * answers with a mix: real user ids from xray/hysteria/sing-box, device ids
 * from wireguard/amneziawg. Everything downstream - snapshots, per-poll
 * deltas, quota, the "top users" card - is keyed on the user, so the device
 * ids have to be resolved here or that traffic is billed to nobody.
 *
 * Two things happen in one pass, because both need the same lookup:
 *
 *   1. the device's own counters are accumulated (this is the accounting the
 *      whole per-device split exists for);
 *   2. the entry is rewritten to the owner, and entries that now share an
 *      owner are MERGED. Two devices of one person on one node would otherwise
 *      arrive as two rows with the same userId, and the snapshot upsert below
 *      is keyed on (nodeId, userId) - the second row would overwrite the first
 *      rather than add to it.
 *
 * wg entries are per-poll deltas (the agent diffs the kernel counters itself),
 * so accumulating is a plain increment. Entries whose id matches no device are
 * passed through untouched: that is every non-wg protocol, and it is the
 * common case.
 *
 * And a third thing happens for the few devices moving bytes for the FIRST
 * time: `lastSeenAt` going from null to a date is the only observation the
 * panel ever gets that a wg config has been taken into use, so that transition
 * is claimed here and announced. See `announceFirstWgTunnelUse`.
 */
export async function foldDeviceStats(entries: StatsUserEntry[]): Promise<StatsUserEntry[]> {
  if (entries.length === 0) return entries;

  const ids = entries.map((e) => e.userId);
  const devices = await prisma.wgDevice.findMany({
    where: { id: { in: ids } },
    // `lastSeenAt` is read, not only written: the first-use announcement below
    // needs to know which of these devices had never moved a byte before this
    // poll, and an `updateMany` cannot say what it overwrote.
    select: { id: true, userId: true, lastSeenAt: true },
  });
  if (devices.length === 0) return entries;
  const ownerByDevice = new Map(devices.map((d) => [d.id, d.userId]));
  const neverSeen = new Set(devices.filter((d) => d.lastSeenAt === null).map((d) => d.id));

  const moved: { deviceId: string; bytesIn: number; bytesOut: number }[] = [];
  const merged = new Map<string, StatsUserEntry>();

  for (const e of entries) {
    const owner = ownerByDevice.get(e.userId);
    if (owner) {
      const bytesIn = e.bytesIn || 0;
      const bytesOut = e.bytesOut || 0;
      if (bytesIn > 0 || bytesOut > 0) {
        moved.push({ deviceId: e.userId, bytesIn, bytesOut });
      }
    }
    const key = owner ?? e.userId;
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { ...e, userId: key });
      continue;
    }
    // Merging is only sound between entries of the same counter mode: a
    // cumulative reading and a per-poll delta are different quantities. wg is
    // always delta and a user's own entry may be cumulative, so keep them
    // apart by preferring the cumulative flag of whichever came first and
    // summing only within it. In practice a user never has both on one node -
    // the wg entries carry no cumulative flag and neither does the user's own
    // wg-less record - but the sum must not quietly assume that.
    if ((prev.cumulative ?? false) !== (e.cumulative ?? false)) {
      // Different modes: keep them separate by leaving the later one under a
      // key that cannot collide. Downstream sums per user anyway.
      merged.set(`${key}#${merged.size}`, { ...e, userId: key });
      continue;
    }
    prev.bytesIn = (prev.bytesIn || 0) + (e.bytesIn || 0);
    prev.bytesOut = (prev.bytesOut || 0) + (e.bytesOut || 0);
  }

  if (moved.length > 0) {
    const now = new Date();
    // The devices this poll could be the first use of. Read as never-seen above
    // and moving bytes now - the claim below decides which of them it really is.
    const firstUse = moved.map((m) => m.deviceId).filter((id) => neverSeen.has(id));
    // updateMany, not update: `update` throws P2025 when the row is gone, and
    // a device revoked between the read above and this write would then fail
    // the whole node's stats poll - losing every other user's bytes for that
    // tick over one deleted row. A vanished device simply matches nothing.
    const results = await prisma.$transaction([
      // CLAIM first, and inside the same transaction as the accounting.
      //
      // A buyer's tunnel exists on every wg-bearing node, each node polls on
      // its own schedule, and the polls are folded by whichever worker picks
      // them up - so two of these run against one device at the same time as a
      // matter of course, not as a rare race. `lastSeenAt IS NULL` in the WHERE
      // makes the claim the exclusive thing it has to be: the second statement
      // blocks on the row, re-evaluates the condition against the committed
      // version, matches nothing and reports `count: 0`. Exactly one caller is
      // told it was the first, which is what "announce once per key" needs.
      //
      // `revokedAt: null` because a revoked tunnel whose peer has not left the
      // node yet can still move bytes, and "a new device connected" about
      // access the buyer already cancelled is worse than silence. The bytes are
      // still counted below; only the message is withheld.
      ...firstUse.map((id) =>
        prisma.wgDevice.updateMany({
          where: { id, lastSeenAt: null, revokedAt: null },
          data: { lastSeenAt: now },
        }),
      ),
      ...moved.map((m) =>
        prisma.wgDevice.updateMany({
          where: { id: m.deviceId },
          data: {
            bytesIn: { increment: BigInt(m.bytesIn) },
            bytesOut: { increment: BigInt(m.bytesOut) },
            lastSeenAt: now,
          },
        }),
      ),
    ]);
    // AFTER the commit: the claim is what makes the announcement single, so it
    // has to be a fact before anything is sent. Awaited rather than left to
    // float so a poll cannot outrun its own notifications in tests or in a
    // shutdown; the emitter itself does not wait for the shop.
    const claimed = firstUse.filter((_, i) => (results[i]?.count ?? 0) > 0);
    await announceFirstWgTunnelUse(claimed);
  }

  return [...merged.values()];
}
