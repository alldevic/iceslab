import { describe, expect, it } from 'vitest';
import { endpointsWhy } from '@/contours/users/lib/endpointsWhy';

describe('endpointsWhy (A-141)', () => {
  it('есть строки: показывать их', () => {
    expect(endpointsWhy({ data: { endpoints: [{}] }, isError: false, error: null })).toBeNull();
  });
  it('пустой ответ: пусто', () => {
    expect(endpointsWhy({ data: { endpoints: [] }, isError: false, error: null })).toBe('empty');
  });
  it('403: отказ подписки, а не ошибка', () => {
    expect(endpointsWhy({ isError: true, error: { response: { status: 403 } } })).toBe('refused');
  });
  it('другая ошибка: список неизвестен, а не пуст', () => {
    expect(endpointsWhy({ isError: true, error: { response: { status: 500 } } })).toBe('failed');
    expect(endpointsWhy({ isError: true, error: new Error('Network Error') })).toBe('failed');
    expect(endpointsWhy({ isError: true, error: null })).toBe('failed');
  });
  it('ответа нет: загрузка', () => {
    expect(endpointsWhy({ isError: false, error: null })).toBe('loading');
  });
});
