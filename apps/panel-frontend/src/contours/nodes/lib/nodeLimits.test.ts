import { describe, expect, it } from 'vitest';
import { multiplierBadge, multiplierInput, parseMaxUsers, parseMultiplier } from '@/contours/nodes/lib/nodeLimits';
import { nodes as ru } from '@/i18n/locales/ru/nodes';

describe('parseMultiplier (A-143)', () => {
  it('0, 0,5, «0.5», 100 и пусто (1 по умолчанию) принимаются', () => {
    expect(parseMultiplier('0')).toEqual({ ok: true, value: 0 });
    expect(parseMultiplier('0,5')).toEqual({ ok: true, value: 0.5 });
    expect(parseMultiplier('0.5')).toEqual({ ok: true, value: 0.5 });
    expect(parseMultiplier('100')).toEqual({ ok: true, value: 100 });
    expect(parseMultiplier('')).toEqual({ ok: true, value: 1 });
    expect(parseMultiplier(' 2 ')).toEqual({ ok: true, value: 2 });
  });

  it('100,1, 1,25 и прочее отказывают, а не округляются', () => {
    for (const s of ['100,1', '1,25', '1.25', '-1', 'abc', '1,', ',5', '1000', '1e1']) {
      expect(parseMultiplier(s)).toEqual({ ok: false });
    }
  });
});

describe('parseMaxUsers (A-143)', () => {
  it('пусто: без потолка; целое от 1', () => {
    expect(parseMaxUsers('')).toEqual({ ok: true, value: null });
    expect(parseMaxUsers('1')).toEqual({ ok: true, value: 1 });
    expect(parseMaxUsers(500)).toEqual({ ok: true, value: 500 });
  });

  it('0, дробь и мусор отказывают', () => {
    for (const s of ['0', '1,5', '-3', 'x']) expect(parseMaxUsers(s)).toEqual({ ok: false });
  });
});

describe('множитель на форме и на карточке', () => {
  it('хранимое в поле: число и строка старого сервера, запятая по языку', () => {
    expect(multiplierInput(0.5, true)).toBe('0,5');
    expect(multiplierInput('0.50', false)).toBe('0.5');
    expect(multiplierInput(1, true)).toBe('1');
    expect(multiplierInput(undefined, true)).toBe('1');
  });

  it('значок: 1 и неизвестное молчат, 0 «бесплатно», иначе ×N', () => {
    expect(multiplierBadge(1)).toBeNull();
    expect(multiplierBadge('1.0')).toBeNull();
    expect(multiplierBadge(undefined)).toBeNull();
    expect(multiplierBadge('')).toBeNull();
    expect(multiplierBadge(0)).toEqual({ kind: 'free' });
    expect(multiplierBadge('0.5')).toEqual({ kind: 'times', value: 0.5 });
    expect(multiplierBadge(2)).toEqual({ kind: 'times', value: 2 });
  });
});

describe('слова у поля (A-143)', () => {
  it('поле, подсказка и отказ по решению ARCH', () => {
    expect(ru.nodeEdit.multiplier).toBe('Множитель потребления');
    expect(ru.nodeEdit.multiplierDesc).toMatch(/0: нода бесплатна/);
    expect(ru.nodeEdit.multiplierBad).toBe('Множитель от 0 до 100 с шагом 0,1');
    expect(ru.nodeEdit.maxUsers).toBe('Потолок юзеров');
    expect(ru.nodeEdit.maxUsersDesc).toBe('Пусто: без потолка. Иначе целое число от 1');
  });
});
