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
 * failing every night — lapsed subscribers keeping their access — read exactly
 * like one succeeding with nothing to do.
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

beforeEach(() => {
  logs.length = 0;
});

describe('a job that failed', () => {
  it('is logged with its queue, its name and how many attempts it burned', async () => {
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

  it('is counted, so a job failing every night is visible as a rate', async () => {
    const w = fakeWorker();
    observeWorker(w, 'cron-tasks');
    const before = await readCounter('prune-history');
    w.emit('failed', { name: 'prune-history', attemptsMade: 1, opts: {} }, new Error('boom'));
    expect(await readCounter('prune-history')).toBe(before + 1);
  });

  async function readCounter(job: string): Promise<number> {
    const metrics = await registry.getMetricsAsJSON();
    const m = metrics.find((x) => x.name === 'iceslab_queue_job_failures_total');
    const v = (m?.values ?? []).find(
      (s) => (s.labels as Record<string, string>)['job'] === job,
    );
    return (v?.value as number) ?? 0;
  }

  // BullMQ emits `failed` with `job` undefined when the job could not be read
  // back (an expired lock, a reaped key). Throwing here would take down the
  // process from inside the thing that reports failures.
  it('survives a failure it cannot name', () => {
    const w = fakeWorker();
    observeWorker(w, 'node-users');
    expect(() => w.emit('failed', undefined, new Error('lock expired'))).not.toThrow();
    expect(logs[0]).toContain('unknown');
  });

  // An EventEmitter with no 'error' listener RETHROWS, so this listener is not
  // decoration: without it a Redis blip is an uncaught exception in a process
  // whose whole design (§47) is to stay answering while Redis is away.
  it('a worker error does not become an uncaught exception', () => {
    const w = fakeWorker();
    observeWorker(w, 'inbound-sync');
    expect(() => w.emit('error', new Error('ECONNRESET'))).not.toThrow();
    expect(logs[0]).toContain('inbound-sync');
  });
});

describe('and every worker the panel starts is wrapped', () => {
  /**
   * The mirror. Attaching the listener once is only worth anything if it is
   * attached to all three, and index.ts is the single place that holds them —
   * so a fourth worker started without it is what this reads for.
   */
  it('index.ts starts no worker outside observeWorker()', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, '../index.ts'), 'utf8');
    const starts = [...src.matchAll(/start(\w+)Worker\(\)/g)].map((m) => m[0]);
    // The control: an empty scan would make the comparison below vacuous, and
    // "no workers found" is also what a rename looks like.
    expect(starts.length, 'no start*Worker() calls found in index.ts').toBeGreaterThanOrEqual(3);

    const unwrapped = starts.filter(
      (call) => !new RegExp(`observeWorker\\(\\s*${call.replace(/[()]/g, '\\$&')}`).test(src),
    );
    expect(
      unwrapped,
      `these workers are started without observeWorker(), so their failures are ` +
        `visible only in the Bull-board page at /admin/queues:\n  ${unwrapped.join('\n  ')}`,
    ).toEqual([]);
  });
});
