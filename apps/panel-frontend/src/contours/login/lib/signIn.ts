import type { LoginResponse } from '@/lib/auth/api';

/**
 * The first sign-in of an install: create the admin, then log in (A-156).
 *
 * It used to be one step that registered whenever the page had read
 * "registration open". When the login after a successful register failed (a
 * slow network, a restart), every retry registered again and got 403
 * REGISTRATION_DISABLED: the admin existed, and the page could not get past
 * "create admin". The admin made in this page's life is remembered here, so a
 * retry only logs in; `onRegistered` lets the page re-read the status.
 */
export function createSignIn(calls: {
  register: (username: string, password: string) => Promise<unknown>;
  login: (username: string, password: string, totpCode?: string) => Promise<LoginResponse>;
  onRegistered?: () => void;
}) {
  let registered = false;
  return async function signIn(
    creds: { username: string; password: string; totpCode: string },
    bootstrap: boolean,
  ): Promise<LoginResponse> {
    if (bootstrap && !registered) {
      await calls.register(creds.username, creds.password);
      registered = true;
      calls.onRegistered?.();
    }
    return calls.login(creds.username, creds.password, creds.totpCode || undefined);
  };
}

/**
 * Seconds until sign-in may be tried again, from a 429. Two refusals answer
 * it: the account lockout (ACCOUNT_LOCKED, `retryAfterSeconds` in the body,
 * auth.routes.ts) and the route's rate limit (RATE_LIMITED, which on the dev
 * panel came after five wrong passwords, 22.10, and carries the wait only in
 * the `Retry-After` header). Body first, then the header. Input checked
 * first; null when the refusal is not a 429 or names no positive wait.
 */
export function lockoutSeconds(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const res = (err as { response?: unknown }).response;
  if (!res || typeof res !== 'object') return null;
  const { status, data, headers } = res as { status?: unknown; data?: unknown; headers?: unknown };
  if (status !== 429) return null;
  const positive = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.ceil(n) : null);
  // The body's field is a number by contract; a header is always text.
  const fromBody = data && typeof data === 'object' ? positive((data as { retryAfterSeconds?: unknown }).retryAfterSeconds) : null;
  if (fromBody !== null) return fromBody;
  const header = headers && typeof headers === 'object' ? (headers as Record<string, unknown>)['retry-after'] : undefined;
  return typeof header === 'string' && /^\d+$/.test(header.trim()) ? positive(Number(header)) : null;
}
