import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { eventBus } from '../../lib/infra/event-bus.js';
import { generateUserCredentials } from '../../lib/auth/credentials.js';
import { findExpiredUsers } from './users.cron.js';
import { registerUserEventHandlers } from './users.events.js';
import { nodeUsersQueue } from './users.queue.js';

/**
 * The expiry cron and the traffic-reset handler. A period subscriber who burned
 * the quota first (`limited`, expireAt ahead) must still become `expired` when
 * the date arrives, and the event must say what the row really moved from.
 * The traffic-reset lift is a conditional write and never brings back a user
 * whose term has passed (expiry outranks quota, as statusAfterEdit).
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
  const row = await prisma.user.findUniqueOrThrow({ where: { id }, select: { status: true } });
  return row.status;
}

/** Emit a reset and wait for the fire-and-forget handler to land. */
async function reset(id: string): Promise<void> {
  eventBus.emit('user.traffic-reset', { userId: id, previousUsedBytes: 0n });
  await new Promise((r) => setTimeout(r, 200));
}

beforeEach(async () => {
  await cleanDatabase();
  vi.restoreAllMocks();
  vi.spyOn(nodeUsersQueue, 'addBulk').mockResolvedValue([] as never);
  vi.spyOn(nodeUsersQueue, 'add').mockResolvedValue({} as never);
  registerUserEventHandlers();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.$disconnect();
  await closeRedis();
});

describe('findExpiredUsers', () => {
  it('expires a limited user whose term has run out', async () => {
    const id = await user({ status: 'limited', expireAt: PAST() });
    expect(await findExpiredUsers()).toBe(1);
    expect(await statusOf(id)).toBe('expired');
  });

  it('reports the status it actually moved from', async () => {
    const limited = await user({ status: 'limited', expireAt: PAST() });
    const active = await user({ status: 'active', expireAt: PAST() });
    const seen: { userId: string; from: string; to: string }[] = [];
    let collecting = true;
    eventBus.on('user.status-changed', (p) => {
      if (collecting) seen.push(p);
    });

    await findExpiredUsers();
    await new Promise((r) => setTimeout(r, 50));
    collecting = false;

    expect(seen).toHaveLength(2);
    expect(seen.find((e) => e.userId === limited)?.from).toBe('limited');
    expect(seen.find((e) => e.userId === active)?.from).toBe('active');
    expect(seen.every((e) => e.to === 'expired')).toBe(true);
  });

  it('still expires an active user', async () => {
    const id = await user({ status: 'active', expireAt: PAST() });
    expect(await findExpiredUsers()).toBe(1);
    expect(await statusOf(id)).toBe('expired');
  });

  it('leaves a disabled user alone', async () => {
    const id = await user({ status: 'disabled', expireAt: PAST() });
    expect(await findExpiredUsers()).toBe(0);
    expect(await statusOf(id)).toBe('disabled');
  });

  it('leaves a limited user whose term has not run out, or has none', async () => {
    const a = await user({ status: 'limited', expireAt: FUTURE() });
    const b = await user({ status: 'limited', expireAt: null });
    expect(await findExpiredUsers()).toBe(0);
    expect(await statusOf(a)).toBe('limited');
    expect(await statusOf(b)).toBe('limited');
  });

  it('skips soft-deleted rows', async () => {
    const id = await user({ status: 'limited', expireAt: PAST(), deleted: true });
    expect(await findExpiredUsers()).toBe(0);
    expect(await statusOf(id)).toBe('limited');
  });

  it('bumps updated_at, which is how reconcileOrphanNodeUsers finds the orphan', async () => {
    const id = await user({ status: 'limited', expireAt: PAST() });
    await prisma.$executeRaw`UPDATE users SET updated_at = now() - interval '3 days' WHERE id = ${id}::uuid`;

    await findExpiredUsers();

    const after = await prisma.user.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } });
    expect(after.updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('enqueues the node removal for every user it flipped', async () => {
    const a = await user({ status: 'limited', expireAt: PAST() });
    const b = await user({ status: 'active', expireAt: PAST() });

    await findExpiredUsers();

    expect(nodeUsersQueue.addBulk).toHaveBeenCalledTimes(1);
    const jobs = vi.mocked(nodeUsersQueue.addBulk).mock.calls[0]![0];
    expect(jobs.map((j) => j.data.userId).sort()).toEqual([a, b].sort());
    expect(jobs.every((j) => j.name === 'removeUser')).toBe(true);
  });
});

describe('the traffic-reset lift', () => {
  it('returns a limited user in term to active', async () => {
    const id = await user({ status: 'limited', expireAt: FUTURE() });
    await reset(id);
    expect(await statusOf(id)).toBe('active');
  });

  it('returns a limited user with no expiry to active', async () => {
    const id = await user({ status: 'limited', expireAt: null });
    await reset(id);
    expect(await statusOf(id)).toBe('active');
  });

  it('does not return a limited user whose term has passed; the cron then expires them', async () => {
    const id = await user({ status: 'limited', expireAt: PAST() });
    await reset(id);
    expect(await statusOf(id)).toBe('limited');

    await findExpiredUsers();
    expect(await statusOf(id)).toBe('expired');
  });

  it('does not resurrect a user the expiry cron has already expired', async () => {
    const id = await user({ status: 'limited', expireAt: PAST() });
    await findExpiredUsers();
    await reset(id);
    expect(await statusOf(id)).toBe('expired');
  });

  it('does not touch a deleted user or one that is not limited', async () => {
    const deleted = await user({ status: 'limited', expireAt: FUTURE(), deleted: true });
    const disabled = await user({ status: 'disabled', expireAt: FUTURE() });
    await reset(deleted);
    await reset(disabled);
    expect(await statusOf(deleted)).toBe('limited');
    expect(await statusOf(disabled)).toBe('disabled');
  });

  it('queues nothing when nothing was lifted', async () => {
    const id = await user({ status: 'disabled', expireAt: FUTURE() });
    await reset(id);
    expect(nodeUsersQueue.add).not.toHaveBeenCalled();
  });
});
