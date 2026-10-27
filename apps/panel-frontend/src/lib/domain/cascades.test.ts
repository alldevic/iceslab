import { describe, expect, it } from 'vitest';
import {
  cascadeDeleteRefusal,
  cascadeShapeError,
  cascadeToggleRefusal,
  nodeInOtherCascadeRefusal,
  nodeInOtherCascadeWords,
} from '@/lib/domain/cascades';

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

describe('nodeInOtherCascadeRefusal (A-101)', () => {
  const body = { error: 'NODE_IN_OTHER_CASCADE', message: 'Node "nl-exit" is already in ...', nodeName: 'nl-exit', cascadeId: 'c1', cascadeName: 'first' };

  it('409 с нодой и каскадом: читается, слова панели называют обоих', () => {
    const r = nodeInOtherCascadeRefusal(res(409, body));
    expect(r).toEqual({ nodeName: 'nl-exit', cascadeId: 'c1', cascadeName: 'first' });
    const t = (k: string, o?: Record<string, string>) => `${k} ${JSON.stringify(o)}`;
    expect(nodeInOtherCascadeWords(r!, t)).toBe('cascades.nodeInOtherCascade {"node":"nl-exit","cascade":"first"}');
    expect(nodeInOtherCascadeRefusal(res(409, { ...body, cascadeId: undefined }))?.cascadeId).toBeNull();
  });

  it('тот же отказ виден и общему парсеру тумблера, код не теряется', () => {
    expect(cascadeToggleRefusal(res(409, body))?.code).toBe('NODE_IN_OTHER_CASCADE');
  });

  it('мусор, чужой код, не 409 или без имён: null', () => {
    for (const e of [null, 'x', new Error('net'), { response: null }, res(409, null), res(409, { ...body, error: 'CONFLICT' }), res(400, body), res(409, { ...body, nodeName: '' }), res(409, { ...body, cascadeName: 7 })]) {
      expect(nodeInOtherCascadeRefusal(e)).toBeNull();
    }
  });
});