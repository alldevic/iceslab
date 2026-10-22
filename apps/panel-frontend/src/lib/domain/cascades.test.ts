import { describe, expect, it } from 'vitest';
import { cascadeDeleteRefusal, cascadeShapeError } from '@/lib/domain/cascades';

const res = (status: number, data: unknown) => ({ response: { status, data } });

describe('cascadeShapeError: вход проверяется первым (spec frontend-cascades)', () => {
  it('400 с фразой сервера: фраза', () => {
    expect(cascadeShapeError(res(400, { error: 'INVALID', message: 'direction "DE" has no nodes' }))).toBe(
      'direction "DE" has no nodes',
    );
  });

  it('мусор, null и чужие ответы: null, без исключения', () => {
    for (const e of [
      null,
      undefined,
      'x',
      42,
      new Error('x'),
      { response: null },
      { response: 'x' },
      res(400, null),
      res(400, 'text'),
      res(400, { message: 42 }),
      res(400, { message: '' }),
      res(409, { message: 'conflict' }),
    ]) {
      expect(cascadeShapeError(e)).toBeNull();
    }
  });
});

describe('cascadeDeleteRefusal', () => {
  it('404 NOT_FOUND: каскада уже нет', () => {
    expect(cascadeDeleteRefusal(res(404, { error: 'NOT_FOUND', message: 'Cascade x not found' }))).toEqual({
      kind: 'gone',
    });
  });

  it('другой 4xx с фразой: словами сервера и кодом', () => {
    expect(cascadeDeleteRefusal(res(409, { error: 'IN_USE', message: 'squad "A" points at it' }))).toEqual({
      kind: 'refused',
      code: 'IN_USE',
      message: 'squad "A" points at it',
    });
    expect(cascadeDeleteRefusal(res(400, { message: 'bad id' }))).toEqual({ kind: 'refused', code: '', message: 'bad id' });
  });

  it('сеть, 5xx, 4xx без фразы, мусор: null, остаётся тостом', () => {
    for (const e of [
      null,
      'x',
      new Error('Network Error'),
      { response: undefined },
      res(500, { error: 'INTERNAL', message: 'boom' }),
      res(409, { error: 'IN_USE' }),
      res(404, { error: 'OTHER' }),
      res(404, null),
    ]) {
      expect(cascadeDeleteRefusal(e)).toBeNull();
    }
  });
});
