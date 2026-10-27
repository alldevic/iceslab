/**
 * Why a user's endpoint list is empty, when it is (A-141).
 *
 *   loading  no answer yet;
 *   refused  403: the subscription endpoint will not serve this account
 *            (expired, run out, link revoked), so «nothing» is the fact;
 *   failed   any other failure: the list is unknown, not empty;
 *   empty    the server answered an empty list.
 *
 * Null when there is something to show. One answer for the dial card and the
 * preview: the preview used to say «nothing here» over a failed request.
 * Input checked first.
 */
export type EndpointsWhy = 'loading' | 'refused' | 'failed' | 'empty';

export function endpointsWhy(q: { data?: { endpoints?: unknown[] }; isError: boolean; error: unknown }): EndpointsWhy | null {
  if (q.data && Array.isArray(q.data.endpoints)) return q.data.endpoints.length === 0 ? 'empty' : null;
  if (!q.isError) return 'loading';
  const res = q.error && typeof q.error === 'object' ? (q.error as { response?: unknown }).response : undefined;
  const status = res && typeof res === 'object' ? (res as { status?: unknown }).status : undefined;
  return status === 403 ? 'refused' : 'failed';
}
