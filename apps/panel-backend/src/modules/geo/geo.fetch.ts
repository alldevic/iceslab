import { assertFetchableUrl } from '../recipes/recipes.ssrf.js';

/**
 * Fetch an upstream geo .dat. https-only + SSRF-guarded (assertFetchableUrl),
 * size-capped, and bounded by a STALL timeout rather than a deadline on the
 * whole transfer - see STALL_MS. geo .dat files are tens of MB (runetfreedom
 * geoip.dat ~19MB, geosite.dat ~74MB), so the cap is high; a content-length
 * over it is rejected before the body is read. Redirects are followed manually (GitHub release URLs 302 to the
 * CDN) with the SSRF guard re-run on EVERY hop - undici is told
 * `redirect: 'manual'` so it cannot silently follow a 3xx into a private / cloud
 * metadata host; each Location is resolved and re-validated before the next
 * request. (DNS is still not resolved, so a public name that points at a private
 * IP is not caught - the same accepted admin-trusted limitation as recipes.ssrf.)
 *
 * CONDITIONAL: the caller may pass a prior ETag / Last-Modified; we send them as
 * If-None-Match / If-Modified-Since, and the server answers 304 (unchanged) with
 * no body - so an unchanged upstream .dat is a tiny round-trip, not a re-download
 * of tens of MB. The source-bytes cache (geo.sourcecache) reuses the previous
 * bytes on a 304.
 */
export interface ConditionalDat {
  /** 200 = fresh body in `bytes`; 304 = unchanged, reuse the cached bytes. */
  status: 200 | 304;
  bytes?: Uint8Array;
  etag?: string;
  lastModified?: string;
}

export type DatFetcher = (
  url: string,
  cond?: { etag?: string; lastModified?: string },
) => Promise<ConditionalDat>;

const MAX_DAT_BYTES = 128 * 1024 * 1024;

/**
 * How long a transfer may go with NOTHING arriving, not how long it may take.
 *
 * This was a deadline on the whole request-plus-body, and it made the feature's
 * bigger database impossible to ingest. Measured 2026-08-28 from this machine:
 *
 *   geoip.dat    18 671 837 bytes   6.6 s   -> fits
 *   geosite.dat  73 703 302 bytes  41.9 s   -> aborted at 30 s
 *
 * The cap next to it allows 128 MB, so the deadline demanded a sustained
 * ~34 Mbit/s from a CDN - for a panel whose whole point is serving nodes on
 * censored, slow links. What the operator got was `"error": "This operation was
 * aborted"` in sourceErrors, empty artifacts, and the sha256 of the empty
 * string, on two separate days.
 *
 * A stall timeout is the right shape: it still kills a hung connection in 30 s,
 * and a slow-but-moving one finishes. STALL_MS also covers connect + headers,
 * where no bytes have arrived yet by definition.
 */
const STALL_MS = 30_000;

/**
 * And an outer bound, because a stall timeout alone is not one: a hostile
 * server dripping a byte every 29 s would hold the connection until the size
 * cap, which at that rate is longer than the heat death of the panel. Fifteen
 * minutes is ~40x the slowest real download measured above.
 */
const MAX_TOTAL_MS = 15 * 60_000;
const MAX_REDIRECTS = 5;

export const fetchDat: DatFetcher = async (startUrl, cond) => {
  const headers: Record<string, string> = {};
  if (cond?.etag) headers['If-None-Match'] = cond.etag;
  if (cond?.lastModified) headers['If-Modified-Since'] = cond.lastModified;

  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertFetchableUrl(url); // re-validate the start URL and every redirect hop
    const controller = new AbortController();
    // Reset on every chunk (see the stream loop below), so the budget is
    // "silence", not "duration". Named so an abort says which one fired.
    let stallTimer = setTimeout(() => controller.abort(new Error('stalled')), STALL_MS);
    const totalTimer = setTimeout(() => controller.abort(new Error('too slow')), MAX_TOTAL_MS);
    const resetStall = (): void => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => controller.abort(new Error('stalled')), STALL_MS);
    };
    try {
      const res = await fetch(url, { redirect: 'manual', headers, signal: controller.signal });

      // Follow 3xx ourselves so the guard runs on the resolved hop. 304 (from a
      // conditional GET) is NOT a redirect - it is a terminal "unchanged".
      if (res.status !== 304 && res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error(`geo fetch ${url}: redirect ${res.status} without Location`);
        url = new URL(loc, url).toString(); // resolve relative, re-checked next hop
        continue;
      }
      if (res.status === 304) return { status: 304 };
      if (!res.ok) throw new Error(`geo fetch ${url}: HTTP ${res.status}`);

      const etag = res.headers.get('etag') ?? undefined;
      const lastModified = res.headers.get('last-modified') ?? undefined;

      // Reject an over-cap content-length up front (cheap when the header is
      // honest). A missing/lying header does NOT let an oversized body through:
      // the streaming loop below aborts the moment the running total exceeds the
      // cap, so a chunked/endless response can't be buffered whole into memory.
      const len = Number(res.headers.get('content-length'));
      if (Number.isFinite(len) && len > MAX_DAT_BYTES) {
        throw new Error(`geo fetch ${url}: too large (${len} bytes)`);
      }
      if (!res.body) {
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.length > MAX_DAT_BYTES) throw new Error(`geo fetch ${url}: too large`);
        return { status: 200, bytes: buf, etag, lastModified };
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // Bytes arrived: the connection is not stalled, whatever the clock says.
        resetStall();
        total += value.length;
        if (total > MAX_DAT_BYTES) {
          await reader.cancel();
          throw new Error(`geo fetch ${url}: too large`);
        }
        chunks.push(value);
      }
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.length;
      }
      return { status: 200, bytes: out, etag, lastModified };
    } finally {
      clearTimeout(stallTimer);
      clearTimeout(totalTimer);
    }
  }
  throw new Error(`geo fetch ${startUrl}: too many redirects`);
};
