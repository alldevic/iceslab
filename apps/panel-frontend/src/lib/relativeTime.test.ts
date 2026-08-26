import { afterEach, describe, expect, it, vi } from 'vitest';
import { ONLINE_WINDOW_MS } from '@iceslab/shared';
import { relativeTime } from './relativeTime';

/**
 * Two things live in this one function, and both were bugs before it existed.
 *
 * The FLOOR: rounding used to put the words ahead of the threshold they sit
 * next to. At 4m50s the text already read "5m ago" while the presence dot was
 * still filled, and at 5m00s the same words sat beside a hollow one — identical
 * wording on opposite sides of the line, which reads as a broken dot rather
 * than as a rounding rule. It also printed half an hour as "1h ago".
 *
 * The TONE: `fresh` is the same window the presence dot and the dashboard's
 * "online now" use, so none of the three can disagree about the same user. It
 * is derived here rather than recomputed by each caller precisely so that they
 * cannot.
 *
 * Time is frozen with fake timers: a test that read the real clock would be
 * asserting on the gap between two `Date.now()` calls.
 */

/** Records the key and its count instead of translating, so the case reads as
 *  "which unit, how many" rather than as a sentence in one language. */
const t = (key: string, opts?: Record<string, unknown>) =>
  opts && 'n' in opts ? `${key}:${opts.n as number}` : key;

const NOW = new Date('2026-08-26T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

afterEach(() => {
  vi.useRealTimers();
});

function at(iso: string | null) {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  return relativeTime(iso, t);
}

describe('relativeTime', () => {
  it('says never for a user who has never been online', () => {
    const got = at(null);
    expect(got.text).toBe('userTime.never');
    // `never` is its own tone: a caller colouring on presence must not paint it
    // the same as somebody who was here yesterday.
    expect(got.tone).toBe('never');
  });

  it('floors at every step rather than rounding', () => {
    // The regression, one case per boundary that used to round upward.
    expect(at(ago(50_000)).text).toBe('userTime.sAgo:50');
    expect(at(ago(59_999)).text).toBe('userTime.sAgo:59');
    expect(at(ago(60_000)).text).toBe('userTime.mAgo:1');
    expect(at(ago(4 * 60_000 + 50_000)).text).toBe('userTime.mAgo:4'); // was "5m"
    expect(at(ago(30 * 60_000)).text).toBe('userTime.mAgo:30'); // was "1h"
    expect(at(ago(59 * 60_000 + 59_000)).text).toBe('userTime.mAgo:59');
    expect(at(ago(60 * 60_000)).text).toBe('userTime.hAgo:1');
    expect(at(ago(23 * 3600_000 + 59 * 60_000)).text).toBe('userTime.hAgo:23');
    expect(at(ago(24 * 3600_000)).text).toBe('userTime.dAgo:1');
    expect(at(ago(9 * 24 * 3600_000)).text).toBe('userTime.dAgo:9');
  });

  it('flips tone exactly at the shared online window, not near it', () => {
    // One millisecond either side. The dot and the dashboard read the same
    // constant, so a boundary that drifts here makes two of the three disagree
    // about one user — which is what a broken presence indicator looks like.
    expect(at(ago(ONLINE_WINDOW_MS - 1)).tone).toBe('fresh');
    expect(at(ago(ONLINE_WINDOW_MS)).tone).toBe('stale');
    expect(at(ago(ONLINE_WINDOW_MS + 1)).tone).toBe('stale');
  });

  it('keeps the words and the tone independent', () => {
    // The control on the case above: a timestamp inside the window still gets
    // whatever unit the elapsed time deserves. Tying the two together — "fresh
    // means seconds" — would look right until the window is next changed.
    const inside = at(ago(ONLINE_WINDOW_MS - 1));
    expect(inside.tone).toBe('fresh');
    expect(inside.text).not.toBe('userTime.never');
  });
});
