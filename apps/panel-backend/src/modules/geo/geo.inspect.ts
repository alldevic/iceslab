import { fetchDat as defaultFetchDat } from './geo.fetch.js';
import { loadSourceDat } from './geo.sourcecache.js';
import { parseGeoSite, parseGeoIP } from './geo.dat.js';
import { domainMatchers } from './geo.compose.js';
import { cidrToString } from './geo.srs.js';
import type { GeoSource } from './geo.sources.js';

/**
 * Read-only inspection of what categories a source's geosite/geoip .dat actually
 * contains, so an operator can browse the names before referencing one in a
 * custom category. Uses the shared source-bytes cache in 'ifDue' mode, so a
 * fresh build's bytes are reused (no re-download) and only a stale/uncached
 * source is fetched.
 */

const PREVIEW_CAP = 200;

export interface SourceCategories {
  geosite: { name: string; count: number }[];
  geoip: { name: string; count: number }[];
  /** Non-fatal per-database fetch/parse errors (e.g. geoip unreachable). */
  errors: string[];
}

function intervalMs(source: GeoSource): number {
  return Math.max(1, source.refreshIntervalHours) * 3_600_000;
}

export async function listSourceCategories(source: GeoSource): Promise<SourceCategories> {
  const now = Date.now();
  const out: SourceCategories = { geosite: [], geoip: [], errors: [] };
  if (source.geositeUrl) {
    try {
      const bytes = await loadSourceDat(source.geositeUrl, intervalMs(source), 'ifDue', now, defaultFetchDat);
      out.geosite = [...parseGeoSite(bytes)]
        .map(([name, doms]) => ({ name, count: doms.length }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      out.errors.push(`geosite: ${(err as Error).message}`);
    }
  }
  if (source.geoipUrl) {
    try {
      const bytes = await loadSourceDat(source.geoipUrl, intervalMs(source), 'ifDue', now, defaultFetchDat);
      out.geoip = [...parseGeoIP(bytes)]
        .map(([name, cidrs]) => ({ name, count: cidrs.length }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      out.errors.push(`geoip: ${(err as Error).message}`);
    }
  }
  return out;
}

export interface CategoryPreview {
  /** Up to PREVIEW_CAP matcher strings (domains or CIDRs). */
  entries: string[];
  total: number;
  truncated: boolean;
}

/** Sample the entries of one category from a source (domains for geosite, CIDRs
 *  for geoip), capped so a huge category doesn't ship megabytes to the UI. */
export async function previewSourceCategory(
  source: GeoSource,
  kind: 'geosite' | 'geoip',
  name: string,
): Promise<CategoryPreview | null> {
  const now = Date.now();
  const key = name.toUpperCase();
  if (kind === 'geosite') {
    if (!source.geositeUrl) return null;
    const bytes = await loadSourceDat(source.geositeUrl, intervalMs(source), 'ifDue', now, defaultFetchDat);
    // One category, so build one: this runs on an operator keystroke and used
    // to materialise the whole database to answer about a single name.
    const doms = parseGeoSite(bytes, [key]).get(key);
    if (!doms) return null;
    return { entries: domainMatchers(doms.slice(0, PREVIEW_CAP)), total: doms.length, truncated: doms.length > PREVIEW_CAP };
  }
  if (!source.geoipUrl) return null;
  const bytes = await loadSourceDat(source.geoipUrl, intervalMs(source), 'ifDue', now, defaultFetchDat);
  const cidrs = parseGeoIP(bytes, [key]).get(key);
  if (!cidrs) return null;
  return {
    entries: cidrs.slice(0, PREVIEW_CAP).map(cidrToString).filter((s) => s !== ''),
    total: cidrs.length,
    truncated: cidrs.length > PREVIEW_CAP,
  };
}
