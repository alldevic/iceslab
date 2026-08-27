import { prisma } from '../prisma.js';
import { nodesGauge, usersGauge } from './metrics.js';

/**
 * Periodically refresh the live gauges (nodes/users by status). We do
 * NOT compute these on every /metrics scrape because Prometheus default
 * scrape interval is 15s and the DB queries are cheap-but-not-free; a
 * fixed 30s loop keeps the gauges sub-minute fresh at one DB roundtrip
 * per minute instead of one per scrape across N scrapers.
 *
 * Slice 33.
 */
const REFRESH_INTERVAL_MS = 30_000;

export async function refreshOnce(): Promise<void> {
  // Reset before set: a previously-seen status that no longer has any
  // rows would otherwise stay at its last value forever.
  nodesGauge.reset();
  usersGauge.reset();

  const nodeStatuses = await prisma.node.groupBy({
    by: ['status'],
    where: { deletedAt: null },
    _count: { _all: true },
  });
  for (const row of nodeStatuses) {
    nodesGauge.set({ status: row.status }, row._count._all);
  }

  // `deletedAt: null` for the same reason the node query ten lines up has it,
  // and it was missing here: deletion is SOFT, and a soft-deleted user keeps
  // whatever `status` it had, so without the filter `iceslab_users{status=...}`
  // counts every user ever deleted, forever, under the status they were deleted
  // in. The panel's own dashboard filters (dashboard.service.ts), so the two
  // surfaces answered "how many users are there" differently - and the one an
  // operator alerts on was the wrong one.
  const userStatuses = await prisma.user.groupBy({
    by: ['status'],
    where: { deletedAt: null },
    _count: { _all: true },
  });
  for (const row of userStatuses) {
    usersGauge.set({ status: row.status }, row._count._all);
  }
}

export function startMetricsRefreshLoop(): () => void {
  let stopped = false;
  const tick = async (): Promise<void> => {
    try {
      await refreshOnce();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[metrics-refresh] tick failed: ${msg}`);
    }
    if (!stopped) {
      setTimeout(() => void tick(), REFRESH_INTERVAL_MS);
    }
  };
  void tick();
  return () => {
    stopped = true;
  };
}
