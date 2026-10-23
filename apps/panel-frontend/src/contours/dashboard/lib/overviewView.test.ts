import { describe, expect, it } from 'vitest';
import { overviewView, usageFill } from '@/contours/dashboard/lib/overviewView';

describe('overviewView (A-242)', () => {
  it('до первого ответа: загрузка или сбой на весь экран', () => {
    expect(overviewView({ data: undefined, isError: false, dataUpdatedAt: 0 })).toEqual({ kind: 'loading' });
    expect(overviewView({ data: undefined, isError: true, dataUpdatedAt: 0 })).toEqual({ kind: 'failed' });
  });

  it('упавший опрос при пришедших данных оставляет экран и метит «не обновилось» со временем ответа', () => {
    const at = Date.parse('2026-10-23T10:00:00Z');
    expect(overviewView({ data: { users: {} }, isError: true, dataUpdatedAt: at })).toEqual({
      kind: 'ready',
      stale: true,
      updatedAt: '2026-10-23T10:00:00.000Z',
    });
    expect(overviewView({ data: { users: {} }, isError: false, dataUpdatedAt: at })).toMatchObject({ kind: 'ready', stale: false });
  });
});

describe('usageFill (A-242, k)', () => {
  it('нет значения: пустая полоса (null), а не 0 %', () => {
    expect(usageFill(undefined)).toBeNull();
    expect(usageFill(null)).toBeNull();
    expect(usageFill(Number.NaN)).toBeNull();
  });

  it('значение обрезается в 0..100, ноль остаётся нулём', () => {
    expect(usageFill(0)).toBe(0);
    expect(usageFill(42.4)).toBe(42.4);
    expect(usageFill(140)).toBe(100);
  });
});
