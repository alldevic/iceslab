import { prisma } from '../../prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { eventBus } from '../../lib/infra/event-bus.js';
import type { StatsUserEntry } from '../stats/stats.compute.js';

/**
 * Credits one poll's per-peer counters to the WireGuard devices they belong
 * to: lifetime bytes, and lastSeenAt for a device that moved any. A key is a
 * device, so the node's per-peer numbers are the device's numbers; no client
 * is asked who it is.
 *
 * Apart from the user's own accounting and after it: the user's quota, usage
 * and presence come from the entry itself, and nothing about them depends on
 * this write. Delta entries only (AmneziaWG reports per-poll deltas); a core
 * that sent cumulative peers would need a snapshot this does not keep.
 *
 * The first poll in which a device moves bytes is its first use, announced
 * once (wg-devices.first-used): the old lastSeenAt is read under a row lock
 * in the same statement, so two nodes reporting the same device in the same
 * second announce it once. A revoked device is not credited.
 *
 * Returns the devices used for the first time.
 */
export async function creditDeviceTraffic(entries: StatsUserEntry[], now: Date): Promise<string[]> {
  const byKey = new Map<string, { in: number; out: number }>();
  for (const e of entries) {
    if (e.cumulative) continue;
    for (const p of e.peers ?? []) {
      const bi = Math.max(0, p.bytesIn || 0);
      const bo = Math.max(0, p.bytesOut || 0);
      if (bi === 0 && bo === 0) continue;
      const acc = byKey.get(p.publicKey) ?? { in: 0, out: 0 };
      acc.in += bi;
      acc.out += bo;
      byKey.set(p.publicKey, acc);
    }
  }
  if (byKey.size === 0) return [];
  const rows = [...byKey].map(([pk, v]) => Prisma.sql`(${pk}, ${BigInt(v.in)}::bigint, ${BigInt(v.out)}::bigint)`);
  const credited = await prisma.$queryRaw<{ id: string; user_id: string; first: boolean }[]>(Prisma.sql`
    WITH v(pk, bin, bout) AS (VALUES ${Prisma.join(rows)}),
    old AS (
      SELECT d.id, d.last_seen_at FROM wg_devices d JOIN v ON d.public_key = v.pk
      WHERE d.revoked_at IS NULL
      FOR UPDATE OF d
    )
    UPDATE wg_devices d
    SET bytes_in = d.bytes_in + v.bin, bytes_out = d.bytes_out + v.bout, last_seen_at = ${now}
    FROM v, old
    WHERE d.public_key = v.pk AND old.id = d.id
    RETURNING d.id::text AS id, d.user_id::text AS user_id, (old.last_seen_at IS NULL) AS first
  `);
  const first = credited.filter((r) => r.first);
  for (const r of first) eventBus.emit('wg-devices.first-used', { userId: r.user_id, deviceId: r.id });
  return first.map((r) => r.id);
}
