import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis, redis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { eventBus } from '../../lib/event-bus.js';
import { registerUserEventHandlers } from './users.events.js';
import { nodeUsersQueue } from './users.queue.js';
import { getOverview } from '../dashboard/dashboard.service.js';

/**
 * The audit trail that nothing wrote.
 *
 * `subscription_events` had nine before/after columns, a retention policy, a
 * cron that pruned it and logged how many rows it had deleted, a dashboard
 * query that selected from it and a panel card that rendered the result. No
 * code path created a row. So the card showed its empty state on every real
 * panel, forever, and `prune-history` reported deleting nothing from a table
 * that never had anything — the third instance this week of "built,
 * documented, wired into a UI, never fed".
 *
 * The vocabulary was not a guess: DashboardPage's EVENT_COLOR map already keys
 * on `user.created` / `user.updated` / `user.deleted` / `user.status-changed`,
 * which are the bus event names verbatim. The intended writer was the bus.
 *
 * Registered here explicitly. The handlers are wired in `index.ts`, not in
 * `buildApp()`, so a test that only builds the app has no subscribers at all —
 * the same trap that hides `registerBindingsCacheBust`.
 */

let registered = false;
let userIds: string[] = [];

let seq = 0;

async function makeUser(username: string, status = 'active'): Promise<string> {
  seq += 1;
  const u = await prisma.user.create({
    data: {
      username,
      status,
      shortId: `sid${seq}`,
      subscriptionToken: `tok-${username}-${seq}`,
      hysteriaPassword: `hy-${seq}`,
      amneziawgPrivateKey: `priv-${seq}`,
      amneziawgPublicKey: `pub-${seq}`,
      naivePassword: `nv-${seq}`,
      xrayUuid: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
      updatedAt: new Date(),
    },
    select: { id: true },
  });
  userIds.push(u.id);
  return u.id;
}

/** The bus delivers on a microtask and the handler then writes; poll for it. */
async function eventsFor(userId: string, want: number): Promise<
  { eventType: string; statusBefore: string | null; statusAfter: string | null; reason: string | null }[]
> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const rows = await prisma.subscriptionEvent.findMany({
      where: { userId },
      orderBy: { id: 'asc' },
      select: { eventType: true, statusBefore: true, statusAfter: true, reason: true },
    });
    if (rows.length >= want || Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(async () => {
  await cleanDatabase();
  userIds = [];
  if (!registered) {
    registerUserEventHandlers();
    registered = true;
  }
});

afterEach(async () => {
  // The handlers enqueue real jobs; the queue is shared with the rest of the
  // suite and with a live panel if one is up.
  for (const id of userIds) {
    for (const name of ['addUser', 'removeUser']) {
      const job = await nodeUsersQueue.getJob(`${name}-${id}`).catch(() => null);
      if (job) await job.remove().catch(() => null);
    }
  }
  await redis.del('dashboard:overview:v1').catch(() => null);
});

afterAll(async () => {
  await nodeUsersQueue.close();
  await prisma.$disconnect();
  await closeRedis();
});

describe('the subscription audit trail', () => {
  it('records a row for every event the dashboard card knows how to colour', async () => {
    const id = await makeUser('audited');

    eventBus.emit('user.created', { userId: id, username: 'audited' });
    eventBus.emit('user.updated', { userId: id, changes: ['description', 'tag'] });
    eventBus.emit('user.status-changed', { userId: id, from: 'active', to: 'disabled' });
    eventBus.emit('user.deleted', { userId: id });

    const rows = await eventsFor(id, 4);
    // A SET, not a sequence. Each handler runs on its own microtask and its
    // insert goes to a pooled connection, so four events emitted in the same
    // tick have no guaranteed insert order and the implementation does not
    // claim one. Real events are seconds apart and the card orders by
    // createdAt; what has to hold is that none of the four is dropped.
    expect(
      rows.map((r) => r.eventType).sort(),
      'the card keys its colours on exactly these four names',
    ).toEqual(['user.created', 'user.deleted', 'user.status-changed', 'user.updated']);
  });

  it('fills the status pair on the one event that carries one', async () => {
    const id = await makeUser('flipped');

    eventBus.emit('user.status-changed', { userId: id, from: 'active', to: 'limited' });

    const [row] = await eventsFor(id, 1);
    expect(row.statusBefore).toBe('active');
    expect(row.statusAfter).toBe('limited');
  });

  it('leaves the status pair empty where the payload has none', async () => {
    // The control on the case above: columns filled with something for every
    // event would make "the pair is right" true of an implementation that
    // invents it. Absent and wrong are different answers.
    const id = await makeUser('created-only');

    eventBus.emit('user.created', { userId: id, username: 'created-only' });

    const [row] = await eventsFor(id, 1);
    expect(row.statusBefore).toBeNull();
    expect(row.statusAfter).toBeNull();
  });

  it('records which fields an update touched', async () => {
    const id = await makeUser('edited');

    eventBus.emit('user.updated', { userId: id, changes: ['telegramId'] });

    const [row] = await eventsFor(id, 1);
    // Without this the row says only "something changed", which the event type
    // already said.
    expect(row.reason).toBe('telegramId');
  });

  it('survives a deletion, because the deletion is soft', async () => {
    // A hard delete would cascade this row away (onDelete: Cascade), and the
    // audit would lose exactly the event it exists to note.
    const id = await makeUser('gone');
    eventBus.emit('user.deleted', { userId: id });
    await eventsFor(id, 1);

    await prisma.user.update({ where: { id }, data: { deletedAt: new Date() } });

    const rows = await eventsFor(id, 1);
    expect(rows.map((r) => r.eventType)).toEqual(['user.deleted']);
  });

  it('reaches the dashboard card that had been empty since the table existed', async () => {
    // The end the whole thing exists for. recentEvents() selects from this
    // table and DashboardPage renders the result; with nothing writing rows,
    // the card's empty-state branch was the only one production ever took.
    const id = await makeUser('on-the-card');
    eventBus.emit('user.status-changed', { userId: id, from: 'active', to: 'disabled' });
    await eventsFor(id, 1);

    // getOverview caches in Redis for 30s, and the cache is shared with a live
    // panel if one is up. Drop it, or this reads somebody else's snapshot.
    await redis.del('dashboard:overview:v1').catch(() => null);
    const overview = await getOverview();

    const mine = overview.recentEvents.filter((e) => e.userId === id);
    expect(mine, 'the card would still be showing its empty state').toHaveLength(1);
    expect(mine[0]!.eventType).toBe('user.status-changed');
    expect(mine[0]!.username, 'the card falls back to a truncated id without this').toBe('on-the-card');
  });

  it('does not let the audit break the thing it audits', async () => {
    // An event for a user that is not there loses the FK. The handler must
    // still do its real work; an audit that can stop a user being disabled is
    // worse than no audit.
    const ghost = '00000000-0000-4000-8000-000000000000';

    eventBus.emit('user.status-changed', { userId: ghost, from: 'active', to: 'disabled' });
    await new Promise((r) => setTimeout(r, 300));

    expect(await prisma.subscriptionEvent.count({ where: { userId: ghost } })).toBe(0);

    // The queue job is the handler's real work and it has to have happened.
    //
    // Looked up by DATA, not by a job id: these are added without one, so
    // BullMQ assigns a number and `getJob('removeUser-<uuid>')` resolves to
    // UNDEFINED for every input — and `expect(undefined).not.toBeNull()`
    // passes. The first version of this case did exactly that and stayed green
    // when the swallow was removed, which is the whole failure it was written
    // to catch.
    const jobs = await nodeUsersQueue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']);
    const mine = jobs.filter((j) => (j.data as { userId?: string }).userId === ghost);
    expect(
      mine.map((j) => j.name),
      'the failed audit insert swallowed the node sync with it',
    ).toContain('removeUser');
    for (const j of mine) await j.remove().catch(() => null);
  });
});
