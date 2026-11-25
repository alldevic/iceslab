import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { eventBus } from '../../lib/infra/event-bus.js';
import { generateUserCredentials } from '../../lib/auth/credentials.js';
import { registerUserEventHandlers } from './users.events.js';
import { nodeUsersQueue } from './users.queue.js';

/**
 * The user.* handlers write the subscription audit trail that the dashboard's
 * "recent events" card reads. The handlers are wired in index.ts, not in
 * buildApp(), so the test registers them itself (the registrar is idempotent).
 */

let seq = 0;
async function makeUser(): Promise<string> {
  seq += 1;
  const c = generateUserCredentials();
  const u = await prisma.user.create({
    data: {
      username: `audit-${seq}`,
      shortId: c.shortId,
      subscriptionToken: c.subscriptionToken,
      hysteriaPassword: c.hysteriaPassword,
      naivePassword: c.naivePassword,
      xrayUuid: c.xrayUuid,
      amneziawgPrivateKey: c.amneziawgPrivateKey,
      amneziawgPublicKey: c.amneziawgPublicKey,
    },
    select: { id: true },
  });
  return u.id;
}

/** The bus delivers on a microtask and the handler then writes; poll for it. */
async function eventsFor(userId: string, want: number) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const rows = await prisma.subscriptionEvent.findMany({
      where: { userId },
      select: { eventType: true, statusBefore: true, statusAfter: true, reason: true },
    });
    if (rows.length >= want || Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 300));

let addSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await cleanDatabase();
  vi.restoreAllMocks();
  // The queue is not under test, and a real enqueue would need a worker.
  addSpy = vi.spyOn(nodeUsersQueue, 'add').mockResolvedValue({} as never);
  registerUserEventHandlers();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.$disconnect();
  await closeRedis();
});

describe('the subscription audit trail', () => {
  it('writes one row for user.created', async () => {
    const id = await makeUser();
    eventBus.emit('user.created', { userId: id, username: 'x' });
    const rows = await eventsFor(id, 1);
    expect(rows).toEqual([{ eventType: 'user.created', statusBefore: null, statusAfter: null, reason: null }]);
  });

  it('writes one row for user.updated, with the changed fields as the reason', async () => {
    const id = await makeUser();
    eventBus.emit('user.updated', { userId: id, changes: ['description', 'tag'] });
    const rows = await eventsFor(id, 1);
    expect(rows).toEqual([
      { eventType: 'user.updated', statusBefore: null, statusAfter: null, reason: 'description, tag' },
    ]);
  });

  it('writes one row for user.status-changed, with the status pair', async () => {
    const id = await makeUser();
    eventBus.emit('user.status-changed', { userId: id, from: 'limited', to: 'expired' });
    const rows = await eventsFor(id, 1);
    expect(rows).toEqual([
      { eventType: 'user.status-changed', statusBefore: 'limited', statusAfter: 'expired', reason: null },
    ]);
  });

  it('writes one row for user.deleted', async () => {
    const id = await makeUser();
    eventBus.emit('user.deleted', { userId: id });
    const rows = await eventsFor(id, 1);
    expect(rows.map((r) => r.eventType)).toEqual(['user.deleted']);
  });

  it('a failing journal write does not stop the node jobs', async () => {
    const id = await makeUser();
    vi.spyOn(prisma.subscriptionEvent, 'create').mockRejectedValue(new Error('disk full'));

    eventBus.emit('user.status-changed', { userId: id, from: 'active', to: 'disabled' });
    eventBus.emit('user.created', { userId: id, username: 'x' });
    await settle();

    expect(addSpy).toHaveBeenCalledWith('removeUser', { userId: id });
    expect(addSpy).toHaveBeenCalledWith('addUser', { userId: id });
  });

  it('an event of a user that does not exist (FK violation) does not crash the handler', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';

    eventBus.emit('user.deleted', { userId: ghost });
    await settle();

    expect(await prisma.subscriptionEvent.count({ where: { userId: ghost } })).toBe(0);
    expect(addSpy).toHaveBeenCalledWith('removeUser', { userId: ghost });
  });
});
