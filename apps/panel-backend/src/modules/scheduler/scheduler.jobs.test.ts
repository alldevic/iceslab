// The table of cron jobs, and the switch that runs them.
//
// `scheduler.stale.test.ts` covers the cleanup of schedules that no longer
// belong. What nothing covered is the pair the whole subsystem rests on: a
// name in the table and a `case` in the worker. Measured: the suite of 1611
// stayed green with `prune-history` deleted from the table - retention then
// never runs and the disk fills on a 2 GB VPS - and green again with the
// fifteen-second metrics poll turned into a daily one.
//
// The two directions fail differently, and only one of them is loud:
//
//   * a table entry with no `case` reaches the worker's `default`, which throws
//     `Unknown cron job`. The job fails, visibly, every tick;
//   * a `case` with no table entry is SILENT. The handler is there, reads
//     correctly, and is never scheduled by anybody.
//
// Neither list is exported, so both are read out of the source - the same
// instrument the webhook registry and the panel↔node wire tests use, and for
// the same reason: a list copied into a test is a list that goes stale.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { cronTasksQueue } from './scheduler.queue.js';
import { closeRedis } from '../../lib/redis.js';

const SOURCE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'scheduler.queue.ts'),
  'utf8',
);

/** The scheduled jobs, as declared in CRON_JOBS. */
function tableEntries(): { name: string; pattern: string }[] {
  const start = SOURCE.indexOf('const CRON_JOBS: CronJobSpec[] = [');
  expect(start, 'CRON_JOBS was renamed or moved').toBeGreaterThan(-1);
  const body = SOURCE.slice(start, SOURCE.indexOf('\n];', start));
  return [...body.matchAll(/\{\s*name:\s*'([^']+)',\s*pattern:\s*'([^']+)'\s*\}/g)].map((m) => ({
    name: m[1]!,
    pattern: m[2]!,
  }));
}

/** The job names the worker knows how to run. */
function handledNames(): string[] {
  const start = SOURCE.indexOf('export function startCronTasksWorker');
  expect(start, 'startCronTasksWorker was renamed').toBeGreaterThan(-1);
  const body = SOURCE.slice(start);
  return [...body.matchAll(/^\s*case '([a-z0-9-]+)': \{?$/gm)].map((m) => m[1]!);
}

afterAll(async () => {
  await cronTasksQueue.close();
  await closeRedis();
});

describe('every job is both scheduled and handled', () => {
  it('reads both lists out of the source at all', () => {
    // Without this, a parser that quietly matched nothing would make the two
    // comparisons below pass by vacuum.
    expect(tableEntries().length).toBeGreaterThan(10);
    expect(handledNames().length).toBeGreaterThan(10);
  });

  it('has a handler for every scheduled job', () => {
    const handled = new Set(handledNames());
    for (const { name } of tableEntries()) {
      expect(
        handled.has(name),
        `"${name}" is scheduled but the worker has no case for it: every tick reaches the ` +
          '`default` branch and throws',
      ).toBe(true);
    }
  });

  // The silent direction. Nothing anywhere would report a handler that is never
  // asked to run - the panel starts, the log line says "registered N cron jobs",
  // and the work simply does not happen.
  it('schedules every job the worker can handle', () => {
    const scheduled = new Set(tableEntries().map((j) => j.name));
    for (const name of handledNames()) {
      expect(
        scheduled.has(name),
        `the worker handles "${name}" but nothing schedules it: the code reads correctly ` +
          'and the job never runs',
      ).toBe(true);
    }
  });

  it('names each job once', () => {
    const names = tableEntries().map((j) => j.name);
    expect(new Set(names).size, `duplicate job name in CRON_JOBS: ${names.join(', ')}`).toBe(
      names.length,
    );
  });
});

describe('the patterns are ones the scheduler will take', () => {
  // Asked of BullMQ rather than of a cron library of our choosing: BullMQ is
  // what will parse these at startup, and a pattern it rejects takes the whole
  // registration down. Every schedule created here is removed again.
  it('registers and removes every pattern in the table', async () => {
    const created: string[] = [];
    try {
      for (const { name, pattern } of tableEntries()) {
        const job = await cronTasksQueue.add(
          `test-pattern-${name}`,
          {},
          { repeat: { pattern }, jobId: `test-pattern-${name}` },
        );
        expect(job, `BullMQ refused the pattern "${pattern}" of ${name}`).toBeTruthy();
        created.push(name);
      }
    } finally {
      for (const id of await cronTasksQueue.getJobSchedulers(0, 1000)) {
        if (id.key?.startsWith('test-pattern-')) {
          await cronTasksQueue.removeJobScheduler(id.key).catch(() => null);
        }
      }
      for (const name of created) {
        const job = await cronTasksQueue.getJob(`test-pattern-${name}`).catch(() => null);
        if (job) await job.remove().catch(() => null);
      }
    }
  });
});

describe('the cadences that carry a reason', () => {
  const patternOf = (name: string): string | undefined =>
    tableEntries().find((j) => j.name === name)?.pattern;

  // Slowing this to hourly is the change the source argues against at length:
  // the 24h stage is the shop's only trigger for an auto-charge, and on an
  // hourly tick a subscription shorter than an hour can expire between two
  // ticks without ever landing in the window. No charge is taken, and it looks
  // like the customer refused to pay.
  it('checks for expiring subscriptions every ten minutes', () => {
    expect(patternOf('remnawave-expiry-notify')).toBe('*/10 * * * *');
  });

  // Sub-minute polls. These are what makes a node's liveness - and therefore
  // every subscription's contents - current rather than historical.
  it('polls the fleet in seconds, not minutes', () => {
    expect(patternOf('node-healthcheck-poll')).toBe('*/30 * * * * *');
    expect(patternOf('node-metrics-poll')).toBe('*/15 * * * * *');
    expect(patternOf('node-stats-poll')).toBe('*/30 * * * * *');
    for (const p of ['node-healthcheck-poll', 'node-metrics-poll', 'node-stats-poll']) {
      expect(
        patternOf(p)!.split(' '),
        `${p} lost its seconds field, so it now runs 60x less often`,
      ).toHaveLength(6);
    }
  });

  // Retention is the only job that DELETES. It has to be scheduled at all -
  // that is the mutation that went unnoticed - and it has to run off-peak,
  // because it walks four history tables.
  it('prunes history once a day, in the small hours', () => {
    const pattern = patternOf('prune-history');
    expect(pattern, 'prune-history is not scheduled: the history tables grow forever').toBeTruthy();
    const [minute, hour, dom, month, dow] = pattern!.split(' ');
    expect([dom, month, dow], 'prune-history must run every day').toEqual(['*', '*', '*']);
    expect(Number(hour), 'a table-walking delete belongs off-peak').toBeLessThan(6);
    expect(Number.isNaN(Number(minute))).toBe(false);
  });

  // The traffic resets are what a customer's quota depends on. Each runs on its
  // own strategy date, and they are deliberately staggered by five minutes so
  // three of them never contend for the same rows at midnight.
  it('staggers the traffic resets just after midnight', () => {
    const daily = patternOf('reset-traffic-daily')!.split(' ');
    const rolling = patternOf('reset-traffic-monthly-rolling')!.split(' ');
    const weekly = patternOf('reset-traffic-weekly')!.split(' ');
    const monthly = patternOf('reset-traffic-monthly')!.split(' ');

    for (const [name, p] of [['daily', daily], ['rolling', rolling], ['weekly', weekly], ['monthly', monthly]] as const) {
      expect(Number(p[1]), `${name} reset must run at midnight hour`).toBe(0);
    }
    const minutes = [daily, rolling, weekly, monthly].map((p) => Number(p[0]));
    expect(new Set(minutes).size, 'two resets share a minute and would contend').toBe(4);

    // And each keeps its own calendar: weekly on a weekday, monthly on a date.
    expect(weekly[4], 'the weekly reset must pin a day of week').not.toBe('*');
    expect(monthly[2], 'the monthly reset must pin a day of month').not.toBe('*');
    expect(daily[2]).toBe('*');
    expect(daily[4]).toBe('*');
  });
});
