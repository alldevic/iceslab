import type { ReactNode } from 'react';
import { expect } from 'vitest';
import type { ZodType } from 'zod';
import { Route, Routes } from 'react-router-dom';
import { renderWithProviders, type RenderOptions } from '@/test/render';
import type { LoggedRequest } from '@/test/emptyApi';

/**
 * What the form tests (milestone 17.5) share: running a hook inside the app's
 * provider stack, and holding a request to the backend's own zod schema.
 */

/** Runs `useIt` in the provider stack; `.current` is its latest return value. */
export function mountHook<T>(
  useIt: () => T,
  opts: RenderOptions & { path?: string } = {},
): { current: T; view: ReturnType<typeof renderWithProviders> } {
  const holder = { current: undefined as T, view: undefined as unknown as ReturnType<typeof renderWithProviders> };
  function Probe(): ReactNode {
    holder.current = useIt();
    return null;
  }
  const { path, ...render } = opts;
  holder.view = renderWithProviders(
    path ? (
      <Routes>
        <Route path={path} element={<Probe />} />
      </Routes>
    ) : (
      <Probe />
    ),
    render,
  );
  return holder;
}

/**
 * The schema parses the body without a refusal. Returns what it parsed, so a
 * test can also assert what the backend would DO with the request (a default
 * filled in, a key stripped).
 */
export function accepted<T>(schema: ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  expect(r.success, r.success ? '' : `the API would refuse this request: ${JSON.stringify(r.error.issues)}\n${JSON.stringify(body)}`).toBe(true);
  return (r as { data: T }).data;
}

/** The one write of a method and path, or fails naming what was sent instead. */
export function theWrite(calls: LoggedRequest[], method: LoggedRequest['method'], url: RegExp | string): LoggedRequest {
  const hits = calls.filter((c) => c.method === method && (typeof url === 'string' ? c.url === url : url.test(c.url)));
  expect(hits, `expected one ${method} ${String(url)}; made: ${calls.map((c) => `${c.method} ${c.url}`).join(', ') || 'none'}`).toHaveLength(1);
  return hits[0]!;
}

/**
 * A value the stored record has must come back from a save unchanged: every
 * key of `body` that `record` also has is equal in both. A key the request
 * leaves out is "not touched" on this API, which is fine; a key it sends with
 * another value is a field the form lost or rewrote.
 */
export function sameWhereSent(body: Record<string, unknown>, record: Record<string, unknown>, ignore: string[] = []): void {
  const diffs: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (ignore.includes(k) || !(k in record)) continue;
    if (JSON.stringify(v) !== JSON.stringify(record[k])) diffs.push(`${k}: sent ${JSON.stringify(v)}, stored ${JSON.stringify(record[k])}`);
  }
  expect(diffs, 'the save rewrites what was stored').toEqual([]);
}
