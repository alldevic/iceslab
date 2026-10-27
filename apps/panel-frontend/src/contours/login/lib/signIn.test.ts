import { describe, expect, it } from 'vitest';
import { createSignIn, lockoutSeconds } from '@/contours/login/lib/signIn';
import type { LoginResponse } from '@/lib/auth/api';

const creds = { username: 'admin', password: 'password1', totpCode: '' };
const ok = { token: 't', admin: {} } as unknown as LoginResponse;

describe('createSignIn (A-156)', () => {
  it('register ok, login упал, повтор: один register, второй вызов только login', async () => {
    const calls: string[] = [];
    let loginFails = true;
    let refreshed = 0;
    const signIn = createSignIn({
      register: async () => void calls.push('register'),
      login: async () => {
        calls.push('login');
        if (loginFails) throw new Error('Network Error');
        return ok;
      },
      onRegistered: () => void refreshed++,
    });
    await expect(signIn(creds, true)).rejects.toThrow('Network Error');
    loginFails = false;
    await expect(signIn(creds, true)).resolves.toBe(ok);
    expect(calls).toEqual(['register', 'login', 'login']);
    expect(refreshed).toBe(1);
  });

  it('упавший register повторяется: админа ещё нет', async () => {
    const calls: string[] = [];
    let registerFails = true;
    const signIn = createSignIn({
      register: async () => {
        calls.push('register');
        if (registerFails) throw new Error('500');
      },
      login: async () => (calls.push('login'), ok),
    });
    await expect(signIn(creds, true)).rejects.toThrow('500');
    registerFails = false;
    await signIn(creds, true);
    expect(calls).toEqual(['register', 'register', 'login']);
  });

  it('без открытой регистрации только login', async () => {
    const calls: string[] = [];
    const signIn = createSignIn({ register: async () => void calls.push('register'), login: async () => (calls.push('login'), ok) });
    await signIn(creds, false);
    expect(calls).toEqual(['login']);
  });
});

describe('lockoutSeconds', () => {
  const res = (status: number, data: unknown) => ({ response: { status, data } });
  it('429 с retryAfterSeconds: секунды', () => {
    expect(lockoutSeconds(res(429, { error: 'ACCOUNT_LOCKED', retryAfterSeconds: 42 }))).toBe(42);
  });
  it('429 RATE_LIMITED без поля в теле: секунды из Retry-After', () => {
    const err = { response: { status: 429, data: { error: 'RATE_LIMITED' }, headers: { 'retry-after': '56' } } };
    expect(lockoutSeconds(err)).toBe(56);
  });
  it('вход проверяется первым', () => {
    for (const e of [null, 'x', new Error('x'), { response: null }]) expect(lockoutSeconds(e)).toBeNull();
    expect(lockoutSeconds(res(401, { retryAfterSeconds: 42 }))).toBeNull();
    expect(lockoutSeconds(res(429, { retryAfterSeconds: '42' }))).toBeNull();
    expect(lockoutSeconds(res(429, { retryAfterSeconds: 0 }))).toBeNull();
  });
});
