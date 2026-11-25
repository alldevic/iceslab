import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Worker } from 'bullmq';

/**
 * Whether a failed background job leaves a trace.
 *
 * The failure this covers is the quiet one: cron-tasks logged `if (n > 0)
 * info(...)` on success and nothing on a throw, so a `review-find-expired`
 * failing every night read exactly like one succeeding with nothing to do.
 */

const logs: string[] = [];
vi.mock('./logger.js', () => ({
  getLogger: () => ({
    error: (m: string) => logs.push(m),
    warn: (m: string) => logs.push(m),
    info: () => {},
    debug: () => {},
  }),
}));

const { observeWorker } = await import('./queue-observability.js');
const { registry } = await import('./metrics.js');

/** A Worker is an EventEmitter; this is the part of it that matters here. */
function fakeWorker(): Worker & EventEmitter {
  return new EventEmitter() as unknown as Worker & EventEmitter;
}

async function readCounter(queue: string, job: string): Promise<number> {
  const metrics = await registry.getMetricsAsJSON();
  const m = metrics.find((x) => x.name === 'iceslab_queue_job_failures_total');
  const v = (m?.values ?? []).find((s) => {
    const l = s.labels as Record<string, string>;
    return l['job'] === job && l['queue'] === queue;
  });
  return (v?.value as number) ?? 0;
}

beforeEach(() => {
  logs.length = 0;
});

describe('a job that failed', () => {
  it('is logged once with its queue, its name and how many attempts it burned', () => {
    const w = fakeWorker();
    observeWorker(w, 'cron-tasks');
    w.emit(
      'failed',
      { name: 'review-find-expired', attemptsMade: 1, opts: { attempts: 1 } },
      new Error('relation "users" does not exist'),
    );

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('cron-tasks');
    expect(logs[0]).toContain('review-find-expired');
    expect(logs[0]).toContain('1/1');
    // The operator needs the cause, not just that something went wrong.
    expect(logs[0]).toContain('relation "users" does not exist');
  });

  it('reads done/total for a queue with retries', () => {
    const w = fakeWorker();
    observeWorker(w, 'node-users');
    w.emit('failed', { name: 'x', attemptsMade: 2, opts: { attempts: 5 } }, new Error('x'));
    expect(logs[0]).toContain('2/5');
  });

  // BullMQ writes `attempts: 0` for a queue that declares none, which is
  // cron-tasks: the first line it wrote read "1/0 attempt(s)".
  it('reads 1/1 for a queue that declares no attempts, not 1/0', () => {
    const w = fakeWorker();
    observeWorker(w, 'cron-tasks');
    w.emit('failed', { name: 'prune-history', attemptsMade: 1, opts: { attempts: 0 } }, new Error('x'));
    expect(logs[0]).toContain('1/1');
    expect(logs[0]).not.toContain('1/0');
  });

  it('is counted by queue and job, every attempt', async () => {
    const w = fakeWorker();
    observeWorker(w, 'cron-tasks');
    const before = await readCounter('cron-tasks', 'prune-history');
    w.emit('failed', { name: 'prune-history', attemptsMade: 1, opts: {} }, new Error('boom'));
    w.emit('failed', { name: 'prune-history', attemptsMade: 2, opts: { attempts: 3 } }, new Error('boom'));
    expect(await readCounter('cron-tasks', 'prune-history')).toBe(before + 2);
    // A different queue's series is not touched.
    expect(await readCounter('node-users', 'prune-history')).toBe(0);
  });

  // A worker with its own per-failure line must not get a second one, but its
  // failures are still counted.
  it('with logFailures: false is counted and not logged again', async () => {
    const w = fakeWorker();
    observeWorker(w, 'inbound-sync', { logFailures: false });
    const before = await readCounter('inbound-sync', 'apply');
    w.emit('failed', { name: 'apply', attemptsMade: 1, opts: { attempts: 3 } }, new Error('boom'));
    expect(logs).toHaveLength(0);
    expect(await readCounter('inbound-sync', 'apply')).toBe(before + 1);
  });

  // BullMQ emits `failed` with `job` undefined when the job could not be read
  // back (an expired lock). Throwing here would take down the process from
  // inside the thing that reports failures.
  it('survives a failure it cannot name', () => {
    const w = fakeWorker();
    observeWorker(w, 'node-users');
    expect(() => w.emit('failed', undefined, new Error('lock expired'))).not.toThrow();
    expect(logs[0]).toContain('unknown');
  });

  // An EventEmitter with no 'error' listener RETHROWS, so this listener is not
  // decoration: without it a Redis blip is an uncaught exception.
  it('a worker error does not become an uncaught exception', () => {
    const w = fakeWorker();
    observeWorker(w, 'inbound-sync', { logFailures: false });
    expect(() => w.emit('error', new Error('ECONNRESET'))).not.toThrow();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('inbound-sync');
  });
});

describe('and every worker the panel starts is wrapped', () => {
  /** index.ts is the single place that holds the workers, so a fifth one
   *  started without the wrapper is what this reads for. */
  it('index.ts starts no worker outside observeWorker()', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, '../../index.ts'), 'utf8');
    const starts = [...src.matchAll(/start(\w+)Worker\(\)/g)].map((m) => m[0]);
    // The control: an empty scan would make the comparison vacuous.
    expect(starts.length, 'no start*Worker() calls found in index.ts').toBeGreaterThanOrEqual(4);

    const unwrapped = starts.filter(
      (call) => !new RegExp(`observeWorker\\(\\s*${call.replace(/[()]/g, '\\$&')}`).test(src),
    );
    expect(
      unwrapped,
      `these workers are started without observeWorker(), so their failures are ` +
        `visible only in the Bull-board page at /admin/queues:\n  ${unwrapped.join('\n  ')}`,
    ).toEqual([]);
  });

  // Workers that log their own failure must say so, or the line is doubled.
  it('inbound-sync and geo-sets keep their own log and do not get a second one', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, '../../index.ts'), 'utf8');
    for (const [fn, q] of [['startInboundSyncWorker', 'inbound-sync'], ['startGeoSetsWorker', 'geo-sets']]) {
      expect(src).toMatch(new RegExp(`observeWorker\\(${fn}\\(\\), '${q}', \\{ logFailures: false \\}\\)`));
    }
  });
});
