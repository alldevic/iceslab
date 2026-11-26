import { prisma } from '../../prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { eventBus } from '../../lib/infra/event-bus.js';
import type { StatsUserEntry } from '../stats/stats.compute.js';

/**
 * Credits one poll's per-peer counters to the WireGuard devices they belong
 * to (milestone 9.6): lifetime bytes, and lastSeenAt from the peer's latest
 * handshake. A key is a device, so the node's per-peer numbers are the
 * device's numbers; no client is asked who it is, and a key the panel does
 * not know (a peer an older push left on the node) joins to nothing and is
 * ignored.
 *
 * Apart from the user's own accounting and after it: the user's quota, usage
 * and presence come from the entry itself, and nothing about them depends on
 * this write. Delta entries only: the agent's AmneziaWG and WireGuard cores
 * restart a peer's delta from the current value when the interface's counters
 * reset, so a reset is counted once there; a cumulative entry would need a
 * snapshot this does not keep and is skipped, as is an older agent's entry
 * without `peers`.
 *
 * The same device may be reported by several entries (two nodes, or both
 * interfaces of one): bytes add, the handshake is the latest. lastSeenAt only
 * moves forward (a poll that finds no handshake, such as after the interface
 * was recreated, leaves it), and never past `now`. A revoked device is not
 * credited.
 *
 * The first use of a device is lastSeenAt going from null to a time. It is
 * claimed in the same statement as the credit: the old value is read under a
 * row lock, so two polls folding the same device at once (it lives on every
 * WireGuard node) cannot both see null. wg-devices.first-used is emitted once
 * the statement has committed, one per device.
 */
export async function creditDeviceTraffic(entries: StatsUserEntry[], now: Date): Promise<number> {
  const byKey = new Map<string, { in: number; out: number; seen: number }>();
  for (const e of entries) {
    if (e.cumulative) continue;
    for (const p of e.peers ?? []) {
      const bi = Math.max(0, p.bytesIn || 0);
      const bo = Math.max(0, p.bytesOut || 0);
      const seen = Math.min(Math.max(0, p.lastHandshake || 0), Math.floor(now.getTime() / 1000));
      if (bi === 0 && bo === 0 && seen === 0) continue;
      const acc = byKey.get(p.publicKey) ?? { in: 0, out: 0, seen: 0 };
      acc.in += bi;
      acc.out += bo;
      acc.seen = Math.max(acc.seen, seen);
      byKey.set(p.publicKey, acc);
    }
  }
  if (byKey.size === 0) return 0;
  // Sorted by key so two polls crediting overlapping devices lock rows in one order.
  const rows = [...byKey].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(
    ([pk, v]) =>
      Prisma.sql`(${pk}, ${BigInt(v.in)}::bigint, ${BigInt(v.out)}::bigint, ${v.seen > 0 ? new Date(v.seen * 1000) : null}::timestamptz)`,
  );
  const credited = await prisma.$queryRaw<{ id: string; user_id: string; first: boolean }[]>(Prisma.sql`
    WITH v(pk, bin, bout, seen) AS (VALUES ${Prisma.join(rows)}),
    old AS (
      SELECT d.id, d.last_seen_at FROM wg_devices d JOIN v ON d.public_key = v.pk
      WHERE d.revoked_at IS NULL
      ORDER BY d.public_key
      FOR UPDATE OF d
    )
    UPDATE wg_devices d
    SET bytes_in = d.bytes_in + v.bin,
        bytes_out = d.bytes_out + v.bout,
        last_seen_at = GREATEST(d.last_seen_at, v.seen)
    FROM v, old
    WHERE d.public_key = v.pk AND old.id = d.id
    RETURNING d.id::text AS id, d.user_id::text AS user_id,
              (old.last_seen_at IS NULL AND d.last_seen_at IS NOT NULL) AS first
  `);
  for (const r of credited) if (r.first) eventBus.emit('wg-devices.first-used', { userId: r.user_id, deviceId: r.id });
  return credited.length;
}
