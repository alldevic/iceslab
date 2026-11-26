import { geoipRuleSet, geositeRuleSet, parseGeoDat, type RuleSetJson } from './geo-dat.js';
import { geoPublicBytes } from './geo-public-cache.js';
import { compileSrs } from './geo-srs.js';

/**
 * The compiled `.srs` of one tag of one set version (milestone 10.5), made on
 * the first request and kept. The content under (version sha256, kind, tag) never
 * changes, so an entry is never stale, only bounded: least recently used goes
 * first, the total stays under the cap (a compiled set is kilobytes to a few
 * hundred kilobytes; the cap is what a public address with one token for
 * everybody needs). The same in-process choice as geo-public-cache.ts, for the
 * same reason: the image writes nothing to disk.
 *
 * Two requests for one key share one compilation, and at most
 * SRS_MAX_CONCURRENT compilations run at once (a tag takes the whole `.dat` to
 * read and a process to compile it); the rest wait their turn. A failure is
 * not kept: the next request tries again.
 */
export const GEO_SRS_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const SRS_MAX_CONCURRENT = 2;

const entries = new Map<string, Buffer>();
const loading = new Map<string, Promise<Buffer>>();
let total = 0;
let running = 0;
const waiting: (() => void)[] = [];

function keep(key: string, data: Buffer): void {
  if (data.length > GEO_SRS_CACHE_MAX_BYTES) return;
  total += data.length;
  entries.set(key, data);
  for (const [k, v] of entries) {
    if (total <= GEO_SRS_CACHE_MAX_BYTES) break;
    if (k === key) continue;
    entries.delete(k);
    total -= v.length;
  }
}

async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= SRS_MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  else running++;
  try {
    return await work();
  } finally {
    // The slot passes to the next in line without being released.
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

/**
 * Bytes of the `.srs` for `tag` of the set version `sha256` (a `kind` file).
 * Throws GeoTagUnknownError when the file has no such tag, SingboxMissingError
 * without a binary, SrsCompileError when sing-box fails or is killed at its limit.
 */
export function geoSrsBytes(sha256: string, kind: 'geosite' | 'geoip', tag: string, compile: (r: RuleSetJson) => Promise<Buffer> = compileSrs): Promise<Buffer> {
  const key = `${sha256}\0${kind}\0${tag}`;
  const hit = entries.get(key);
  if (hit) {
    entries.delete(key);
    entries.set(key, hit);
    return Promise.resolve(hit);
  }
  const pending = loading.get(key);
  if (pending) return pending;
  const made = slot(async () => {
    const dat = await geoPublicBytes(sha256);
    if (!dat) throw new Error(`geo blob ${sha256} is gone`);
    const index = parseGeoDat(dat, kind);
    const rules = kind === 'geosite' ? geositeRuleSet(dat, index, tag) : geoipRuleSet(dat, index, tag);
    const srs = await compile(rules);
    keep(key, srs);
    return srs;
  }).finally(() => loading.delete(key));
  loading.set(key, made);
  return made;
}

/** For tests. */
export function resetGeoSrsCache(): void {
  entries.clear();
  loading.clear();
  total = 0;
}

export function geoSrsCacheStats(): { files: number; bytes: number } {
  return { files: entries.size, bytes: total };
}
