import { describe, expect, it } from 'vitest';
import { backendStatusOf, entryMode } from '@/contours/login/lib/loginView';

describe('entryMode (A-238)', () => {
  it('сбой status: ни одна из двух форм не выбрана', () => {
    expect(entryMode({ data: undefined, isError: true })).toBe('failed');
    expect(entryMode({ data: undefined, isError: false })).toBe('loading');
  });

  it('с ответом: регистрация открыта даёт создание админа, иначе вход', () => {
    expect(entryMode({ data: { registration: { enabled: true } }, isError: false })).toBe('register');
    expect(entryMode({ data: { registration: { enabled: false } }, isError: false })).toBe('login');
  });

  it('повторный сбой после ответа держит пришедший ответ', () => {
    expect(entryMode({ data: { registration: { enabled: true } }, isError: true })).toBe('register');
  });
});

describe('backendStatusOf (A-240)', () => {
  it('до первого ответа «проверяю», а не «деградирует»', () => {
    expect(backendStatusOf({ data: undefined, isError: false })).toBe('checking');
  });

  it('ответ ok, иной ответ и сбой', () => {
    expect(backendStatusOf({ data: { status: 'ok' }, isError: false })).toBe('normal');
    expect(backendStatusOf({ data: { status: 'starting' }, isError: false })).toBe('degraded');
    expect(backendStatusOf({ data: undefined, isError: true })).toBe('down');
  });
});
