import { eventBus } from '../../lib/event-bus.js';
import { nodeUsersQueue } from './users.queue.js';
import { notifyTelegramAsync } from '../../lib/telegram-notify.js';
import { prisma } from '../../prisma.js';
import { getLogger } from '../../lib/logger.js';

/**
 * Register all user-related event handlers.
 * Called once at app bootstrap.
 *
 * Handlers translate domain events into background jobs (BullMQ).
 * The actual node sync happens in workers (slice 9 will implement
 * the mTLS calls). For now workers are mock log-only.
 */
/**
 * Append one row to the subscription audit trail.
 *
 * The table, the dashboard query that reads it and the panel card that renders
 * it all existed; nothing wrote a row. So `recentEvents()` returned [] on every
 * real panel, the card showed its empty state forever, and `prune-history`
 * logged "deleted 0 sub-event rows" for a table that never had any. The
 * retention cron's own comment called it "append-only (one row per admin action
 * / status flip)" — a claim about behaviour that did not happen.
 *
 * `eventType` is the bus event name verbatim, because that is the vocabulary
 * the card already keys its colours on (`EVENT_COLOR` in DashboardPage).
 *
 * What is NOT filled, and why, so the NULLs are not read as data loss:
 *   - performedByAdminId: the bus carries no request context. Threading the
 *     acting admin through every emit is a separate change; the card does not
 *     show it today.
 *   - the traffic/expiry before-after pairs: the payloads do not carry them.
 *     Only the status pair is available, and only on user.status-changed.
 *
 * Never lets the audit break the thing being audited. A full disk or a row that
 * loses its FK race must not stop a user from being disabled, so this swallows
 * and logs. Awaited rather than fired-and-forgotten: handlers already run on a
 * microtask after emit returns, so the caller's request pays nothing for it,
 * and awaiting keeps the ordering observable to a test.
 */
async function recordUserEvent(
  eventType: string,
  userId: string,
  extra: { statusBefore?: string; statusAfter?: string; reason?: string } = {},
): Promise<void> {
  try {
    await prisma.subscriptionEvent.create({
      data: {
        userId,
        eventType,
        statusBefore: extra.statusBefore ?? null,
        statusAfter: extra.statusAfter ?? null,
        reason: extra.reason ?? null,
      },
    });
  } catch (err) {
    getLogger().warn({ err, eventType, userId }, '[audit] could not record a subscription event');
  }
}

export function registerUserEventHandlers(): void {
  eventBus.on('user.created', async ({ userId, username }) => {
    console.log(`[event] user.created - ${username} (${userId})`);
    // Recorded BEFORE the sync work. The event is a fact by the time it is
    // emitted — the row is already committed — so the audit must not depend on
    // whether the node fan-out that follows succeeds.
    await recordUserEvent('user.created', userId);
    await nodeUsersQueue.add('addUser', { userId });
  });

  eventBus.on('user.updated', async ({ userId, changes }) => {
    console.log(`[event] user.updated - ${userId} - ${changes.join(', ')}`);
    // No node sync needed for pure metadata updates (description, tag, email, etc.)
    // Status changes have their own event below.
    //
    // `changes` goes into `reason`, which is free text. It is a list of fields
    // rather than a justification, and the comment says so where the column is
    // read — without it the row records only "something changed", which is the
    // one thing the reader already knows from the event type.
    await recordUserEvent('user.updated', userId, {
      reason: changes.length > 0 ? changes.join(', ') : undefined,
    });
  });

  eventBus.on('user.status-changed', async ({ userId, from, to }) => {
    console.log(`[event] user.status-changed - ${userId} - ${from} → ${to}`);
    // The only event whose payload carries a real before/after pair, so it is
    // the only one that fills the status columns.
    await recordUserEvent('user.status-changed', userId, {
      statusBefore: from,
      statusAfter: to,
    });
    // Going non-active → remove user from nodes
    if (to === 'disabled' || to === 'limited' || to === 'expired') {
      await nodeUsersQueue.add('removeUser', { userId });
    }
    // Going back to active → re-add to nodes
    if (to === 'active' && from !== 'active') {
      await nodeUsersQueue.add('addUser', { userId });
    }
    // Slice 32 - admin alert on the two operator-visible transitions:
    // expired (subscription lapse) and limited (quota burn). Skip the
    // routine `active ↔ disabled` toggles, admins are the ones flipping
    // those and don't need to be told what they just did.
    if (to === 'expired' || to === 'limited') {
      const icon = to === 'expired' ? '⏳' : '📊';
      notifyTelegramAsync(
        `${icon} *User ${to}*\nuserId: \`${userId}\`\nprevious: ${from}`,
      );
    }
  });

  eventBus.on('user.deleted', async ({ userId }) => {
    console.log(`[event] user.deleted - ${userId}`);
    // Recorded first, same reason as user.created. Safe to record at all
    // because deletion is SOFT (repo.softDelete sets deletedAt), so the row
    // this references still exists — a hard delete would cascade this very row
    // away and the audit would lose exactly the deletion it exists to note.
    await recordUserEvent('user.deleted', userId);
    await nodeUsersQueue.add('removeUser', { userId });
  });

  // Traffic reset means the user is back under quota. Without this handler,
  // users who got flipped to 'limited' would stay locked even after the
  // strategy-boundary reset cleared their usedTrafficBytes, the operator
  // had to flip them back manually. Flip limited→active and let the
  // status-changed cascade do the addUser fan-out, emitting the event
  // already triggers nodeUsersQueue.add('addUser') in the handler above.
  // (Earlier version did both, producing double-enqueue on every reset.)
  //
  // Read-and-write in one conditional statement, not a findFirst followed by an
  // update: the expiry cron now flips 'limited' rows too (users.cron.ts), so
  // between a read that saw 'limited' and a write that sets 'active' the row
  // can legitimately have become 'expired' - and this handler would resurrect a
  // subscriber whose term has ended, sending them back onto every node. With
  // the status in the WHERE clause, a row that moved is simply not matched, and
  // `count` is what says whether anything happened.
  eventBus.on('user.traffic-reset', async ({ userId }) => {
    const lifted = await prisma.user.updateMany({
      where: { id: userId, deletedAt: null, status: 'limited' },
      data: { status: 'active' },
    });
    if (lifted.count === 0) return;
    eventBus.emit('user.status-changed', {
      userId,
      from: 'limited',
      to: 'active',
    });
  });
}
