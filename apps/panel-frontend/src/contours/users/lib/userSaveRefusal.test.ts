import { describe, expect, it } from 'vitest';
import { userSaveRefusal } from '@/contours/users/lib/userSaveRefusal';

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

  it('409 CONFLICT и 404: словами сервера у формы', () => {
    expect(userSaveRefusal(res(409, { error: 'CONFLICT', message: 'User "alice" already exists' }))).toEqual({
      fields: {},
      message: 'User "alice" already exists',
    });
    expect(userSaveRefusal(res(404, { error: 'NOT_FOUND', message: 'user not found' }))?.message).toBe('user not found');
  });

  it('сеть, 5xx, мусор, 4xx без слов: null', () => {
    for (const e of [null, 'x', new Error('Network Error'), { response: null }, res(500, { message: 'boom' }), res(409, { error: 'CONFLICT' }), res(400, null)]) {
      expect(userSaveRefusal(e)).toBeNull();
    }
  });
});
