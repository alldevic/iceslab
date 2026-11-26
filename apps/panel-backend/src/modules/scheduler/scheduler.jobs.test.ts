// The table of cron jobs, and the switch that runs them.
//
// `scheduler.register.test.ts` covers how registration replaces and removes
// schedules. What nothing covered is the pair the whole subsystem rests on: a
// name in CRON_JOBS and a `case` in the worker. Deleting `prune-history` from
// the table left the suite green, and retention then never runs; slowing the
// fifteen-second metrics poll to a daily one did too.
//
// The two directions fail differently, and only one of them is loud:
//
//   * a table entry with no `case` reaches the worker's `default`, which throws
//     `Unknown cron job`: the job fails, visibly, every tick;
//   * a `case` with no table entry is SILENT. The handler reads correctly and
//     nobody ever schedules it.
//
// Neither list is exported, so both are read out of the source (the same
// instrument webhook.events.test.ts uses): a list copied into a test goes stale.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { afterAll, describe, expect, it } from 'vitest';
import { cronTasksQueue, registerCronJobs } from './scheduler.queue.js';
import { closeRedis, queueRedis } from '../../lib/infra/redis.js';

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
  return [...SOURCE.slice(start).matchAll(/^\s*case '([a-z0-9-]+)': \{?$/gm)].map((m) => m[1]!);
}

afterAll(async () => {
  await cronTasksQueue.close();
  await closeRedis();
});

describe('every job is both scheduled and handled', () => {
  it('reads both lists out of the source at all', () => {
    // A parser that quietly matched nothing would make the comparisons below
    // pass by vacuum. The table holds 15 jobs at the time of writing.
    expect(tableEntries().length).toBeGreaterThanOrEqual(15);
    expect(handledNames().length).toBeGreaterThanOrEqual(15);
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

  it('names each job once, in both lists', () => {
    for (const names of [tableEntries().map((j) => j.name), handledNames()]) {
      expect(new Set(names).size, `duplicate name: ${names.join(', ')}`).toBe(names.length);
    }
  });
});

describe('the patterns are ones the scheduler will take', () => {
  // Asked of BullMQ rather than of a cron library of our choosing: BullMQ parses
  // these at startup, and a pattern it rejects takes the whole registration
  // down. Goes through the real registerCronJobs on a queue of its own, so the
  // live cron-tasks schedule is not touched.
  it('registers every pattern in the table, and the queue holds exactly that', async () => {
    const queue = new Queue(`cron-jobs-test-${randomUUID()}`, { connection: queueRedis });
    try {
      const table = tableEntries();
      await registerCronJobs(queue, table);

      const held = (await queue.getJobSchedulers()).map((s) => ({ name: s.key, pattern: s.pattern }));
      const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
      expect(held.sort(byName)).toEqual([...table].sort(byName));
    } finally {
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    }
  });
});

describe('the cadences that carry a reason', () => {
  const patternOf = (name: string): string => {
    const found = tableEntries().find((j) => j.name === name);
    expect(found, `${name} is not in CRON_JOBS`).toBeTruthy();
    return found!.pattern;
  };

  // Sub-minute polls are what make a node's liveness, and so every
  // subscription's contents, current rather than historical. A six-field
  // pattern has a seconds field; losing it makes the job run 60x less often.
  it('polls the fleet and the review jobs in seconds, not minutes', () => {
    expect(patternOf('review-find-expired')).toBe('*/30 * * * * *');
    expect(patternOf('review-find-exceeded-traffic')).toBe('*/45 * * * * *');
    expect(patternOf('node-healthcheck-poll')).toBe('*/30 * * * * *');
    expect(patternOf('node-metrics-poll')).toBe('*/15 * * * * *');
    expect(patternOf('node-stats-poll')).toBe('*/30 * * * * *');
    for (const name of [
      'review-find-expired',
      'review-find-exceeded-traffic',
      'node-healthcheck-poll',
      'node-metrics-poll',
      'node-stats-poll',
    ]) {
      expect(patternOf(name).split(' '), `${name} lost its seconds field`).toHaveLength(6);
    }
  });

  it('runs the catch-up and refresh jobs every ten minutes, and the node checks hourly', () => {
    expect(patternOf('reconcile-orphan-users')).toBe('*/10 * * * *');
    expect(patternOf('geo-url-refresh')).toBe('*/10 * * * *');
    expect(patternOf('node-cert-renew')).toBe('20 * * * *');
    expect(patternOf('node-drawing-check')).toBe('40 * * * *');
  });

  // Retention is the only job that DELETES. It has to be scheduled at all, and
  // off-peak, because it walks the history tables.
  it('prunes history once a day, in the small hours', () => {
    const [minute, hour, dom, month, dow] = patternOf('prune-history').split(' ');
    expect([dom, month, dow], 'prune-history must run every day').toEqual(['*', '*', '*']);
    expect(Number(hour), 'a table-walking delete belongs off-peak').toBeLessThan(6);
    expect(Number.isNaN(Number(minute))).toBe(false);
  });

  it('sends the near-expiry digest once a day', () => {
    const [minute, hour, dom, month, dow] = patternOf('alert-near-expiry').split(' ');
    expect([dom, month, dow]).toEqual(['*', '*', '*']);
    expect(Number.isNaN(Number(minute)) || Number.isNaN(Number(hour))).toBe(false);
  });

  // The traffic resets are what a customer's quota depends on. Each runs on its
  // own strategy date and they are staggered by five minutes just after
  // midnight so they never contend for the same rows.
  it('staggers the traffic resets just after midnight', () => {
    const daily = patternOf('reset-traffic-daily').split(' ');
    const rolling = patternOf('reset-traffic-monthly-rolling').split(' ');
    const weekly = patternOf('reset-traffic-weekly').split(' ');
    const monthly = patternOf('reset-traffic-monthly').split(' ');

    for (const [name, p] of [['daily', daily], ['rolling', rolling], ['weekly', weekly], ['monthly', monthly]] as const) {
      expect(Number(p[1]), `${name} reset must run at midnight hour`).toBe(0);
    }
    const minutes = [daily, rolling, weekly, monthly].map((p) => Number(p[0]));
    expect(new Set(minutes).size, 'two resets share a minute and would contend').toBe(4);

    expect(weekly[4], 'the weekly reset must pin a day of week').not.toBe('*');
    expect(monthly[2], 'the monthly reset must pin a day of month').not.toBe('*');
    expect(daily[2]).toBe('*');
    expect(daily[4]).toBe('*');
  });
});
