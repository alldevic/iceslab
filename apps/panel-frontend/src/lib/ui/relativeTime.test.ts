import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { relativeTime } from '@/lib/ui/relativeTime';

const t = (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${String(opts.n)}` : key);

describe('relativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-24T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('null это «никогда»: сервер сказал, что события не было', () => {
    expect(relativeTime(null, t)).toEqual({ text: 'userTime.never', tone: 'never' });
  });

  it('неразборчивая строка это «-», а не «NaN назад»', () => {
    expect(relativeTime('вчера', t)).toEqual({ text: '-', tone: 'unknown' });
    expect(relativeTime('', t)).toEqual({ text: '-', tone: 'unknown' });
  });

  it('время впереди часов это «0 с назад», а не отрицательное число', () => {
    expect(relativeTime('2026-10-24T12:03:00Z', t)).toEqual({ text: 'userTime.sAgo:0', tone: 'fresh' });
  });

  it('прошлое считается вниз по ступеням', () => {
    expect(relativeTime('2026-10-24T11:59:30Z', t).text).toBe('userTime.sAgo:30');
    expect(relativeTime('2026-10-24T11:30:00Z', t).text).toBe('userTime.mAgo:30');
    expect(relativeTime('2026-10-24T09:00:00Z', t).text).toBe('userTime.hAgo:3');
    expect(relativeTime('2026-10-21T12:00:00Z', t)).toEqual({ text: 'userTime.dAgo:3', tone: 'stale' });
  });
});
