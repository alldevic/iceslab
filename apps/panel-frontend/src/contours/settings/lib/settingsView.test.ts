import { describe, expect, it } from 'vitest';
import { brandNameSave, listState } from '@/contours/settings/lib/settingsView';

describe('brandNameSave (A-237)', () => {
  it('сбой /settings: сохранять нечего, «Iceslab» не уходит', () => {
    expect(brandNameSave(undefined, '')).toBeNull();
    expect(brandNameSave(undefined, 'Мой VPN')).toBeNull();
  });

  it('до засева поля: тоже нечего', () => {
    expect(brandNameSave({ brandName: 'Мой VPN' }, null)).toBeNull();
  });

  it('пустое поле отказывает словами, а не подменяется на «Iceslab»', () => {
    expect(brandNameSave({ brandName: 'Мой VPN' }, '')).toEqual({ error: 'empty' });
    expect(brandNameSave({ brandName: 'Мой VPN' }, '   ')).toEqual({ error: 'empty' });
  });

  it('с ответом и названием: обрезанное название', () => {
    expect(brandNameSave({ brandName: 'Мой VPN' }, '  Новый  ')).toEqual({ write: { brandName: 'Новый' } });
  });
});

describe('listState (A-241)', () => {
  it('«нет» только у пришедшего пустого списка', () => {
    expect(listState({ data: { regions: [] }, isError: false }, 0)).toBe('empty');
    expect(listState({ data: { regions: [1] }, isError: false }, 1)).toBe('list');
  });

  it('сбой это сбой, ожидание это ожидание, а не «нет»', () => {
    expect(listState({ data: undefined, isError: true }, 0)).toBe('failed');
    expect(listState({ data: undefined, isError: false }, 0)).toBe('loading');
  });
});
