import {
  parseGeoSite,
  parseGeoIP,
  encodeGeoSite,
  encodeGeoIP,
} from './geo.dat.js';

/**
 * G2 - minimise a full upstream .dat down to only the requested categories,
 * re-encoded as a small .dat clients/nodes can load cheaply (the runetfreedom
 * geosite.dat is ~70MB / 1500 categories; two categories re-encode to a few KB).
 * `missing` names requested categories absent from the source (surfaced to the
 * operator / alerts, as in geo-svc).
 */
export interface MinimizeResult {
  dat: Uint8Array;
  built: string[];
  missing: string[];
}

function minimize<T>(
  full: Map<string, T[]>,
  categories: string[],
  encode: (m: Map<string, T[]>) => Uint8Array,
): MinimizeResult {
  const out = new Map<string, T[]>();
  const built: string[] = [];
  const missing: string[] = [];
  for (const c of categories) {
    const key = c.toUpperCase();
    const v = full.get(key);
    if (v && !out.has(key)) {
      out.set(key, v);
      built.push(c);
    } else if (!v) {
      missing.push(c);
    }
  }
  return { dat: encode(out), built, missing };
}

export function minimizeGeoSite(source: Uint8Array, categories: string[]): MinimizeResult {
  return minimize(parseGeoSite(source), categories, encodeGeoSite);
}

export function minimizeGeoIP(source: Uint8Array, categories: string[]): MinimizeResult {
  return minimize(parseGeoIP(source), categories, encodeGeoIP);
}
