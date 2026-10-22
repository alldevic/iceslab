import { describe, expect, it } from 'vitest';
import { CERT_WARN_DAYS, certRotateRefusal, certTerm } from '@/contours/nodes/lib/nodeCert';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (ms: number) => new Date(ms).toISOString();

describe('certTerm (A-124)', () => {
  it('сервер старше поля: строки нет', () => {
    expect(certTerm(undefined, NOW)).toBeNull();
  });

  it('null и кривое значение: срок неизвестен, а не истёк', () => {
    for (const v of [null, '', 'not a date', 42, {}]) {
      expect(certTerm(v, NOW)).toEqual({ kind: 'unknown' });
    }
  });

  it('больше окна: ok; внутри окна: soon; граница окна ещё ok', () => {
    expect(certTerm(at(NOW + 200 * DAY), NOW)).toMatchObject({ kind: 'ok', days: 200 });
    expect(certTerm(at(NOW + CERT_WARN_DAYS * DAY), NOW)).toMatchObject({ kind: 'ok', days: CERT_WARN_DAYS });
    expect(certTerm(at(NOW + (CERT_WARN_DAYS - 1) * DAY), NOW)).toMatchObject({ kind: 'soon', days: CERT_WARN_DAYS - 1 });
    expect(certTerm(at(NOW + 3 * 60 * 60 * 1000), NOW)).toMatchObject({ kind: 'soon', days: 0 });
  });

  it('конец прошёл или ровно сейчас: истёк', () => {
    expect(certTerm(at(NOW), NOW)).toMatchObject({ kind: 'expired', daysAgo: 0 });
    expect(certTerm(at(NOW - 5 * DAY), NOW)).toMatchObject({ kind: 'expired', daysAgo: 5 });
  });
});

describe('certRotateRefusal (A-124)', () => {
  const res = (status: number, data: unknown) => ({ response: { status, data } });

  it('мусор на входе: null', () => {
    for (const e of [null, undefined, 'x', new Error('net'), { response: null }, res(409, null), res(409, 'x')]) {
      expect(certRotateRefusal(e)).toBeNull();
    }
  });

  it('каждый код со своим статусом, слова сервера как деталь', () => {
    const cases: [number, string][] = [
      [404, 'CERT_NODE_NOT_FOUND'],
      [409, 'CERT_UPDATE_AGENT'],
      [409, 'CERT_PENDING'],
      [502, 'CERT_INVALID'],
      [502, 'CERT_UNCONFIRMED'],
      [502, 'CERT_UNREACHABLE'],
    ];
    for (const [status, code] of cases) {
      expect(certRotateRefusal(res(status, { error: code, message: 'said' }))).toEqual({ code, detail: 'said' });
    }
    expect(certRotateRefusal(res(409, { error: 'CERT_PENDING' }))).toEqual({ code: 'CERT_PENDING', detail: '' });
  });

  it('чужой код или код не со своим статусом: null, это тост', () => {
    expect(certRotateRefusal(res(409, { error: 'CONFLICT', message: 'x' }))).toBeNull();
    expect(certRotateRefusal(res(500, { error: 'CERT_UNREACHABLE' }))).toBeNull();
    expect(certRotateRefusal(res(404, { error: 'NOT_FOUND' }))).toBeNull();
    expect(certRotateRefusal(res(409, { error: 'toString' }))).toBeNull();
  });
});
