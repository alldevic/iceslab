import type { Job, Worker } from 'bullmq';
import { getLogger } from './logger.js';
import { queueJobFailures } from './metrics.js';

/**
 * What happens when a background job fails.
 *
 * Four workers run behind this panel and each answered that differently.
 * `inbound-sync` and `geo-sets` log their own failures, `node-users` logs its
 * per-user failures inside the handler, and `cron-tasks` logged nothing at all:
 * every one of its arms is written as
 *
 *     const n = await doTheWork();
 *     if (n > 0) getLogger().info(...)
 *
 * so success is announced and a throw is silent. It has no `attempts` either,
 * so there is no retry to notice, and the failed job lands in a set only the
 * Bull-board UI at /admin/queues shows. A `review-find-expired` failing every
 * night looked exactly like one succeeding with nothing to do.
 *
 * So it is attached once, from the one place that holds all the workers
 * (index.ts), rather than written again inside each handler.
 *
 * BullMQ emits `failed` on EVERY failed attempt, not only after the last one,
 * and so does the counter: a queue with retries counts each attempt. An alert
 * on "a job really gave up" needs the log's `n/total`, not this rate alone.
 *
 * `error` is the worker itself (a connection that went away) and is listened
 * for regardless: an EventEmitter with no 'error' listener rethrows, which
 * turns a Redis blip into a crash of the process rather than a line in the log.
 *
 * `logFailures: false` is for a worker that already writes its own line per
 * failed job (`inbound-sync`, `geo-sets`): the counter and the `error` listener
 * are still added, the second log line is not.
 */
export function observeWorker(
  worker: Worker,
  queue: string,
  opts: { logFailures?: boolean } = {},
): Worker {
  const logFailures = opts.logFailures ?? true;

  worker.on('failed', (job: Job | undefined, err: Error) => {
    const name = job?.name ?? 'unknown';
    queueJobFailures.inc({ queue, job: name });
    if (!logFailures) return;
    // `|| 1`, not `?? 1`: BullMQ writes `attempts: 0` when a queue declares
    // none, and "1/0" is what that printed (cron-tasks is such a queue).
    const attempts = job ? `${job.attemptsMade}/${job.opts?.attempts || 1}` : '?';
    getLogger().error(
      `[worker:${queue}] job ${name} FAILED after ${attempts} attempt(s): ${err?.message ?? err}`,
    );
  });

  worker.on('error', (err: Error) => {
    getLogger().error(`[worker:${queue}] worker error: ${err?.message ?? err}`);
  });

  return worker;
}
