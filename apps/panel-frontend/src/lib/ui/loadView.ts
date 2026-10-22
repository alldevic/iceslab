/**
 * What a screen that waits for one query shows (A-141).
 *
 * Data first: a refetch that fails after a good answer keeps the screen on
 * what it had. No data and a failed request is «failed», said with the
 * server's words and a retry: it used to read «loading» forever, or «there is
 * none», which is a different fact about a list that did not arrive.
 */
export type LoadView = 'ready' | 'failed' | 'loading';

export function loadView(q: { data: unknown; isError: boolean }): LoadView {
  if (q.data !== undefined && q.data !== null) return 'ready';
  return q.isError ? 'failed' : 'loading';
}
