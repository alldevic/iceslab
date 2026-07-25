import { assertFetchableUrl } from '../recipes/recipes.ssrf.js';

/**
 * Fetch an upstream geo .dat. https-only + SSRF-guarded (assertFetchableUrl),
 * size-capped, timed out. geo .dat files are tens of MB (runetfreedom geoip.dat
 * ~20MB), so the cap is high; a content-length over it is rejected before the
 * body is read. Redirects are followed manually (GitHub release URLs 302 to the
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
const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

export const fetchDat: DatFetcher = async (startUrl, cond) => {
  const headers: Record<string, string> = {};
  if (cond?.etag) headers['If-None-Match'] = cond.etag;
  if (cond?.lastModified) headers['If-Modified-Since'] = cond.lastModified;

  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertFetchableUrl(url); // re-validate the start URL and every redirect hop
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
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
      clearTimeout(timer);
    }
  }
  throw new Error(`geo fetch ${startUrl}: too many redirects`);
};
