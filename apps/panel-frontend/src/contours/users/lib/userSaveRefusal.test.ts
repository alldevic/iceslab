import { describe, expect, it } from 'vitest';
import { saveToastNeeded, userSaveRefusal } from '@/contours/users/lib/userSaveRefusal';

const res = (status: number, data: unknown) => ({ response: { status, data } });

describe('userSaveRefusal (spec frontend-users)', () => {
  it('400 VALIDATION_ERROR: поле, которое назвал сервер, со своей фразой; безымянное у формы', () => {
    expect(
      userSaveRefusal(
        res(400, {
          error: 'VALIDATION_ERROR',
          message: 'Invalid input',
          issues: [
            { path: ['email'], message: 'Invalid email' },
            { path: ['expireAt'], message: 'Invalid date' },
            { path: ['somethingElse'], message: 'Bad' },
          ],
        }),
      ),
    ).toEqual({ fields: { email: 'Invalid email', expireDays: 'Invalid date' }, message: 'Bad' });
  });

  it('A-229: 400 ROUTING_PRESET_NOT_FOUND у выбора пресета; под другим статусом не он', () => {
    const say = (code: string) => `said ${code}`;
    expect(
      userSaveRefusal(res(400, { error: 'ROUTING_PRESET_NOT_FOUND', message: 'gone', field: 'customRoutingPresetId' }), say),
    ).toEqual({ fields: { routingPreset: 'said ROUTING_PRESET_NOT_FOUND' }, message: null });
    expect(userSaveRefusal(res(409, { error: 'ROUTING_PRESET_NOT_FOUND', message: 'odd' }), say)).toEqual({ fields: {}, message: 'odd' });
  });

  it('A-210: 409 USERNAME_TAKEN и SUBSCRIPTION_TOKEN_TAKEN у своего поля, словами панели', () => {
    const say = (code: string) => `said ${code}`;
    expect(
      userSaveRefusal(res(409, { error: 'USERNAME_TAKEN', message: 'User "alice" already exists', field: 'username' }), say),
    ).toEqual({ fields: { username: 'said USERNAME_TAKEN' }, message: null });
    expect(
      userSaveRefusal(res(409, { error: 'SUBSCRIPTION_TOKEN_TAKEN', message: 'taken', field: 'subscriptionToken' }), say),
    ).toEqual({ fields: { subscriptionToken: 'said SUBSCRIPTION_TOKEN_TAKEN' }, message: null });
    // Без `say` слова сервера, но у того же поля; поле берётся из кода, не из тела.
    expect(userSaveRefusal(res(409, { error: 'USERNAME_TAKEN', message: 'taken', field: 'email' }))).toEqual({
      fields: { username: 'taken' },
      message: null,
    });
  });

  it('неизвестный 409 (и CONFLICT старого сервера) и 404: словами сервера у формы', () => {
    expect(userSaveRefusal(res(409, { error: 'CONFLICT', message: 'User "alice" already exists' }))).toEqual({
      fields: {},
      message: 'User "alice" already exists',
    });
    expect(userSaveRefusal(res(409, { error: 'SOMETHING_NEW', message: 'other' }), () => 'x')).toEqual({
      fields: {},
      message: 'other',
    });
    expect(userSaveRefusal(res(409, { error: 'toString', message: 'proto' }), () => 'x')).toEqual({
      fields: {},
      message: 'proto',
    });
    expect(userSaveRefusal(res(404, { error: 'NOT_FOUND', message: 'user not found' }))?.message).toBe('user not found');
  });

  it('код занятости не с 409 не читается как занятость', () => {
    expect(userSaveRefusal(res(400, { error: 'USERNAME_TAKEN', message: 'odd' }), () => 'x')).toEqual({
      fields: {},
      message: 'odd',
    });
  });

  it('сеть, 5xx, мусор, 4xx без слов: null', () => {
    for (const e of [null, 'x', new Error('Network Error'), { response: null }, res(500, { message: 'boom' }), res(409, { error: 'CONFLICT' }), res(400, null)]) {
      expect(userSaveRefusal(e)).toBeNull();
    }
    expect(userSaveRefusal(res(409, { error: 'USERNAME_TAKEN' }))).toBeNull();
  });
});

describe('saveToastNeeded: один отказ, одно место (ARCH 23.10)', () => {
  it('отказ у поля тоста не даёт: занятое имя, токен, поле валидации', () => {
    expect(saveToastNeeded(res(409, { error: 'USERNAME_TAKEN', message: 'User "alice" already exists', field: 'username' }))).toBe(false);
    expect(saveToastNeeded(res(409, { error: 'SUBSCRIPTION_TOKEN_TAKEN', message: 'taken' }))).toBe(false);
    // Без фразы сервера дровер всё равно ставит слова панели у поля: тоста нет.
    expect(saveToastNeeded(res(409, { error: 'USERNAME_TAKEN' }))).toBe(false);
    expect(saveToastNeeded(res(400, { error: 'VALIDATION_ERROR', issues: [{ path: ['email'], message: 'Invalid email' }] }))).toBe(false);
  });

  it('отказ не у поля тост оставляет: у формы, сеть, 5xx', () => {
    for (const e of [res(409, { error: 'CONFLICT', message: 'x' }), res(404, { error: 'NOT_FOUND', message: 'gone' }), new Error('Network Error'), res(500, { message: 'boom' }), null]) {
      expect(saveToastNeeded(e)).toBe(true);
    }
  });
});