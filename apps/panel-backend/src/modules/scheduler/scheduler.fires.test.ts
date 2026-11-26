import { afterAll, describe, expect, it } from 'vitest';
import { Queue, Worker } from 'bullmq';
import { queueRedis, closeRedis } from '../../lib/infra/redis.js';
import { registerCronJobs } from './scheduler.queue.js';

/**
 * A schedule that is registered and a schedule that FIRES are two claims, and
 * only the first one is checked elsewhere.
 *
 * `scheduler.jobs.test.ts` pairs the table with the worker's switch and
 * `scheduler.register.test.ts` covers replacement; both are about what is
 * written down. Whether BullMQ, on `queueRedis` with these options, actually
 * delivers a repeatable to a worker is a claim about the running system, and
 * the queues were moved onto that dedicated client: the change that would leave
 * the whole cron layer dead while every other test stayed green, because
 * nothing waited for a scheduled job to arrive.
 *
 * Own queue name, never `cron-tasks`: the test Redis may be shared with a live
 * scheduler on that queue. The schedule goes through the panel's own
 * registerCronJobs, so the upsert path is the one that is under test.
 */
const QUEUE = `test-cron-fires-${process.pid}`;

let queue: Queue | undefined;
let worker: Worker | undefined;

afterAll(async () => {
  await worker?.close();
  // obliterate needs the queue free of workers; close the worker first.
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

    // Every second: the panel's own patterns are up to a day apart, so this is
    // the fastest pattern BullMQ takes rather than one copied from the table;
    // what is under test is delivery, not the schedule.
    await registerCronJobs(queue, [{ name: 'tick', pattern: '* * * * * *' }]);

    const deadline = Date.now() + 20_000;
    while (seen.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }

    expect(
      seen.length,
      'a schedule was registered and nothing ever ran it: the cron layer is dead on this connection',
    ).toBeGreaterThan(0);
    expect(seen[0], 'the worker ran a job under a different name').toBe('tick');
  }, 30_000);

  it('and the schedule is really registered, not just the one job', async () => {
    // The control: a one-off delivery would pass the case above.
    const schedulers = await queue!.getJobSchedulers(0, 20);
    expect(
      schedulers.map((s) => s.key),
      'no job scheduler was created, so the delivery above was a one-off',
    ).toContain('tick');
  });
});
