import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatFetcher } from './geo.fetch.js';
import { loadSourceDat, isSourceDue, invalidateSourceCache } from './geo.sourcecache.js';

const URL = 'https://example.com/geosite.dat';
const HOUR = 3_600_000;
const bytes = (s: string) => new TextEncoder().encode(s);

beforeEach(() => invalidateSourceCache());

describe('geo source cache', () => {
  it('fetches on a cold cache and stores the bytes', async () => {
    const fetch: DatFetcher = vi.fn(async () => ({ status: 200, bytes: bytes('v1'), etag: 'W/"a"' }));
    const out = await loadSourceDat(URL, 24 * HOUR, 'force', 1000, fetch);
    expect(new TextDecoder().decode(out)).toBe('v1');
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(URL, undefined); // no validators yet
  });

  it('sends the stored ETag and REUSES bytes on a 304 (no re-download)', async () => {
    const fetch = vi
      .fn<DatFetcher>()
      .mockResolvedValueOnce({ status: 200, bytes: bytes('v1'), etag: 'W/"a"' })
      .mockResolvedValueOnce({ status: 304 });
    await loadSourceDat(URL, 24 * HOUR, 'force', 1000, fetch); // primes etag
    const out = await loadSourceDat(URL, 24 * HOUR, 'force', 2000, fetch); // 304 -> reuse
    expect(new TextDecoder().decode(out)).toBe('v1');
    expect(fetch).toHaveBeenLastCalledWith(URL, { etag: 'W/"a"', lastModified: undefined });
  });

  it('picks up NEW bytes when the upstream changed (200 with a new body)', async () => {
    const fetch = vi
      .fn<DatFetcher>()
      .mockResolvedValueOnce({ status: 200, bytes: bytes('v1'), etag: 'W/"a"' })
      .mockResolvedValueOnce({ status: 200, bytes: bytes('v2'), etag: 'W/"b"' });
    await loadSourceDat(URL, 24 * HOUR, 'force', 1000, fetch);
    const out = await loadSourceDat(URL, 24 * HOUR, 'force', 2000, fetch);
    expect(new TextDecoder().decode(out)).toBe('v2');
  });

  it("ifDue REUSES cached bytes without any network call while within the interval", async () => {
    const fetch = vi.fn<DatFetcher>().mockResolvedValue({ status: 200, bytes: bytes('v1') });
    await loadSourceDat(URL, 24 * HOUR, 'force', 1000, fetch); // 1 call, refreshedAt=1000
    // 12h later, interval 24h -> not due -> no fetch
    const out = await loadSourceDat(URL, 24 * HOUR, 'ifDue', 1000 + 12 * HOUR, fetch);
    expect(new TextDecoder().decode(out)).toBe('v1');
    expect(fetch).toHaveBeenCalledOnce(); // still just the first call
  });

  it('ifDue REVALIDATES once the interval has elapsed', async () => {
    const fetch = vi.fn<DatFetcher>().mockResolvedValue({ status: 200, bytes: bytes('v1'), etag: 'e' });
    await loadSourceDat(URL, 24 * HOUR, 'force', 1000, fetch);
    await loadSourceDat(URL, 24 * HOUR, 'ifDue', 1000 + 25 * HOUR, fetch); // due -> fetch
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('serves last-good bytes when a revalidation fetch throws (no source drop)', async () => {
    const fetch = vi
      .fn<DatFetcher>()
      .mockResolvedValueOnce({ status: 200, bytes: bytes('v1'), etag: 'e' })
      .mockRejectedValueOnce(new Error('network down'));
    await loadSourceDat(URL, 24 * HOUR, 'force', 1000, fetch);
    const out = await loadSourceDat(URL, 24 * HOUR, 'force', 2000, fetch); // errors -> last-good
    expect(new TextDecoder().decode(out)).toBe('v1');
  });

  it('propagates the error when the very first fetch fails (nothing cached)', async () => {
    const fetch = vi.fn<DatFetcher>().mockRejectedValue(new Error('boom'));
    await expect(loadSourceDat(URL, 24 * HOUR, 'force', 1000, fetch)).rejects.toThrow('boom');
  });

  it('isSourceDue: true when never fetched, false within interval, true after it', async () => {
    expect(isSourceDue(URL, 24 * HOUR, 1000)).toBe(true); // never fetched
    const fetch = vi.fn<DatFetcher>().mockResolvedValue({ status: 200, bytes: bytes('v1') });
    await loadSourceDat(URL, 24 * HOUR, 'force', 1000, fetch);
    expect(isSourceDue(URL, 24 * HOUR, 1000 + 12 * HOUR)).toBe(false);
    expect(isSourceDue(URL, 24 * HOUR, 1000 + 24 * HOUR)).toBe(true);
  });
});
