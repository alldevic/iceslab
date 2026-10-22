import { describe, expect, it } from 'vitest';
import { loadView } from '@/lib/ui/loadView';

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
