import type { Job, Worker } from 'bullmq';
import { getLogger } from './logger.js';
import { queueJobFailures } from './metrics.js';

/**
 * What happens when a background job fails.
 *
 * Three workers run behind this panel and each answered that differently.
 * `inbound-sync` logs every per-node failure inside its handler and counts the
 * outcome; `node-users` logs its per-user failures; `cron-tasks` logged nothing
 * at all — every one of its arms is written as
 *
 *     const n = await doTheWork();
 *     if (n > 0) getLogger().info(...)
 *
 * so success is announced and a throw is silent. It has no `attempts` either,
 * so there is no retry to notice, and the failed job lands in a set only the
 * Bull-board UI at /admin/queues shows. Nobody watches that.
 *
 * The tasks behind it are not bookkeeping: `review-find-expired` is what stops
 * a lapsed subscriber's access, `review-find-exceeded-traffic` is what enforces
 * a quota, `prune-history` is what keeps the retention tables from growing
 * without limit. Each of those failing every night, forever, looked exactly
 * like each of them succeeding with nothing to do.
 *
 * So it is attached once, from the one place that holds all three workers,
 * rather than written a fourth time inside a handler. `failed` fires after the
 * final attempt; `error` is the worker itself (a connection that went away),
 * and it is listened for regardless — an EventEmitter with no 'error' listener
 * rethrows, which turns a Redis blip into a crash of the process rather than a
 * line in the log.
 */
export function observeWorker(worker: Worker, queue: string): Worker {
  worker.on('failed', (job: Job | undefined, err: Error) => {
    const name = job?.name ?? 'unknown';
    // `|| 1`, not `?? 1`: BullMQ writes `attempts: 0` when a queue declares
    // none, and "1/0 attempt(s)" is what that printed. Measured on the lab
    // panel the first night this listener existed — cron-tasks is exactly the
    // queue with no `attempts`, so it was the first line it ever wrote.
    const attempts = job ? `${job.attemptsMade}/${job.opts?.attempts || 1}` : '?';
    queueJobFailures.inc({ queue, job: name });
    getLogger().error(
      `[worker:${queue}] job ${name} FAILED after ${attempts} attempt(s): ${err?.message ?? err}`,
    );
  });

  worker.on('error', (err: Error) => {
    getLogger().error(`[worker:${queue}] worker error: ${err?.message ?? err}`);
  });

  return worker;
}
