import { describe, expect, it } from 'vitest';
import { SINGBOX_XRAY_FIELDS, singboxXrayMessage, singboxXrayRefusal } from '@/lib/domain/singboxXray';

// The server's sentence is not read (A-159 changed it and nothing here may
// notice): the refusal is its code and path. Any text stands in for it.
const MSG = 'any sentence the server says';
const CODE = 'SINGBOX_XRAY_FAMILY';
const res = (data: unknown, status = 400) => ({ response: { status, data } });
const createIssue = (field: string, params: unknown = { code: CODE }) =>
  res({ error: 'VALIDATION_ERROR', message: 'Invalid input', issues: [{ code: 'custom', message: MSG, path: ['config', field], params }] });

describe('singboxXrayRefusal', () => {
  it('создание: каждое поле, issue с params.code', () => {
    for (const field of SINGBOX_XRAY_FIELDS) {
      expect(singboxXrayRefusal(createIssue(field))).toEqual({ where: 'config', field });
    }
  });

  it('правка профиля: { error: SINGBOX_XRAY_FAMILY, path config }', () => {
    expect(singboxXrayRefusal(res({ error: CODE, message: MSG, path: ['config', 'network'] }))).toEqual({
      where: 'config',
      field: 'network',
    });
  });

  it('A-159: больше одного имени REALITY на sing-box, отказ у поля имён в каждой форме ответа', () => {
    const want = { where: 'config', field: 'realityServerNames' };
    expect(singboxXrayRefusal(createIssue('realityServerNames'))).toEqual(want);
    expect(singboxXrayRefusal(res({ error: CODE, path: ['config', 'realityServerNames'] }))).toEqual(want);
    expect(singboxXrayRefusal(res({ error: CODE, path: ['overrides', 'realityServerNames'] }))).toEqual({
      ...want,
      where: 'overrides',
    });
  });

  it('привязка и хост: path overrides', () => {
    expect(singboxXrayRefusal(res({ error: CODE, message: MSG, path: ['overrides', 'security'] }))).toEqual({
      where: 'overrides',
      field: 'security',
    });
  });

  it('по коду, не по пути и не по тексту: socks/http на config.security это не он', () => {
    // Тот же путь и даже тот же текст, но код INVALID или его нет.
    expect(singboxXrayRefusal(res({ error: 'INVALID', message: MSG, path: ['config', 'security'] }))).toBeNull();
    expect(singboxXrayRefusal(createIssue('security', null))).toBeNull();
    expect(
      singboxXrayRefusal(res({ issues: [{ code: 'custom', message: MSG, path: ['config', 'security'] }] })),
    ).toBeNull();
    expect(singboxXrayRefusal(createIssue('security', { code: 'OTHER' }))).toBeNull();
    expect(singboxXrayRefusal(createIssue('security', 'x'))).toBeNull();
  });

  it('мусор и чужие ответы: null', () => {
    for (const e of [
      null,
      undefined,
      'boom',
      new Error('x'),
      res({ error: CODE, message: MSG, path: ['engine'] }),
      res({ error: CODE, message: MSG, path: ['config', 'flow'] }),
      res({ error: CODE, message: MSG, path: 'config.network' }),
      res({ error: CODE, message: MSG, path: ['config', 'network'] }, 409),
      res({ issues: 'nope' }),
      res({ issues: [null, 'x', { params: null }] }),
      res(null),
    ]) {
      expect(singboxXrayRefusal(e)).toBeNull();
    }
  });
});

describe('singboxXrayMessage', () => {
  const t = (key: string, opts?: Record<string, string>) => (opts ? `${key}(${opts.field})` : key);

  it('поле профиля и поле привязки говорят разными фразами, поле по имени', () => {
    expect(singboxXrayMessage({ where: 'config', field: 'network' }, t)).toBe(
      'profileEdit.singboxXrayRefused(profileEdit.singboxXrayField.network)',
    );
    expect(singboxXrayMessage({ where: 'overrides', field: 'realityMode' }, t)).toBe(
      'profileEdit.singboxXrayRefusedBinding(profileEdit.singboxXrayField.realityMode)',
    );
  });
});
