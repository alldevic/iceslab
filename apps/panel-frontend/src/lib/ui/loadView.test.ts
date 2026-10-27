import { describe, expect, it } from 'vitest';
import { editGate, loadFailure, loadView } from '@/lib/ui/loadView';

describe('loadFailure (spec frontend-cascades)', () => {
  const say = (err: unknown) => `said: ${String((err as Error).message)}`;
  let retried = 0;
  const q = (data: unknown, isError: boolean) => ({
    data,
    isError,
    error: isError ? new Error('503') : null,
    refetch: () => {
      retried += 1;
    },
  });

  it('список не пришёл: слова и повтор', () => {
    const f = loadFailure(q(undefined, true), say);
    expect(f?.message).toBe('said: 503');
    f?.onRetry();
    expect(retried).toBe(1);
  });

  it('пришёл, ждём, или повтор упал поверх данных: null', () => {
    expect(loadFailure(q({ outbounds: [] }, false), say)).toBeNull();
    expect(loadFailure(q(undefined, false), say)).toBeNull();
    expect(loadFailure(q({ outbounds: [] }, true), say)).toBeNull();
  });
});

describe('editGate (A-141)', () => {
  const ok = { data: {}, isError: false };
  const failed = { data: undefined, isError: true };
  const pending = { data: undefined, isError: false };

  it('список пришёл, предмета нет: «нет такого»', () => {
    expect(editGate(ok, false, [ok])).toEqual({ kind: 'gone' });
  });
  it('список упал или идёт: не «нет такого»', () => {
    expect(editGate(failed, false)).toEqual({ kind: 'failed', index: 0 });
    expect(editGate(pending, false)).toEqual({ kind: 'loading' });
  });
  it('предмет есть, побочный список упал: ошибка этого списка, а не «каскад удалён»', () => {
    expect(editGate(ok, true, [ok, failed])).toEqual({ kind: 'failed', index: 2 });
  });
  it('предмет есть, побочный идёт: загрузка; всё пришло: готово', () => {
    expect(editGate(ok, true, [pending])).toEqual({ kind: 'loading' });
    expect(editGate(ok, true, [ok])).toEqual({ kind: 'ready' });
  });
});

describe('loadView (A-141)', () => {
  it('нет данных и запрос упал: ошибка, а не вечная загрузка', () => {
    expect(loadView({ data: undefined, isError: true })).toBe('failed');
  });
  it('нет данных и запрос идёт: загрузка', () => {
    expect(loadView({ data: undefined, isError: false })).toBe('loading');
  });
  it('данные есть: экран, даже если повторный запрос упал', () => {
    expect(loadView({ data: {}, isError: true })).toBe('ready');
    expect(loadView({ data: [], isError: false })).toBe('ready');
  });
});
