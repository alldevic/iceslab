import { describe, it, expect } from 'vitest';
import { ONLINE_WINDOW_MS, isOnlineAt } from '@iceslab/shared';

/**
 * The panel answers "is this user online" in three places: the dashboard
 * counter, the dot in the roster and the freshness colour on the last-seen
 * column. Until 2026-07-31 the first used a 3-minute window and the other two
 * used 5, so a user last seen four minutes ago was online in the list and
 * missing from "Online now" on the same screen.
 *
 * These pin the one window they now share. A future caller that wants a
 * different cutoff should have to change this file first.
 */
describe('presence window', () => {
  const now = Date.UTC(2026, 6, 31, 12, 0, 0);
  const agoMs = (ms: number) => new Date(now - ms);

  it('is five minutes', () => {
    expect(ONLINE_WINDOW_MS).toBe(5 * 60 * 1000);
  });

  it('counts a user seen inside the window', () => {
    expect(isOnlineAt(agoMs(4 * 60 * 1000), now)).toBe(true);
  });

  it('drops a user seen past it', () => {
    expect(isOnlineAt(agoMs(6 * 60 * 1000), now)).toBe(false);
  });

  it('treats the boundary as offline, so the two ends agree exactly', () => {
    expect(isOnlineAt(agoMs(ONLINE_WINDOW_MS), now)).toBe(false);
    expect(isOnlineAt(agoMs(ONLINE_WINDOW_MS - 1), now)).toBe(true);
  });

  it('reads an ISO string the same as a Date, since the API sends strings', () => {
    const seen = agoMs(60 * 1000);
    expect(isOnlineAt(seen.toISOString(), now)).toBe(isOnlineAt(seen, now));
  });

  it('never online is offline, not an error', () => {
    expect(isOnlineAt(null, now)).toBe(false);
    expect(isOnlineAt(undefined, now)).toBe(false);
  });

  it('an unparseable timestamp is offline rather than NaN-true', () => {
    expect(isOnlineAt('not a date', now)).toBe(false);
  });
});
