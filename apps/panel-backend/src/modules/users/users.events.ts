import { eventBus } from '../../lib/infra/event-bus.js';
import { nodeUsersQueue } from './users.queue.js';
import { notifyTelegramAsync } from '../../lib/notify/telegram-notify.js';
import { prisma } from '../../prisma.js';
import { getLogger } from '../../lib/infra/logger.js';

/**
 * Append one row to the subscription audit trail (the dashboard's "recent
 * events" card reads it, prune-history trims it).
 *
 * `eventType` is the bus event name verbatim, the vocabulary the dashboard
 * card keys its colours on. Not filled, on purpose: performedByAdminId (the
 * bus carries no request context) and the traffic/expiry before-after pairs
 * (the payloads do not carry them); only the status pair exists, and only on
 * user.status-changed.
 *
 * Never lets the audit break the thing being audited: a full disk or a row
 * that loses its FK race must not stop a user from being disabled, so this
 * swallows and logs.
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

/**
 * Register all user-related event handlers, once per process.
 * Called at app bootstrap.
 *
 * Handlers translate domain events into background jobs (BullMQ).
 * The actual node sync happens in workers (slice 9 will implement
 * the mTLS calls). For now workers are mock log-only.
 *
 * The bus has `on` and no `off`, so a second call would add a SECOND handler
 * for every event here and both would fire forever: two addUser jobs and two
 * audit rows per created user. Today there is one call, from index.ts; the
 * guard is for the day that call moves somewhere that runs per case.
 */
let registered = false;

export function registerUserEventHandlers(): void {
  if (registered) return;
  registered = true;
  eventBus.on('user.created', async ({ userId, username }) => {
    console.log(`[event] user.created - ${username} (${userId})`);
    // Recorded BEFORE the sync work: the event is a fact by the time it is
    // emitted, so the audit must not depend on the node fan-out that follows.
    await recordUserEvent('user.created', userId);
    await nodeUsersQueue.add('addUser', { userId });
  });

  eventBus.on('user.updated', async ({ userId, changes }) => {
    console.log(`[event] user.updated - ${userId} - ${changes.join(', ')}`);
    // `reason` holds the changed fields: a field list, not a justification.
    await recordUserEvent('user.updated', userId, {
      reason: changes.length > 0 ? changes.join(', ') : undefined,
    });
    // A-022: the squads decide which nodes and inbounds the user is on, so a
    // change of squads rolls the user out again (addUser takes them off the
    // nodes they no longer reach). Pure metadata needs no node sync; status
    // changes have their own event below. A-053: so do reissued credentials,
    // the nodes replace the identity they hold for this user id.
    if (changes.includes('groupIds') || changes.includes('credentials')) {
      await nodeUsersQueue.add('addUser', { userId });
    }
  });

  // A-022: a squad that changed what it grants (profiles, hosts) moves its
  // members' reach. Each active member is rolled out again; addUser skips a
  // member who is not active.
  eventBus.on('squad.changed', async ({ squadId }) => {
    const members = await prisma.groupMember.findMany({
      where: { groupId: squadId, user: { deletedAt: null, status: 'active' } },
      select: { userId: true },
    });
    if (members.length === 0) return;
    await nodeUsersQueue.addBulk(members.map((m) => ({ name: 'addUser', data: { userId: m.userId } })));
  });

  eventBus.on('user.status-changed', async ({ userId, from, to }) => {
    console.log(`[event] user.status-changed - ${userId} - ${from} → ${to}`);
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
    // Deletion is soft, so the user row this references still exists.
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
  // One conditional write rather than read-then-update: the expiry cron flips
  // 'limited' rows too, so between a read that saw 'limited' and a write of
  // 'active' the row can have become 'expired'. With the status in the WHERE a
  // row that moved is not matched, and `count` says whether anything happened.
  // Expiry outranks quota (as statusAfterEdit): a limited user whose term has
  // already passed is not brought back, the cron expires them on its next pass.
  eventBus.on('user.traffic-reset', async ({ userId }) => {
    const lifted = await prisma.user.updateMany({
      where: {
        id: userId,
        deletedAt: null,
        status: 'limited',
        OR: [{ expireAt: null }, { expireAt: { gt: new Date() } }],
      },
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
