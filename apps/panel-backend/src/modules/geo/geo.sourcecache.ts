import type { DatFetcher } from './geo.fetch.js';

/**
 * In-process cache of each source URL's last-fetched bytes + validators
 * (ETag / Last-Modified) + the time we last refreshed it. It serves two jobs:
 *
 *  1. Per-source refresh interval: a build in `ifDue` mode reuses a source's
 *     cached bytes WITHOUT touching the network while it is still within its
 *     `refreshIntervalHours`, so a rarely-updated source isn't re-fetched every
 *     cron tick. A `force` build (manual Rebuild / cold start) always revalidates.
 *  2. ETag/If-Modified-Since: when we do revalidate, we send the stored
 *     validators; a 304 reuses the cached bytes instead of re-downloading tens
 *     of MB.
 *
 * Single-process cache (the panel is one process); cold on restart (everything
 * re-fetches once). Keyed by URL so geosite/geoip and shared URLs dedupe.
 */
interface Entry {
  etag?: string;
  lastModified?: string;
  refreshedAt: number; // epoch ms of the last successful fetch/validation
  bytes: Uint8Array;
}

const cache = new Map<string, Entry>();

/** Is this URL due for a (re)fetch given the interval? True if never fetched or
 *  the interval has elapsed since the last refresh. */
export function isSourceDue(url: string, intervalMs: number, now: number): boolean {
  const c = cache.get(url);
  return !c || now - c.refreshedAt >= intervalMs;
}

/**
 * Resolve a source URL's bytes, honouring the refresh interval + conditional
 * revalidation. `mode`:
 *   - 'force': always revalidate (conditional GET with the stored validators).
 *   - 'ifDue': reuse cached bytes with NO network call while within the interval;
 *     otherwise revalidate like 'force'.
 * On a fetch error we serve the last-good cached bytes if we have any (so a
 * transient upstream blip doesn't drop the source and churn every node); only a
 * first-ever fetch with no cache propagates the error.
 */
export async function loadSourceDat(
  url: string,
  intervalMs: number,
  mode: 'force' | 'ifDue',
  now: number,
  fetchDat: DatFetcher,
): Promise<Uint8Array> {
  const cached = cache.get(url);
  if (cached && mode === 'ifDue' && now - cached.refreshedAt < intervalMs) {
    return cached.bytes; // not due -> reuse without touching the network
  }

  let res;
  try {
    res = await fetchDat(url, cached ? { etag: cached.etag, lastModified: cached.lastModified } : undefined);
  } catch (err) {
    if (cached) return cached.bytes; // transient error -> last-good (no node churn)
    throw err;
  }

  if (res.status === 200 && res.bytes) {
    cache.set(url, {
      etag: res.etag,
      lastModified: res.lastModified,
      refreshedAt: now,
      bytes: res.bytes,
    });
    return res.bytes;
  }
  // 304 (or a 200 with no body): the upstream is unchanged; keep the bytes, bump
  // the refresh time so the interval clock restarts.
  if (cached) {
    cache.set(url, { ...cached, refreshedAt: now });
    return cached.bytes;
  }
  throw new Error(`geo source ${url}: empty response (status ${res.status})`);
}

/** Test hook: drop all cached bytes so a suite starts from a cold cache. */
export function invalidateSourceCache(): void {
  cache.clear();
}
