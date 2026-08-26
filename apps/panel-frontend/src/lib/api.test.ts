// The two interceptors every request in the panel goes through, and the
// function that decides what an operator reads when one fails.
//
// `api.ts` is the largest file in the frontend and most of it is typed wrappers
// around endpoints. These three pieces are the ones with behaviour: the JWT is
// attached here or nowhere, the session is cleared here or nowhere, and the
// error text an operator sees is chosen here.
//
// Driven through a stub adapter rather than by calling the handlers out of
// axios's internals, so the real interceptor chain runs in the real order.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios';
import { AxiosError, AxiosHeaders } from 'axios';
import { api, apiErrorMessage } from './api';
import { useAuth } from '../stores/auth';
import { queryClient } from './queryClient';

const realAdapter = api.defaults.adapter;
let seen: InternalAxiosRequestConfig | null = null;

/** Answers every request with 200 and records what the chain built. */
const recordingAdapter: AxiosAdapter = async (config) => {
  seen = config;
  return {
    data: { ok: true },
    status: 200,
    statusText: 'OK',
    headers: new AxiosHeaders(),
    config,
  };
};

/** Answers every request with the given status. */
const failingAdapter = (status: number): AxiosAdapter => async (config) => {
  throw new AxiosError('failed', String(status), config, null, {
    data: {},
    status,
    statusText: 'x',
    headers: new AxiosHeaders(),
    config,
  });
};

beforeEach(() => {
  seen = null;
  useAuth.getState().clearSession();
  api.defaults.adapter = recordingAdapter;
});

afterEach(() => {
  api.defaults.adapter = realAdapter;
  useAuth.getState().clearSession();
  queryClient.clear();
});

describe('the request interceptor', () => {
  // The store is the only source of the token; a request that forgot to read it
  // is a 401 on a perfectly good session.
  it('attaches the session token to every request', async () => {
    useAuth.getState().setSession('jwt-abc', { id: 'a', username: 'admin', role: 'admin' });
    await api.get('/api/nodes');
    expect(seen?.headers?.Authorization).toBe('Bearer jwt-abc');
  });

  it('sends no Authorization header when there is no session', async () => {
    await api.get('/api/auth/status');
    expect(seen?.headers?.Authorization).toBeUndefined();
  });

  it('picks up a token set after the client was created', async () => {
    await api.get('/api/auth/status');
    expect(seen?.headers?.Authorization).toBeUndefined();

    useAuth.getState().setSession('jwt-later', { id: 'a', username: 'admin', role: 'admin' });
    await api.get('/api/nodes');
    expect(
      seen?.headers?.Authorization,
      'the interceptor must read the store per request, not capture it once',
    ).toBe('Bearer jwt-later');
  });
});

describe('the 401 interceptor', () => {
  // Both halves matter and the second is the non-obvious one: without clearing
  // the query cache, the next admin who signs in on the same browser sees the
  // previous admin's user list and dashboard flash up before the refetch.
  it('clears the session and the cached data', async () => {
    useAuth.getState().setSession('jwt-abc', { id: 'a', username: 'admin', role: 'admin' });
    queryClient.setQueryData(['users'], [{ username: 'someone-elses-user' }]);
    api.defaults.adapter = failingAdapter(401);

    await expect(api.get('/api/nodes')).rejects.toBeInstanceOf(AxiosError);

    expect(useAuth.getState().token).toBeNull();
    expect(useAuth.getState().admin).toBeNull();
    expect(
      queryClient.getQueryData(['users']),
      "the next admin must not see the previous one's data while the refetch runs",
    ).toBeUndefined();
  });

  // A 403 is "you are signed in and not allowed"; logging the operator out
  // there would turn every permission error into a surprise sign-out.
  it('leaves the session alone on any other status', async () => {
    for (const status of [400, 403, 404, 409, 500]) {
      useAuth.getState().setSession('jwt-abc', { id: 'a', username: 'admin', role: 'admin' });
      queryClient.setQueryData(['users'], ['kept']);
      api.defaults.adapter = failingAdapter(status);

      await expect(api.get('/api/nodes')).rejects.toBeTruthy();

      expect(useAuth.getState().token, `${status} signed the operator out`).toBe('jwt-abc');
      expect(queryClient.getQueryData(['users']), `${status} dropped the cache`).toEqual(['kept']);
    }
  });
});

describe('apiErrorMessage', () => {
  function axiosErrorWith(data: unknown): AxiosError {
    const config = { headers: new AxiosHeaders() } as InternalAxiosRequestConfig;
    return new AxiosError('Request failed with status code 400', 'ERR_BAD_REQUEST', config, null, {
      data,
      status: 400,
      statusText: 'Bad Request',
      headers: new AxiosHeaders(),
      config,
    });
  }

  // The reason this exists: the backend answers a zod failure with the useless
  // generic "Invalid input" in `message` and the actual reason in `issues`.
  it('prefers the field-level reason over the generic one', () => {
    const err = axiosErrorWith({
      error: 'VALIDATION_ERROR',
      message: 'Invalid input',
      issues: [{ path: ['name'], message: 'name may only contain letters, digits, . _ -' }],
    });
    expect(apiErrorMessage(err)).toBe('name: name may only contain letters, digits, . _ -');
  });

  it('joins a nested path so the operator knows which field', () => {
    const err = axiosErrorWith({
      message: 'Invalid input',
      issues: [{ path: ['config', 'realityShortIds', 0], message: 'must be hex' }],
    });
    expect(apiErrorMessage(err)).toBe('config.realityShortIds.0: must be hex');
  });

  it('omits the prefix when the issue names no path', () => {
    const err = axiosErrorWith({ message: 'Invalid input', issues: [{ message: 'bad body' }] });
    expect(apiErrorMessage(err)).toBe('bad body');
  });

  it('skips issues that carry no message at all', () => {
    const err = axiosErrorWith({
      message: 'Invalid input',
      issues: [{ path: ['a'] }, { path: ['b'], message: 'the real one' }],
    });
    expect(apiErrorMessage(err)).toBe('b: the real one');
  });

  // The ordinary case: a business error the backend wrote for a human.
  it('uses the backend message when there are no issues', () => {
    const err = axiosErrorWith({
      error: 'CONFLICT',
      message: 'Port 443 on node "xray" is already used by profile "xray"',
    });
    expect(apiErrorMessage(err)).toBe('Port 443 on node "xray" is already used by profile "xray"');
  });

  it('falls back to the error code, then to axios’s own text', () => {
    expect(apiErrorMessage(axiosErrorWith({ error: 'GEO_BLOCKED' }))).toBe('GEO_BLOCKED');
    expect(apiErrorMessage(axiosErrorWith({}))).toBe('Request failed with status code 400');
    expect(apiErrorMessage(axiosErrorWith(undefined))).toBe('Request failed with status code 400');
  });

  // A network failure has no response at all, and an operator staring at
  // "[object Object]" learns nothing.
  it('handles a request that never got a response', () => {
    const config = { headers: new AxiosHeaders() } as InternalAxiosRequestConfig;
    const err = new AxiosError('Network Error', 'ERR_NETWORK', config, {});
    expect(apiErrorMessage(err)).toBe('Network Error');
  });

  it('handles things that are not axios errors', () => {
    expect(apiErrorMessage(new Error('boom'))).toBe('boom');
    expect(apiErrorMessage('a bare string')).toBe('a bare string');
    expect(apiErrorMessage(null)).toBe('null');
  });
});
