import { loadView } from '@/lib/ui/loadView';

/**
 * Which form the login page offers (A-238): create the first admin, or sign
 * in. Only the server's answer says which. A failed /api/auth/status used to
 * read as «registration closed», so a fresh install offered a login nobody
 * could pass; now neither form is chosen until the status arrives, and a
 * failure is said with a retry.
 */
export type EntryMode = 'loading' | 'failed' | 'register' | 'login';

export function entryMode(q: { data: { registration?: { enabled?: unknown } } | undefined; isError: boolean }): EntryMode {
  const view = loadView(q);
  if (view !== 'ready') return view;
  return q.data?.registration?.enabled === true ? 'register' : 'login';
}

/**
 * The backend pill of the top bar (A-240): «checking» until /health first
 * answers, then normal, degraded or down. Before the first answer it used to
 * say «degraded», a claim about a server nobody had asked yet.
 */
export type BackendStatus = 'checking' | 'normal' | 'degraded' | 'down';

export function backendStatusOf(q: { data: { status?: unknown } | undefined; isError: boolean }): BackendStatus {
  if (q.isError) return 'down';
  if (q.data === undefined) return 'checking';
  return q.data.status === 'ok' ? 'normal' : 'degraded';
}
