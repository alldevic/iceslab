import { afterAll, describe, expect, it } from 'vitest';
import { Queue, Worker } from 'bullmq';

import { queueRedis, closeRedis } from '../../lib/redis.js';

/**
 * A schedule that is registered and a schedule that FIRES are two claims, and
 * only the first one has ever been checked here.
 *
 * `scheduler.jobs.test.ts` reads the table and the worker's switch out of the
 * source and pairs them; `scheduler.stale.test.ts` covers the cleanup. Both are
 * about what is written down. Whether BullMQ, on this connection, with these
 * options, actually delivers a repeatable to a worker is a claim about the
 * running system — and on 2026-08-27 those options changed: the queues moved off
 * the shared client onto `queueRedis`, because the application half needed a
 * command timeout that BullMQ's blocking reads cannot have.
 *
 * That is exactly the change that would leave the whole cron layer dead while
 * every other test stayed green: nothing in the suite had ever waited for a
 * scheduled job to arrive.
 *
 * Own queue name, never `cron-tasks`. The test Redis is the lab's Redis, and
 * the lab panel has a live scheduler on that queue.
 */
const QUEUE = `test-cron-fires-${process.pid}`;

let queue: Queue | undefined;
let worker: Worker | undefined;

afterAll(async () => {
  await worker?.close();
  // obliterate needs the queue paused-or-empty of workers; close first.
  await queue?.obliterate({ force: true }).catch(() => undefined);
  await queue?.close();
  await closeRedis();
});

describe('a registered schedule reaches a worker', () => {
  it('delivers a repeatable job on the connection the panel uses', async () => {
    const seen: string[] = [];
    queue = new Queue(QUEUE, { connection: queueRedis });
    worker = new Worker(
      QUEUE,
      async (job) => {
        seen.push(job.name);
      },
      { connection: queueRedis },
    );

    // Every second, the way the fleet polls are seconds rather than minutes.
    // The panel's own patterns are up to a day apart, so the pattern here is
    // the fastest one BullMQ takes rather than one copied from the table: what
    // is under test is delivery, not the schedule.
    await queue.add('tick', {}, { repeat: { pattern: '* * * * * *' }, jobId: 'cron:test-tick' });

    const deadline = Date.now() + 20_000;
    while (seen.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }

    expect(
      seen.length,
      'a repeatable was registered and nothing ever ran it: the cron layer is dead on this connection',
    ).toBeGreaterThan(0);
    expect(seen[0], 'the worker ran a job under a different name').toBe('tick');
  }, 30_000);

  it('and the schedule is really registered, not just the one job', async () => {
    // The control. A `queue.add` with a repeat option that BullMQ silently
    // ignored would still produce the single delivery above.
    const schedulers = await queue!.getJobSchedulers(0, 20);
    expect(
      schedulers.map((s) => s.name),
      'no job scheduler was created, so the delivery above was a one-off',
    ).toContain('tick');
  });
});
