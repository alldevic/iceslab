import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchDat } from './geo.fetch.js';

function res(status: number, opts: { headers?: Record<string, string>; body?: Uint8Array } = {}): Response {
  // 204/205/304 are null-body statuses; the callers below only pass a body on 200.
  return new Response(opts.body ?? null, { status, headers: new Headers(opts.headers) });
}

afterEach(() => vi.restoreAllMocks());

/**
 * A fetch whose body arrives in `chunks` pieces, `gapMs` apart on the fake
 * clock, and which is wired to the request's AbortSignal the way a real fetch
 * body is: aborting the controller is what makes `reader.read()` reject.
 *
 * The wiring is the load-bearing part. A mock stream that ignores the signal
 * makes the "slow but moving" case pass whether the timeout resets on a chunk
 * or not - caught by mutating exactly that: with `resetStall()` deleted the
 * suite stayed green until this helper was shared by both cases.
 */
function streamingFetch(chunks: number, gapMs: number): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const signal = (init as { signal?: AbortSignal }).signal;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        signal?.addEventListener('abort', () => ctrl.error(new Error('aborted')));
      },
      async pull(ctrl) {
        if (sent === chunks) return ctrl.close();
        sent++;
        await vi.advanceTimersByTimeAsync(gapMs);
        if (!signal?.aborted) ctrl.enqueue(new Uint8Array([sent]));
      },
    });
    return new Response(body, { status: 200, headers: new Headers() });
  });
}


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

  /**
   * The budget is silence, not duration.
   *
   * It used to be a deadline on the whole request-plus-body, and the feature's
   * bigger database could not be ingested through it. Measured 2026-08-28 from
   * the lab machine: geoip.dat 18 671 837 bytes in 6.6 s (fine), geosite.dat
   * 73 703 302 bytes in 41.9 s (aborted at 30 s), leaving `"error": "This
   * operation was aborted"` in sourceErrors and artifacts with the sha256 of
   * the empty string. Twice, on two separate days.
   *
   * Fake timers, because a real 30 s wait in a unit test is a 30 s wait.
   */
  it('lets a slow-but-moving download through, past the old whole-transfer deadline', async () => {
    vi.useFakeTimers();
    try {
      // Six chunks, 25 s apart: 150 s total, which the old 30 s deadline killed
      // and a stall timeout does not.
      streamingFetch(6, 25_000);
      const out = await fetchDat('https://a.example.com/geosite.dat');
      expect(out.status).toBe(200);
      expect(out.bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    } finally {
      vi.useRealTimers();
    }
  });

  it('still aborts a connection that goes silent', async () => {
    vi.useFakeTimers();
    try {
      // 45 s with nothing arriving is past the 30 s stall budget, however
      // recently the transfer started.
      streamingFetch(6, 45_000);
      await expect(fetchDat('https://a.example.com/geosite.dat')).rejects.toThrow(/abort/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a redirect without a Location header', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(res(302));
    await expect(fetchDat('https://a.example.com/gs.dat')).rejects.toThrow(/without Location/);
  });
});
