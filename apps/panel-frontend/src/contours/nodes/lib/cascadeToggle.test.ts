import { describe, expect, it } from 'vitest';
import { cascadeToggleRefusal } from '@/contours/nodes/lib/cascadeToggle';

const res = (status: number, data: unknown) => ({ response: { status, data } });

describe('cascadeToggleRefusal (A-126)', () => {
  it('400 INVALID: слова сервера и код', () => {
    expect(cascadeToggleRefusal(res(400, { error: 'INVALID', message: 'Node "se-01" was deleted' }))).toEqual({
      code: 'INVALID',
      message: 'Node "se-01" was deleted',
    });
  });

  it('любой код ворот с текстом тоже отказ словами', () => {
    expect(cascadeToggleRefusal(res(409, { error: 'CELL_NOT_CARRIED', message: 'x' }))?.code).toBe('CELL_NOT_CARRIED');
    expect(cascadeToggleRefusal(res(400, { message: 'no code' }))).toEqual({ code: '', message: 'no code' });
  });

  it('вход проверяется первым: сеть, 5xx и тело без слов не отказ словами', () => {
    for (const e of [null, undefined, 'x', new Error('Network Error'), { response: null }]) {
      expect(cascadeToggleRefusal(e)).toBeNull();
    }
    expect(cascadeToggleRefusal(res(500, { error: 'INTERNAL', message: 'boom' }))).toBeNull();
    expect(cascadeToggleRefusal(res(400, { error: 'INVALID' }))).toBeNull();
    expect(cascadeToggleRefusal(res(400, 'text'))).toBeNull();
  });
});
