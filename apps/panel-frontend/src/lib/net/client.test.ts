// @vitest-environment jsdom
// The session store persists to localStorage; without a DOM zustand warns on every write.
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '@/lib/auth/session';
import { api, apiErrorMessage } from '@/lib/net/client';
import { queryClient } from '@/lib/net/queryClient';

const ADMIN = { id: 'a1', username: 'root', role: 'admin' };
const realAdapter = api.defaults.adapter;

/** Replace the transport of the shared `api` instance: nothing leaves the process. */
function useAdapter(answer: (config: InternalAxiosRequestConfig) => { status: number } | Error) {
  const seen: InternalAxiosRequestConfig[] = [];
  const adapter: AxiosAdapter = (config) => {
    seen.push(config);
    const out = answer(config);
    if (out instanceof Error) return Promise.reject(out);
    const response = { data: {}, status: out.status, statusText: '', headers: {}, config };
    if (out.status >= 200 && out.status < 300) return Promise.resolve(response);
    return Promise.reject(
      new AxiosError(`Request failed with status code ${out.status}`, 'ERR_BAD_REQUEST', config, null, response),
    );
  };
  api.defaults.adapter = adapter;
  return seen;
}

beforeEach(() => {
  useAuth.setState({ token: null, admin: null });
});

afterEach(() => {
  api.defaults.adapter = realAdapter;
  vi.restoreAllMocks();
  useAuth.setState({ token: null, admin: null });
});

describe('request interceptor', () => {
  it('sends no Authorization header without a token', async () => {
    const seen = useAdapter(() => ({ status: 200 }));
    await api.get('/api/x');
    expect(seen[0]!.headers.Authorization).toBeUndefined();
  });

  it('sends Bearer <token> when the session has one', async () => {
    useAuth.getState().setSession('jwt-123', ADMIN);
    const seen = useAdapter(() => ({ status: 200 }));
    await api.get('/api/x');
    expect(seen[0]!.headers.Authorization).toBe('Bearer jwt-123');
  });

  it('reads the token per request, not once', async () => {
    const seen = useAdapter(() => ({ status: 200 }));
    useAuth.getState().setSession('one', ADMIN);
    await api.get('/api/x');
    useAuth.getState().clearSession();
    await api.get('/api/x');
    expect(seen[0]!.headers.Authorization).toBe('Bearer one');
    expect(seen[1]!.headers.Authorization).toBeUndefined();
  });
});

describe('response interceptor', () => {
  it('401 clears the session and the query cache and stays rejected', async () => {
    useAuth.getState().setSession('stale', ADMIN);
    const clear = vi.spyOn(queryClient, 'clear');
    useAdapter(() => ({ status: 401 }));
    await expect(api.get('/api/x')).rejects.toMatchObject({ response: { status: 401 } });
    expect(useAuth.getState().token).toBeNull();
    expect(useAuth.getState().admin).toBeNull();
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it.each([403, 500])('%i leaves the session and the cache alone', async (status) => {
    useAuth.getState().setSession('keep', ADMIN);
    const clear = vi.spyOn(queryClient, 'clear');
    useAdapter(() => ({ status }));
    await expect(api.get('/api/x')).rejects.toMatchObject({ response: { status } });
    expect(useAuth.getState().token).toBe('keep');
    expect(clear).not.toHaveBeenCalled();
  });

  it('a network error without a response leaves the session alone', async () => {
    useAuth.getState().setSession('keep', ADMIN);
    const clear = vi.spyOn(queryClient, 'clear');
    useAdapter((config) => new AxiosError('Network Error', 'ERR_NETWORK', config));
    await expect(api.get('/api/x')).rejects.toMatchObject({ message: 'Network Error' });
    expect(useAuth.getState().token).toBe('keep');
    expect(clear).not.toHaveBeenCalled();
  });

  it('a success passes through untouched', async () => {
    useAuth.getState().setSession('keep', ADMIN);
    useAdapter(() => ({ status: 200 }));
    await expect(api.get('/api/x')).resolves.toMatchObject({ status: 200 });
    expect(useAuth.getState().token).toBe('keep');
  });
});

describe('apiErrorMessage', () => {
  const axiosErr = (data: unknown) =>
    new AxiosError('Request failed with status code 409', 'ERR_BAD_REQUEST', undefined, null, {
      data,
      status: 409,
      statusText: '',
      headers: {},
      config: {} as InternalAxiosRequestConfig,
    });

  it('takes `message` from the response body first', () => {
    expect(apiErrorMessage(axiosErr({ message: 'Port 443 is used', error: 'CONFLICT' }))).toBe('Port 443 is used');
  });

  it('falls back to `error` from the body', () => {
    expect(apiErrorMessage(axiosErr({ error: 'CONFLICT' }))).toBe('CONFLICT');
  });

  it('falls back to the axios message when the body says nothing', () => {
    expect(apiErrorMessage(axiosErr({}))).toBe('Request failed with status code 409');
    expect(apiErrorMessage(axiosErr(undefined))).toBe('Request failed with status code 409');
  });

  it('a plain Error gives its message', () => {
    expect(apiErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('a non-error is stringified', () => {
    expect(apiErrorMessage('oops')).toBe('oops');
    expect(apiErrorMessage(null)).toBe('null');
    expect(apiErrorMessage(42)).toBe('42');
  });
});
