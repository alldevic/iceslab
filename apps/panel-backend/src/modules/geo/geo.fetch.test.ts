import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchDat } from './geo.fetch.js';

function res(status: number, opts: { headers?: Record<string, string>; body?: Uint8Array } = {}): Response {
  // 204/205/304 are null-body statuses; the callers below only pass a body on 200.
  return new Response(opts.body ?? null, { status, headers: new Headers(opts.headers) });
}

afterEach(() => vi.restoreAllMocks());

describe('fetchDat manual redirects + per-hop SSRF (§3.4)', () => {
  it('follows an https redirect and returns the final body, redirect:manual each hop', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      return String(url) === 'https://a.example.com/gs.dat'
        ? res(302, { headers: { location: 'https://b.example.com/real.dat' } })
        : res(200, { body: new Uint8Array([1, 2, 3]) });
    });
    const out = await fetchDat('https://a.example.com/gs.dat');
    expect(out.status).toBe(200);
    expect(out.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(spy).toHaveBeenCalledTimes(2);
    // undici must NOT auto-follow; we resolve each hop ourselves.
    expect((spy.mock.calls[0]![1] as { redirect?: string }).redirect).toBe('manual');
    expect((spy.mock.calls[1]![1] as { redirect?: string }).redirect).toBe('manual');
  });

  it('rejects a redirect to a cloud-metadata / private host (guard re-run per hop)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).startsWith('https://a.example.com')) {
        return res(302, { headers: { location: 'https://169.254.169.254/latest/meta-data' } });
      }
      throw new Error('must not fetch the internal host');
    });
    await expect(fetchDat('https://a.example.com/gs.dat')).rejects.toThrow(/not allowed|metadata|private/i);
  });

  it('treats 304 as terminal (unchanged), not a redirect', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(res(304));
    const out = await fetchDat('https://a.example.com/gs.dat', { etag: 'W/"x"' });
    expect(out.status).toBe(304);
    expect(out.bytes).toBeUndefined();
  });

  it('rejects after exceeding the redirect cap', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      res(302, { headers: { location: 'https://a.example.com/loop' } }),
    );
    await expect(fetchDat('https://a.example.com/loop')).rejects.toThrow(/too many redirects/);
  });

  it('rejects a non-https start URL up front (no fetch attempted)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    await expect(fetchDat('http://a.example.com/gs.dat')).rejects.toThrow(/https/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a redirect without a Location header', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(res(302));
    await expect(fetchDat('https://a.example.com/gs.dat')).rejects.toThrow(/without Location/);
  });
});
