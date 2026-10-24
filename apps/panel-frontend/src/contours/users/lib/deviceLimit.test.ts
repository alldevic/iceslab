import { describe, expect, it } from 'vitest';
import { deviceLimitCell, deviceListView, effectiveDeviceCap } from '@/contours/users/lib/deviceLimit';
import { USER_COLUMN_BY_ID } from '@/contours/users/lib/usersTable';
import { users as ru } from '@/i18n/locales/ru/users';
import { loadFailure } from '@/lib/ui/loadView';

describe('deviceListView (A-254): список устройств не пришёл', () => {
  const say = (err: unknown) => (err as Error).message;
  const q = (data: { devices: unknown[] } | undefined, error: Error | null = null) => ({
    data,
    isError: error !== null,
    error,
    refetch: () => undefined,
  });
  const failureOf = (x: Parameters<typeof loadFailure>[0]) => loadFailure(x, say);
  it('сбой это «-» в счётчике и слова сервера с повтором, а не 0 из N', () => {
    const v = deviceListView(q(undefined, new Error('db down')), failureOf);
    expect(v.used).toBeNull();
    expect(v.failure?.message).toBe('db down');
    expect(typeof v.failure?.onRetry).toBe('function');
  });
  it('в пути «-» без сбоя; пришёл пустым это 0', () => {
    expect(deviceListView(q(undefined), failureOf)).toEqual({ used: null, failure: null });
    expect(deviceListView(q({ devices: [] }), failureOf)).toEqual({ used: 0, failure: null });
    expect(deviceListView(q({ devices: [1, 2] }), failureOf).used).toBe(2);
  });
});

describe('effectiveDeviceCap (A-148), как effectiveHwidLimit сервера', () => {
  it('0: явно без лимита, поверх сквада', () => {
    expect(effectiveDeviceCap(0, [3])).toEqual({ kind: 'none', from: 'user' });
    expect(effectiveDeviceCap(0, null)).toEqual({ kind: 'none', from: 'user' });
  });

  it('N: свой лимит, сквад не спрашивается', () => {
    expect(effectiveDeviceCap(2, [5])).toEqual({ kind: 'limit', limit: 2, from: 'user' });
    expect(effectiveDeviceCap(2, null)).toEqual({ kind: 'limit', limit: 2, from: 'user' });
  });

  it('пусто: как у сквада, наибольший положительный; ни один не задал: без лимита', () => {
    for (const own of ['', null, undefined] as const) {
      expect(effectiveDeviceCap(own, [3, null, 5, 0])).toEqual({ kind: 'limit', limit: 5, from: 'squad' });
      expect(effectiveDeviceCap(own, [null, 0])).toEqual({ kind: 'none', from: 'squad' });
      expect(effectiveDeviceCap(own, [])).toEqual({ kind: 'none', from: 'squad' });
    }
  });

  it('пусто и сквады не пришли: неизвестно, а не «без лимита»', () => {
    expect(effectiveDeviceCap('', null)).toEqual({ kind: 'unknown' });
  });
});

describe('deviceLimitCell: ячейка реестра', () => {
  it('N, 0 и пусто говорят разное', () => {
    expect(deviceLimitCell(3)).toEqual({ kind: 'limit', limit: 3 });
    expect(deviceLimitCell(0)).toEqual({ kind: 'none' });
    expect(deviceLimitCell(null)).toEqual({ kind: 'squad' });
    expect(deviceLimitCell(undefined)).toEqual({ kind: 'squad' });
  });
});

describe('фильтр deviceLimit (A-148, e5d4d75c)', () => {
  it('шлёт три значения сервера, unlimited среди них, и у каждого своя подпись', () => {
    const filter = USER_COLUMN_BY_ID.get('deviceLimit')?.filter;
    expect(filter).toMatchObject({ kind: 'choice', param: 'deviceLimit' });
    const values = filter && filter.kind === 'choice' ? filter.values : [];
    expect(values).toEqual(['set', 'unlimited', 'unset']);
    const labels = ru.usersTable.filterValue.deviceLimit as Record<string, string>;
    // unset это «как у сквада», а не «без лимита»: без лимита теперь только unlimited.
    expect(labels.unset).not.toMatch(/без лимита/i);
    for (const v of values) expect(labels[v]).toBeTruthy();
  });
});

describe('подсказка поля лимита (A-148)', () => {
  it('говорит три значения: пусто как у сквада, 0 без лимита; старое «пусто = без лимита» ушло', () => {
    const hint = ru.userDrawer.hwidHint;
    expect(hint).toMatch(/Пусто: как у сквада/);
    expect(hint).toMatch(/0: без лимита/);
    expect(hint).not.toMatch(/Пусто = без лимита/);
  });
});