import { describe, expect, it } from 'vitest';
import { conflictField } from '@/lib/domain/conflictField';

const r = (status: number, data: unknown) => ({ response: { status, data } });

describe('conflictField (хвост A-257): 409 у своего поля', () => {
  it('регион: name и code у своего поля словами сервера', () => {
    expect(conflictField(r(409, { error: 'CONFLICT', field: 'code', message: 'Region code "EU" is already taken' }), ['name', 'code'])).toEqual({
      field: 'code',
      message: 'Region code "EU" is already taken',
    });
    expect(conflictField(r(409, { error: 'CONFLICT', field: 'name', message: 'taken' }), ['name', 'code'])?.field).toBe('name');
  });

  it('политика входа: name и ordinal', () => {
    expect(conflictField(r(409, { error: 'CONFLICT', field: 'ordinal', message: 'band taken' }), ['name', 'ordinal'])?.field).toBe('ordinal');
  });

  it('старый сервер без field, чужое поле, другой статус или код: null, экран говорит как раньше', () => {
    expect(conflictField(r(409, { error: 'CONFLICT', message: 'name or code taken' }), ['name', 'code'])).toBeNull();
    expect(conflictField(r(409, { error: 'CONFLICT', field: 'address', message: 'x' }), ['name', 'code'])).toBeNull();
    expect(conflictField(r(400, { error: 'CONFLICT', field: 'name', message: 'x' }), ['name', 'code'])).toBeNull();
    expect(conflictField(r(409, { error: 'NOT_FOUND', field: 'name' }), ['name', 'code'])).toBeNull();
    expect(conflictField(null, ['name'])).toBeNull();
  });
});
