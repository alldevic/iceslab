import { describe, expect, it } from 'vitest';
import { staleScheduleIds } from './scheduler.queue.js';

/**
 * Changing a cron pattern used to leave the old schedule running next to the
 * new one. Found on the lab panel, not by reading: it was carrying
 * `remnawave-expiry-notify` on both the hourly pattern and the ten-minute one,
 * and `geo-rebuild` on two patterns while `GEO_SELF_HOST=false` meant the code
 * was not registering it at all.
 *
 * Pure on purpose. The queue this reasons about is shared with a running panel,
 * and a test that removed schedules from it would take the panel's crons with
 * them - the same trap as the shared Redis in the facade tests.
 */

const desired = [
  { name: 'review-find-expired', pattern: '*/30 * * * * *' },
  { name: 'remnawave-expiry-notify', pattern: '*/10 * * * *' },
];

describe('staleScheduleIds', () => {
  it('drops the old pattern when a job keeps its name', () => {
    const stale = staleScheduleIds(
      [
        { key: 'old', name: 'remnawave-expiry-notify', pattern: '5 * * * *' },
        { key: 'new', name: 'remnawave-expiry-notify', pattern: '*/10 * * * *' },
      ],
      desired,
    );
    expect(stale).toEqual(['old']);
  });

  it('drops a job that is no longer in the list at all', () => {
    // The sharp case: nothing handles it any more, and it fires forever.
    const stale = staleScheduleIds(
      [{ key: 'gone', name: 'geo-rebuild', pattern: '40 * * * *' }],
      desired,
    );
    expect(stale).toEqual(['gone']);
  });

  it('keeps every schedule that matches the list exactly', () => {
    const stale = staleScheduleIds(
      [
        { key: 'a', name: 'review-find-expired', pattern: '*/30 * * * * *' },
        { key: 'b', name: 'remnawave-expiry-notify', pattern: '*/10 * * * *' },
      ],
      desired,
    );
    expect(stale).toEqual([]);
  });

  it('does not confuse a name with a pattern', () => {
    // A crude `${name}${pattern}` key would let one job's name plus another's
    // pattern collide into a match. The separator is what prevents it.
    const stale = staleScheduleIds(
      [{ key: 'x', name: 'remnawave-expiry-notify*/10 * * * *', pattern: '' }],
      desired,
    );
    expect(stale).toEqual(['x']);
  });

  it('ignores an entry with no id, having nothing to remove it by', () => {
    expect(staleScheduleIds([{ name: 'whatever', pattern: '* * * * *' }], desired)).toEqual([]);
  });
});
