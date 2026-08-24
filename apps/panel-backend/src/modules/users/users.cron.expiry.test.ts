import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { eventBus } from '../../lib/event-bus.js';
import { generateUserCredentials } from '../../lib/credentials.js';
import { findExpiredUsers } from './users.cron.js';
import { nodeUsersQueue } from './users.queue.js';

/**
 * The expiry cron and the traffic-reset handler, at the seam where they meet.
 *
 * Until now `findExpiredUsers` only looked at `status: 'active'`, so a period
 * subscriber who burned their quota first (native `limited`, expireAt still
 * ahead) never became `expired` when the date arrived: the panel row read as a
 * live subscriber forever, and the facade's `user.expired` webhook - which
 * hangs off exactly this transition - was never emitted for them. The fix was
 * held back because widening the predicate puts the cron in a race with the
 * handler that lifts `limited` back to `active` on a traffic reset. Both halves
 * are covered here.
 */

let seq = 0;
async function user(opts: {
  status: string;
  expireAt: Date | null;
  deleted?: boolean;
}): Promise<string> {
  seq += 1;
  const creds = generateUserCredentials();
  const row = await prisma.user.create({
    data: {
      username: `expiry-${seq}`,
      shortId: creds.shortId,
      subscriptionToken: creds.subscriptionToken,
      hysteriaPassword: creds.hysteriaPassword,
      naivePassword: creds.naivePassword,
      xrayUuid: creds.xrayUuid,
      amneziawgPrivateKey: creds.amneziawgPrivateKey,
      amneziawgPublicKey: creds.amneziawgPublicKey,
      status: opts.status,
      expireAt: opts.expireAt,
      deletedAt: opts.deleted ? new Date() : null,
    },
  });
  return row.id;
}

const PAST = () => new Date(Date.now() - 60_000);
const FUTURE = () => new Date(Date.now() + 3_600_000);

async function statusOf(id: string): Promise<string> {
  const row = await prisma.user.findUniqueOrThrow({
    where: { id },
    select: { status: true },
  });
  return row.status;
}

beforeEach(async () => {
  await cleanDatabase();
  // Restore first: the spies below are cumulative otherwise, and a call count
  // asserted in one test would be reading five tests' worth of enqueues.
  vi.restoreAllMocks();
  // The queue is not what is under test, and a real enqueue would need the
  // worker to drain it.
  vi.spyOn(nodeUsersQueue, 'addBulk').mockResolvedValue([] as never);
  vi.spyOn(nodeUsersQueue, 'add').mockResolvedValue({} as never);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.$disconnect();
  await closeRedis();
});

describe('findExpiredUsers', () => {
  it('expires a limited user whose term has run out', async () => {
    const id = await user({ status: 'limited', expireAt: PAST() });

    const n = await findExpiredUsers();

    expect(n).toBe(1);
    expect(await statusOf(id)).toBe('expired');
  });

  it('reports the status it actually moved from, so the alert is not a lie', async () => {
    const limited = await user({ status: 'limited', expireAt: PAST() });
    const active = await user({ status: 'active', expireAt: PAST() });
    // The bus wraps every handler, so there is no removing one; a flag keeps
    // this listener from collecting the later tests' events.
    const seen: { userId: string; from: string; to: string }[] = [];
    let collecting = true;
    eventBus.on('user.status-changed', (p) => {
      if (collecting) seen.push(p);
    });

    await findExpiredUsers();
    // Handlers are dispatched through a resolved promise, so they land a tick
    // after emit returns.
    await new Promise((r) => setTimeout(r, 50));
    collecting = false;

    expect(seen).toHaveLength(2);
    expect(seen.find((e) => e.userId === limited)?.from).toBe('limited');
    expect(seen.find((e) => e.userId === active)?.from).toBe('active');
    expect(seen.every((e) => e.to === 'expired')).toBe(true);
  });

  it('still expires an active user (the case that always worked)', async () => {
    const id = await user({ status: 'active', expireAt: PAST() });
    expect(await findExpiredUsers()).toBe(1);
    expect(await statusOf(id)).toBe('expired');
  });

  it('leaves a disabled user alone: that is an operator decision, not a lapse', async () => {
    const id = await user({ status: 'disabled', expireAt: PAST() });
    expect(await findExpiredUsers()).toBe(0);
    expect(await statusOf(id)).toBe('disabled');
  });

  it('leaves a limited user whose term has not run out', async () => {
    const id = await user({ status: 'limited', expireAt: FUTURE() });
    expect(await findExpiredUsers()).toBe(0);
    expect(await statusOf(id)).toBe('limited');
  });

  it('leaves a limited user with no expiry at all', async () => {
    const id = await user({ status: 'limited', expireAt: null });
    expect(await findExpiredUsers()).toBe(0);
    expect(await statusOf(id)).toBe('limited');
  });

  it('skips soft-deleted rows', async () => {
    const id = await user({ status: 'limited', expireAt: PAST(), deleted: true });
    expect(await findExpiredUsers()).toBe(0);
    expect(await statusOf(id)).toBe('limited');
  });

  it('bumps updated_at, which is how reconcileOrphanNodeUsers finds the orphan', async () => {
    // The flip is raw SQL now, and Prisma's @updatedAt does not reach raw SQL -
    // a row left with a stale updated_at falls outside the reconcile window and
    // never gets its backstop removeUser.
    const id = await user({ status: 'limited', expireAt: PAST() });
    await prisma.$executeRaw`UPDATE users SET updated_at = now() - interval '3 days' WHERE id = ${id}::uuid`;
    const before = await prisma.user.findUniqueOrThrow({
      where: { id },
      select: { updatedAt: true },
    });

    await findExpiredUsers();

    const after = await prisma.user.findUniqueOrThrow({
      where: { id },
      select: { updatedAt: true },
    });
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect(after.updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('enqueues the node removal for every user it flipped', async () => {
    const a = await user({ status: 'limited', expireAt: PAST() });
    const b = await user({ status: 'active', expireAt: PAST() });

    await findExpiredUsers();

    expect(nodeUsersQueue.addBulk).toHaveBeenCalledTimes(1);
    const jobs = vi.mocked(nodeUsersQueue.addBulk).mock.calls[0][0];
    expect(jobs.map((j) => j.data.userId).sort()).toEqual([a, b].sort());
    expect(jobs.every((j) => j.name === 'removeUser')).toBe(true);
  });
});

describe('the traffic-reset lift, against an expiry that already happened', () => {
  it('does not resurrect a user the expiry cron has already expired', async () => {
    // The handler used to read the status and then write 'active' unconditionally
    // if the read said 'limited'. With the cron now selecting `limited` rows, the
    // row can turn `expired` between those two statements - and a resurrected
    // subscriber goes back onto every node with a term that ended. The guard is
    // that the write itself is conditional, so it is the write that is tested
    // here: a reset arriving for a row that is already `expired` must do
    // nothing. (The interleaving cannot be staged from outside the handler; the
    // conditional write is what makes the interleaving harmless.)
    const { registerUserEventHandlers } = await import('./users.events.js');
    registerUserEventHandlers();

    const id = await user({ status: 'limited', expireAt: PAST() });
    const observed = await statusOf(id);
    expect(observed).toBe('limited');

    await findExpiredUsers();
    expect(await statusOf(id)).toBe('expired');

    eventBus.emit('user.traffic-reset', { userId: id, previousUsedBytes: 0n });
    // The handler is async and fire-and-forget; give the microtask queue and
    // the round-trip a moment.
    await new Promise((r) => setTimeout(r, 200));

    expect(await statusOf(id)).toBe('expired');
  });
});
