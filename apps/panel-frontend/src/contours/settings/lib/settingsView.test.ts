import { describe, expect, it } from 'vitest';
import { brandNameFieldError, brandNameSave, listState, regionNodeWords } from '@/contours/settings/lib/settingsView';

describe('regionNodeWords (A-256): число нод региона без ответа это не 0', () => {
  const t = (key: string, vars?: Record<string, unknown>) => `${key}${vars ? ' ' + JSON.stringify(vars) : ''}`;
  it('нет поля или не целое неотрицательное: строка «-», окно удаления «неизвестно», не «безопасно»', () => {
    for (const r of [{}, { nodeCount: '2' }, { nodeCount: -1 }, { nodeCount: 1.5 }]) {
      expect(regionNodeWords(r, t)).toEqual({ cell: '-', deleteBody: 'regions.deleteUnknownNodes' });
    }
  });
  it('ответ 0 это «безопасно», N это «потеряют привязку»', () => {
    expect(regionNodeWords({ nodeCount: 0 }, t)).toEqual({ cell: 'regions.nodesCount {"count":0}', deleteBody: 'regions.deleteSafe' });
    expect(regionNodeWords({ nodeCount: 3 }, t).deleteBody).toBe('regions.deleteWithNodes {"count":3}');
  });
});

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

describe('brandNameFieldError (хвост A-237)', () => {
  it('нетронутое пустое поле ошибку не показывает; стёртое показывает', () => {
    const empty = brandNameSave({ brandName: null }, '');
    expect(brandNameFieldError(empty, false)).toBeNull();
    expect(brandNameFieldError(empty, true)).toBe('empty');
  });

  it('с названием или без ответа ошибки нет', () => {
    expect(brandNameFieldError(brandNameSave({ brandName: 'x' }, 'x'), true)).toBeNull();
    expect(brandNameFieldError(brandNameSave(undefined, ''), true)).toBeNull();
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
