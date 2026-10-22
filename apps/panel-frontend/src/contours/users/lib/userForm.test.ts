import { describe, expect, it } from 'vitest';
import { defaultValues, trafficLimitInput, trafficLimitProblem, userUpdatePatch } from '@/contours/users/lib/userForm';
import type { User } from '@/lib/domain/users';

describe('A-142: лимит 0 не становится безлимитом', () => {
  it('0 называется ошибкой поля, пустое и целое от 1 проходят', () => {
    expect(trafficLimitProblem(0)).toBe('zero');
    expect(trafficLimitProblem('')).toBeNull();
    expect(trafficLimitProblem(1)).toBeNull();
    expect(trafficLimitProblem(500)).toBeNull();
  });

  it('пустое поле уходит null (без лимита), число уходит как есть', () => {
    expect(trafficLimitInput('')).toBeNull();
    expect(trafficLimitInput(50)).toBe(50);
  });
});

describe('userUpdatePatch: PUT дровера несёт только изменённое (spec frontend-users)', () => {
  const user = {
    username: 'alice',
    status: 'disabled',
    trafficLimitBytes: 10 * 1_073_741_824,
    trafficLimitStrategy: 'month',
    description: 'old',
    tag: 'vip',
    email: '',
    telegramId: '42',
    hwidDeviceLimit: 3,
    groupIds: ['g1', 'g2'],
    routingPreset: null,
  } as unknown as User;

  it('бот включил и продлил юзера при открытом дровере; в дровере правят только описание: уходит только description', () => {
    const seed = defaultValues(user);
    const values = { ...seed, description: 'renewed by hand' };
    expect(userUpdatePatch(seed, values, null)).toEqual({ description: 'renewed by hand' });
  });

  it('ничего не тронуто: тело пустое; сквады в другом порядке это то же множество', () => {
    const seed = defaultValues(user);
    expect(userUpdatePatch(seed, { ...seed, groupIds: ['g2', 'g1'] }, null)).toEqual({});
  });

  it('каждое поле уходит только своей правкой, очистка текста уходит null', () => {
    const seed = defaultValues(user);
    const at = new Date('2026-12-01T00:00:00Z');
    expect(
      userUpdatePatch(
        seed,
        { ...seed, status: 'active', trafficLimitGb: '', tag: '', groupIds: ['g1'], expirySet: true, expireDays: 30 },
        at,
      ),
    ).toEqual({ status: 'active', trafficLimitGb: null, tag: null, groupIds: ['g1'], expireAt: at.toISOString() });
  });
});
