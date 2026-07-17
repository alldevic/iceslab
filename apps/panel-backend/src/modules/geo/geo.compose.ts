import { encodeGeoSite, encodeGeoIP, type Domain, type CIDR } from './geo.dat.js';

/**
 * G3 - the custom-category editor engine. Compose YOUR OWN geosite/geoip
 * category by merging chosen categories from several parsed source .dats plus
 * hand-added domains/IPs, deduped, with optional exclusions. Pure + testable;
 * the fetch/build glue parses each source's .dat once and passes the maps here.
 * The result feeds encodeGeoSite/encodeGeoIP to emit an `ext:geo-custom.dat:<name>`
 * artifact that the node/client references.
 */

/** A category pulled from one parsed geosite.dat source. */
export interface DomainSourceRef {
  site: Map<string, Domain[]>;
  category: string;
}
/** A category pulled from one parsed geoip.dat source. */
export interface IpSourceRef {
  ip: Map<string, CIDR[]>;
  category: string;
}

export interface CustomCategorySpec {
  /** Custom category name (referenced as ext:<file>.dat:<name>). */
  name: string;
  domainSources?: DomainSourceRef[];
  /** "example.com" (suffix), or prefixed "full:"/"domain:"/"keyword:"/"regexp:". */
  manualDomains?: string[];
  /** Exact domain values to drop from the merged set (case-insensitive). */
  excludeDomains?: string[];
  ipSources?: IpSourceRef[];
  /** "1.2.3.0/24", "2001:db8::/32", or a bare address (host route). */
  manualIps?: string[];
}

export interface ComposedCategory {
  /** UPPERCASED (xray lookup semantics). */
  name: string;
  domains: Domain[];
  cidrs: CIDR[];
  /** Referenced source categories that were absent (geosite:x / geoip:y). */
  missing: string[];
}

// xray domain matcher prefixes -> Domain.type.
const DOMAIN_PREFIX: Record<string, number> = { keyword: 0, regexp: 1, domain: 2, full: 3 };

/** Parse a manual domain string into a Domain (bare = suffix/type 2). */
export function parseManualDomain(s: string): Domain {
  const m = /^(domain|full|regexp|keyword):(.+)$/.exec(s.trim());
  if (m) return { type: DOMAIN_PREFIX[m[1]!]!, value: m[2]!.trim() };
  return { type: 2, value: s.trim() };
}

/** Parse "1"-"3" digits strictly (`Number('')` is 0, so "1.2.3.4/" would
 *  otherwise read as prefix 0 = match-everything). */
function parseDecByte(s: string | undefined, max: number): number | null {
  if (s === undefined || !/^\d{1,3}$/.test(s)) return null;
  const n = Number(s);
  return n <= max ? n : null;
}

/** Parse "addr" or "addr/prefix" (v4 or v6) into a CIDR, or null if malformed. */
export function parseCidr(s: string): CIDR | null {
  const raw = s.trim();
  const slash = raw.lastIndexOf('/');
  const addr = slash >= 0 ? raw.slice(0, slash) : raw;
  const pfxStr = slash >= 0 ? raw.slice(slash + 1) : undefined;
  if (!addr) return null;

  if (addr.includes(':')) {
    const ip = parseV6(addr);
    if (!ip) return null;
    const prefix = pfxStr !== undefined ? parseDecByte(pfxStr, 128) : 128;
    if (prefix === null) return null;
    return { ip, prefix };
  }
  const parts = addr.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const n = parseDecByte(parts[i], 255);
    if (n === null) return null;
    bytes[i] = n;
  }
  const prefix = pfxStr !== undefined ? parseDecByte(pfxStr, 32) : 32;
  if (prefix === null) return null;
  return { ip: bytes, prefix };
}

function parseV6(addr: string): Uint8Array | null {
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let hextets: string[];
  if (tail === null) {
    hextets = head;
    if (hextets.length !== 8) return null; // no "::" -> must be full
  } else {
    const zeros = 8 - head.length - tail.length;
    if (zeros < 1) return null; // "::" stands for >= 1 zero group
    hextets = [...head, ...Array<string>(zeros).fill('0'), ...tail];
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const h = hextets[i];
    if (h === undefined || !/^[0-9a-fA-F]{1,4}$/.test(h)) return null;
    const n = parseInt(h, 16);
    bytes[i * 2] = n >> 8;
    bytes[i * 2 + 1] = n & 0xff;
  }
  return bytes;
}

export function composeCategory(spec: CustomCategorySpec): ComposedCategory {
  const missing: string[] = [];

  const domains: Domain[] = [];
  const seenD = new Set<string>();
  const excl = new Set((spec.excludeDomains ?? []).map((x) => x.trim().toLowerCase()));
  const addDomain = (d: Domain): void => {
    if (!d.value) return;
    if (excl.has(d.value.toLowerCase())) return;
    const k = `${d.type}:${d.value.toLowerCase()}`;
    if (seenD.has(k)) return;
    seenD.add(k);
    domains.push(d);
  };
  for (const ref of spec.domainSources ?? []) {
    const list = ref.site.get(ref.category.toUpperCase());
    if (!list) {
      missing.push(`geosite:${ref.category}`);
      continue;
    }
    for (const d of list) addDomain(d);
  }
  for (const s of spec.manualDomains ?? []) if (s.trim()) addDomain(parseManualDomain(s));

  const cidrs: CIDR[] = [];
  const seenI = new Set<string>();
  const addCidr = (c: CIDR): void => {
    const k = `${c.prefix}/${Array.from(c.ip).join(',')}`;
    if (seenI.has(k)) return;
    seenI.add(k);
    cidrs.push(c);
  };
  for (const ref of spec.ipSources ?? []) {
    const list = ref.ip.get(ref.category.toUpperCase());
    if (!list) {
      missing.push(`geoip:${ref.category}`);
      continue;
    }
    for (const c of list) addCidr(c);
  }
  for (const s of spec.manualIps ?? []) {
    if (!s.trim()) continue;
    const c = parseCidr(s);
    if (c) addCidr(c); // invalid manual CIDRs are dropped (validated at the schema edge)
  }

  return { name: spec.name.toUpperCase(), domains, cidrs, missing };
}

/**
 * Render a category's domains as matcher strings for inlining a custom category
 * into a client subscription (xray-json/xkeen and clash, which cannot fetch a
 * remote .dat). type 2 suffix -> `domain:`, 3 full -> `full:`, 1 regex ->
 * `regexp:`, 0 keyword -> `keyword:`. NOTE the keyword prefix is EXPLICIT (not a
 * bare string): a bare token is ambiguous with an operator's bare suffix domain,
 * and clash's renderer defaults a bare token to DOMAIN-SUFFIX, which would
 * silently narrow a keyword ("doubleclick") to a suffix (missing
 * "doubleclick.net"). Each format maps `keyword:` to its own type - clash ->
 * DOMAIN-KEYWORD, xray-json strips it to a bare substring matcher (xray has no
 * `keyword:` prefix; a plain string already IS a substring match).
 */
export function domainMatchers(domains: Domain[]): string[] {
  return domains.map((d) => {
    if (d.type === 3) return `full:${d.value}`;
    if (d.type === 1) return `regexp:${d.value}`;
    if (d.type === 0) return `keyword:${d.value}`;
    return `domain:${d.value}`;
  });
}

/** Emit a geosite.dat carrying the composed categories that have domains. */
export function composedToGeoSiteDat(cats: ComposedCategory[]): Uint8Array {
  const m = new Map<string, Domain[]>();
  for (const c of cats) if (c.domains.length > 0) m.set(c.name, c.domains);
  return encodeGeoSite(m);
}

/** Emit a geoip.dat carrying the composed categories that have CIDRs. */
export function composedToGeoIPDat(cats: ComposedCategory[]): Uint8Array {
  const m = new Map<string, CIDR[]>();
  for (const c of cats) if (c.cidrs.length > 0) m.set(c.name, c.cidrs);
  return encodeGeoIP(m);
}
