import { prisma } from '../../prisma.js';
import { eventBus } from '../../lib/event-bus.js';
import { notifyTelegramAsync, escapeMarkdown } from '../../lib/telegram-notify.js';
import { nodeUsersQueue } from './users.queue.js';

type ResetStrategy = 'day' | 'week' | 'month';

const ROLLING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Reset usedTrafficBytes for active users with the given strategy.
 * Returns the count of users whose traffic was reset.
 */
export async function resetTrafficForStrategy(strategy: ResetStrategy): Promise<number> {
  const users = await prisma.user.findMany({
    where: { trafficLimitStrategy: strategy, deletedAt: null },
    select: { id: true, traffic: { select: { usedTrafficBytes: true } } },
  });

  if (users.length === 0) return 0;

  await prisma.userTraffic.updateMany({
    where: { userId: { in: users.map((u) => u.id) } },
    data: { usedTrafficBytes: 0n, lastTrafficResetAt: new Date() },
  });

  for (const u of users) {
    eventBus.emit('user.traffic-reset', {
      userId: u.id,
      previousUsedBytes: u.traffic?.usedTrafficBytes ?? 0n,
    });
  }
  return users.length;
}

/**
 * Reset traffic for rolling-30d users whose lastTrafficResetAt is >30d ago (or never).
 * Cross-table + null logic → raw SQL.
 */
export async function resetTrafficRolling(): Promise<number> {
  const cutoff = new Date(Date.now() - ROLLING_WINDOW_MS);

  const rows = await prisma.$queryRaw<
    { id: string; previous_used: bigint | null }[]
  >`
    SELECT u.id::text AS id, ut.used_traffic_bytes AS previous_used
    FROM users u
    LEFT JOIN user_traffic ut ON u.id = ut.user_id
    WHERE u.traffic_limit_strategy = 'rolling'
      AND u.deleted_at IS NULL
      AND (ut.last_traffic_reset_at IS NULL OR ut.last_traffic_reset_at < ${cutoff})
  `;

  if (rows.length === 0) return 0;

  await prisma.userTraffic.updateMany({
    where: { userId: { in: rows.map((r) => r.id) } },
    data: { usedTrafficBytes: 0n, lastTrafficResetAt: new Date() },
  });

  for (const r of rows) {
    eventBus.emit('user.traffic-reset', {
      userId: r.id,
      previousUsedBytes: r.previous_used ?? 0n,
    });
  }
  return rows.length;
}

/**
 * Find users whose expire_at has passed and flip them to 'expired'.
 * Emits user.status-changed → handler chain enqueues removeUser job.
 *
 * 'limited' counts as due, not only 'active'. A period subscriber who burned
 * their quota before the term ran out sits in 'limited' with expireAt still
 * ahead; when that date arrives an active-only predicate never sees them, so
 * the row stays 'limited' forever - on the panel it reads as a live subscriber
 * who is merely over quota, and under the Remnawave-compat facade the
 * `user.expired` webhook (which fires off this very transition) is never
 * emitted for them. The shop's own always-on worker compensates, but only the
 * shop's; the panel's own view of who is still a subscriber does not.
 * 'disabled' stays excluded: that is an operator decision, not a lapse, and
 * expiring it would overwrite the reason the operator set it.
 *
 * Selecting 'limited' puts this cron in a race it did not have before, so the
 * flip is one statement rather than select-then-update. The traffic-reset
 * handler lifts limited → active (see users.events.ts); with a separate read
 * and write, a reset landing between them would resurrect a user this pass had
 * already expired. Here the CTE takes the row locks, the UPDATE happens in the
 * same transaction, and RETURNING says exactly which rows moved and what they
 * moved from - so no event is emitted for a user who was not flipped.
 *
 * SKIP LOCKED, not a wait: a row locked right now is one another transaction is
 * mid-write on, and the likeliest such write is the renewal that is about to
 * push expireAt into the future. Skipping means the next tick re-reads it
 * instead of expiring a subscriber who just paid.
 */
export async function findExpiredUsers(): Promise<number> {
  // updated_at is set explicitly: @updatedAt is a Prisma-client behaviour and
  // does not apply to raw SQL, and reconcileOrphanNodeUsers finds its orphans
  // through exactly that column.
  const rows = await prisma.$queryRaw<{ id: string; previous_status: string }[]>`
    WITH due AS (
      SELECT id, status
      FROM users
      WHERE expire_at < now()
        AND status IN ('active', 'limited')
        AND deleted_at IS NULL
      FOR UPDATE SKIP LOCKED
    )
    UPDATE users u
       SET status = 'expired', updated_at = now()
      FROM due
     WHERE u.id = due.id
    RETURNING u.id::text AS id, due.status AS previous_status
  `;

  if (rows.length === 0) return 0;

  const ids = rows.map((r) => r.id);

  // #4 - the DB status is already 'expired' before this enqueue. syncRemoveUser
  // status-gates (it skips removal for a still-active row), so a removeUser job
  // that ran while the user was still 'active' would skip and strand them on
  // every node. reconcileOrphanNodeUsers is the crash backstop if the process
  // dies between the flip and the enqueue.
  //
  // No dedup jobId on the expiry path: a user transitions to expired exactly
  // once (after the flip later ticks don't re-select them), so there is no
  // repeated-enqueue load to dedup. removeUser is idempotent node-side, so an
  // occasional duplicate (reconcile also enqueues) is harmless.
  // B11: one addBulk instead of N awaited add()s, a 1000-user expiry batch
  // was 1000 sequential Redis round-trips; addBulk pipelines them.
  await nodeUsersQueue.addBulk(
    ids.map((id) => ({ name: 'removeUser', data: { userId: id } })),
  );

  // Event handlers still fire (Telegram alerts, audit log, the facade's
  // `user.expired` webhook) but they no longer carry the sync invariant,
  // that's covered by the direct enqueue above.
  for (const row of rows) {
    eventBus.emit('user.status-changed', {
      userId: row.id,
      from: row.previous_status,
      to: 'expired',
    });
  }
  return ids.length;
}

/**
 * Find active users whose used traffic >= traffic_limit_bytes; flip to 'limited'.
 * Cross-column comparison → raw SQL.
 */
export async function findExceededTrafficUsers(): Promise<number> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT u.id::text AS id
    FROM users u
    JOIN user_traffic ut ON u.id = ut.user_id
    WHERE u.status = 'active'
      AND u.deleted_at IS NULL
      AND u.traffic_limit_bytes IS NOT NULL
      AND ut.used_traffic_bytes >= u.traffic_limit_bytes
  `;

  if (rows.length === 0) return 0;

  const ids = rows.map((r) => r.id);

  // #4 - flip THEN enqueue (see findExpiredUsers): syncRemoveUser status-gates,
  // so the row must be 'limited' before the removeUser job runs or it would
  // skip a still-active user. reconcile is the crash backstop. No dedup jobId
  // (one-time transition); removeUser is idempotent node-side. B11: addBulk.
  await prisma.user.updateMany({
    where: { id: { in: ids } },
    data: { status: 'limited' },
  });
  await nodeUsersQueue.addBulk(
    ids.map((id) => ({ name: 'removeUser', data: { userId: id } })),
  );

  for (const id of ids) {
    eventBus.emit('user.status-changed', { userId: id, from: 'active', to: 'limited' });
  }
  return ids.length;
}

/**
 * Reconcile orphan node-state: find users who SHOULD NOT live on any node
 * (status in expired/limited/disabled, or soft-deleted) that were flipped
 * RECENTLY but long enough ago that the primary removeUser job has had
 * a chance to retry-exhaust, and re-enqueue removeUser for each.
 *
 * Window tuning is intentional:
 *   - `gte: now - 24h` (not 30d): a tight window means a fleet of 1000
 *     limited users produces ~1000 idempotent re-queues over 24h, not
 *     ~4M over 30d. Older orphans are assumed already-removed; if not,
 *     the next status-flip / admin action bumps updatedAt back into the
 *     window.
 *   - `lte: now - 15min`: skip users flipped in the last 15 minutes,
 *     their primary removeUser job (enqueued by findExpired /
 *     findExceededTrafficUsers BEFORE the status update) is still
 *     within its retry budget (3 attempts × exponential backoff = ~7s
 *     in practice, but the worker may be backlogged).
 *
 * removeUser is idempotent on the node side, so over-enqueuing is
 * harmless beyond load. With the windowing above, expected steady-state
 * is ~N/144 jobs/tick where N = orphans flipped in last 24h.
 */
export async function reconcileOrphanNodeUsers(): Promise<number> {
  const now = Date.now();
  const lowerBound = new Date(now - 24 * 60 * 60 * 1000);     // last 24h
  const upperBound = new Date(now - 15 * 60 * 1000);          // skip last 15min
  const orphans = await prisma.user.findMany({
    where: {
      updatedAt: { gte: lowerBound, lte: upperBound },
      OR: [
        { status: { in: ['expired', 'limited', 'disabled'] } },
        { deletedAt: { not: null } },
      ],
    },
    select: { id: true },
  });

  if (orphans.length === 0) return 0;

  // Wave-14 #12: cron fires every ~10min so a stable orphan would be
  // enqueued ~144 times/day per userId, each triggering a full mTLS fanout
  // across every node. Daily-bucket jobId dedupes within a 24h window
  // (matches the reconcile window above) but lets re-enqueue happen next
  // day if the original failed and aged out. Picked daily over hourly to
  // bound recovery latency at <=24h while keeping the cron self-healing.
  const dayBucket = Math.floor(now / 86_400_000);
  // B11: addBulk keeps the per-orphan day-bucket jobId (dedup) while
  // collapsing N round-trips into one pipelined call.
  await nodeUsersQueue.addBulk(
    orphans.map((u) => ({
      name: 'removeUser',
      data: { userId: u.id },
      opts: { jobId: `removeUser-${u.id}-d${dayBucket}` },
    })),
  );
  return orphans.length;
}

// K3-tail - proactive near-expiry / near-cap alerts, as a once-daily digest
// (not per-user spam, so no dedup state is needed). Sent to the operator's
// Telegram (no-op when Telegram isn't configured).
const NEAR_EXPIRY_DAYS = 3;
const NEAR_CAP_PERCENT = 90;

/** Build the digest message (pure + testable). Null = nothing to report. */
export function formatNearLimitsDigest(
  expiring: { username: string; expireAt: Date | null }[],
  nearCap: { username: string; pct: number }[],
): string | null {
  if (expiring.length === 0 && nearCap.length === 0) return null;
  const lines: string[] = ['*Iceslab daily digest*'];
  if (expiring.length > 0) {
    lines.push(`*Expiring soon (<= ${NEAR_EXPIRY_DAYS}d):*`);
    for (const u of expiring) {
      const when = u.expireAt ? u.expireAt.toISOString().slice(0, 10) : '?';
      lines.push(`- ${escapeMarkdown(u.username)}: ${when}`);
    }
  }
  if (nearCap.length > 0) {
    lines.push(`*Near traffic cap (>= ${NEAR_CAP_PERCENT}%):*`);
    for (const u of nearCap) {
      lines.push(`- ${escapeMarkdown(u.username)}: ${u.pct}%`);
    }
  }
  return lines.join('\n');
}

/**
 * Find active users near expiry (<= NEAR_EXPIRY_DAYS away) or near their
 * traffic cap (>= NEAR_CAP_PERCENT% but not yet over) and send the operator a
 * single Telegram digest. Returns the number of users in the digest.
 */
export async function alertNearLimits(): Promise<number> {
  const now = new Date();
  const soon = new Date(now.getTime() + NEAR_EXPIRY_DAYS * 86_400_000);

  // Same widening as findExpiredUsers, for the same reason: a subscriber who is
  // 'limited' on quota is still a subscriber whose term is about to end, and now
  // that the cron actually expires them, an operator who is only told about the
  // 'active' ones hears about the lapse after it happened.
  const expiring = await prisma.user.findMany({
    where: {
      status: { in: ['active', 'limited'] },
      deletedAt: null,
      expireAt: { gte: now, lte: soon },
    },
    select: { username: true, expireAt: true },
    orderBy: { expireAt: 'asc' },
    take: 50,
  });

  // used >= 90% of limit but still under it (at/over -> findExceededTrafficUsers).
  const nearCap = await prisma.$queryRaw<{ username: string; pct: number }[]>`
    SELECT u.username AS username,
           floor(ut.used_traffic_bytes::numeric / u.traffic_limit_bytes::numeric * 100)::int AS pct
    FROM users u
    JOIN user_traffic ut ON u.id = ut.user_id
    WHERE u.status = 'active' AND u.deleted_at IS NULL
      AND u.traffic_limit_bytes IS NOT NULL AND u.traffic_limit_bytes > 0
      AND ut.used_traffic_bytes >= u.traffic_limit_bytes * ${NEAR_CAP_PERCENT} / 100
      AND ut.used_traffic_bytes < u.traffic_limit_bytes
    ORDER BY pct DESC
    LIMIT 50
  `;

  const msg = formatNearLimitsDigest(expiring, nearCap);
  if (!msg) return 0;
  notifyTelegramAsync(msg);
  return expiring.length + nearCap.length;
}
