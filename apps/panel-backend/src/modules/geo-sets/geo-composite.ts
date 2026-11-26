import {
  GEO_COMPOSITE_CATEGORY_NAME,
  GEO_COMPOSITE_LIMITS,
  type GeoCompositeCategory,
  type GeoSetKind,
} from '@iceslab/shared';
import { geoipEntries, geositeEntries, type GeoDatIndex } from './geo-dat.js';
import { encodeGeoIPList, encodeGeoSiteList, parseCidr, type GeoCidr, type GeoSiteDomain } from './geo-formats.js';

/**
 * A composite set's file: the categories of the definition, each the entries
 * of the categories it names in other sets plus the operator's own, repeats
 * and exclusions taken out, encoded as a v2fly `.dat`. Pure: the caller
 * brings the sources already read (geo-sets.store.ts buildCompositeSet).
 */

/** A definition or a manual entry that cannot be built, said with where. */
export class GeoCompositeError extends Error {
  constructor(
    message: string,
    public readonly at: { category?: string; entry?: string } = {},
  ) {
    super(message);
    this.name = 'GeoCompositeError';
  }
}

/** A source set read once: its current `.dat` and the index over it. */
export interface CompositeSource {
  buf: Uint8Array;
  index: GeoDatIndex;
}

const PREFIXES = { domain: 'domain', full: 'full', keyword: 'plain', regexp: 'regex' } as const;

/**
 * A structural check of a `regexp:` pattern, which xray reads as Go RE2 (not
 * as JavaScript: `new RegExp` refuses `(?P<n>x)`, `[[:alpha:]]`, `\\pL`, `(?i)`
 * that RE2 takes, and takes lookahead that RE2 refuses, so it is no judge).
 * Deliberately conservative: only what RE2 refuses on any reading is refused
 * here, an unbalanced or unclosed group, an unclosed `[`, a trailing `\\`, and a
 * repetition operator with nothing before it. Null when no such fault; else
 * the words for it.
 */
export function regexpProblem(pattern: string): string | null {
  let depth = 0;
  let canRepeat = false; // something in front of `*`, `+`, `?`
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '\\') {
      if (i === pattern.length - 1) return 'ends with a lone backslash';
      i++;
      canRepeat = true;
    } else if (c === '[') {
      let j = i + 1;
      if (pattern[j] === '^') j++;
      if (pattern[j] === ']') j++; // a `]` first is a member
      for (; j < pattern.length && pattern[j] !== ']'; j++) {
        if (pattern[j] === '\\') j++;
        else if (pattern[j] === '[' && pattern[j + 1] === ':') {
          const end = pattern.indexOf(':]', j + 2);
          if (end !== -1) j = end + 1;
        }
      }
      if (j >= pattern.length) return 'has a "[" that is never closed';
      i = j;
      canRepeat = true;
    } else if (c === '(') {
      depth++;
      canRepeat = false;
      if (pattern[i + 1] === '?') i++; // `(?:`, `(?i)`, `(?P<n>`: the flag letters are no operators
      // `(?i)` and `(?P<n>` carry on as plain characters below.
    } else if (c === ')') {
      if (--depth < 0) return 'has a ")" with no "("';
      canRepeat = true;
    } else if (c === '|') {
      canRepeat = false;
    } else if (c === '*' || c === '+' || c === '?') {
      if (!canRepeat) return `has "${c}" with nothing to repeat`;
      // `a*?` is lazy, `a**` is refused by RE2 too; leave that to the node's own check.
    } else {
      canRepeat = true;
    }
  }
  return depth > 0 ? 'has a "(" that is never closed' : null;
}

/**
 * One typed domain entry: `example.com` and `domain:example.com` match the
 * domain and its subdomains, `full:` the name alone, `keyword:` a substring,
 * `regexp:` a pattern. Null when it is none of these.
 */
export function parseManualDomain(text: string): GeoSiteDomain | null {
  const t = text.trim();
  const m = /^(domain|full|keyword|regexp):(.*)$/.exec(t);
  const kind = m ? (m[1] as keyof typeof PREFIXES) : 'domain';
  const value = (m ? m[2]! : t).trim();
  if (value === '') return null;
  if (kind === 'regexp') return regexpProblem(value) === null ? { type: 'regex', value } : null;
  // A name, not a URL, an address with a port or an `@attr` of a v2fly list.
  if (/[\s/:@]/.test(value)) return null;
  return { type: PREFIXES[kind], value: value.toLowerCase() };
}

/** Where a category names what is wrong, for the editor to point at. */
function bad(category: string, entry: string, why: string): GeoCompositeError {
  return new GeoCompositeError(`category "${category}": "${entry}" ${why}`, { category, entry });
}

/** The shape checks that need no other set: names, limits, typed entries. */
export function checkCompositeShape(kind: GeoSetKind, categories: GeoCompositeCategory[]): void {
  const L = GEO_COMPOSITE_LIMITS;
  if (categories.length > L.categories) {
    throw new GeoCompositeError(`a composite set has at most ${L.categories} categories`);
  }
  const seen = new Set<string>();
  for (const c of categories) {
    if (!GEO_COMPOSITE_CATEGORY_NAME.test(c.name)) {
      throw new GeoCompositeError(`category name "${c.name}": 1 to 64 of a-z, 0-9, "_" and "-"`, { category: c.name });
    }
    if (seen.has(c.name)) throw new GeoCompositeError(`category "${c.name}" is named twice`, { category: c.name });
    seen.add(c.name);
    if (c.refs.length > L.refs) throw new GeoCompositeError(`category "${c.name}": at most ${L.refs} references`, { category: c.name });
    if (c.manual.length > L.entries || c.exclude.length > L.entries) {
      throw new GeoCompositeError(`category "${c.name}": at most ${L.entries} manual entries and ${L.entries} exclusions`, { category: c.name });
    }
    for (const e of c.manual) {
      if (e.length > L.entryLength) throw bad(c.name, e.slice(0, 40) + '...', `is longer than ${L.entryLength} characters`);
      if (kind === 'geosite' && /^regexp:/.test(e.trim())) {
        const why = regexpProblem(e.trim().slice(7).trim());
        if (why || e.trim().slice(7).trim() === '') throw bad(c.name, e, `is not a valid regular expression: ${why ?? 'empty'}`);
      }
      if (kind === 'geosite' ? !parseManualDomain(e) : !parseCidr(e)) {
        throw bad(c.name, e, kind === 'geosite' ? 'is not a domain entry (example.com, domain:, full:, keyword: or regexp:)' : 'is not an address or a CIDR');
      }
    }
    for (const e of c.exclude) {
      if (e.length > L.entryLength) throw bad(c.name, e.slice(0, 40) + '...', `is longer than ${L.entryLength} characters`);
      if (kind === 'geosite' ? e.trim() === '' : !parseCidr(e)) {
        throw bad(c.name, e, kind === 'geosite' ? 'is empty' : 'is not an address or a CIDR');
      }
    }
  }
}

const cidrKey = (c: GeoCidr) => `${Buffer.from(c.ip).toString('hex')}/${c.prefix}`;

/**
 * The entries of one category. `sources` is by set name; a reference to a set
 * or a tag that is not there is an error naming it, never a smaller list.
 */
export function composeCategory(
  kind: GeoSetKind,
  c: GeoCompositeCategory,
  sources: ReadonlyMap<string, CompositeSource>,
): { domains: GeoSiteDomain[]; cidrs: GeoCidr[] } {
  const domains: GeoSiteDomain[] = [];
  const cidrs: GeoCidr[] = [];
  const seen = new Set<string>();
  const dropDomain = new Set(c.exclude.map((x) => x.trim().toLowerCase()));
  const dropCidr = new Set(
    kind === 'geoip' ? c.exclude.map((x) => cidrKey(parseCidr(x)!)) : [],
  );
  const add = (d: GeoSiteDomain | null, ip: GeoCidr | null): void => {
    if (d) {
      if (dropDomain.has(d.value.toLowerCase())) return;
      const k = `${d.type}:${d.value}`;
      if (seen.has(k)) return;
      seen.add(k);
      domains.push(d);
    } else if (ip) {
      const k = cidrKey(ip);
      if (dropCidr.has(k) || seen.has(k)) return;
      seen.add(k);
      cidrs.push(ip);
    }
  };
  for (const ref of c.refs) {
    const src = sources.get(ref.set);
    if (!src) throw new GeoCompositeError(`category "${c.name}": set "${ref.set}" has no readable version`, { category: c.name, entry: `${ref.set}:${ref.tag}` });
    if (!src.index.tags.some((t) => t.name === ref.tag.toLowerCase())) {
      throw new GeoCompositeError(`category "${c.name}": set "${ref.set}" has no category "${ref.tag}"`, { category: c.name, entry: `${ref.set}:${ref.tag}` });
    }
    if (kind === 'geosite') for (const d of geositeEntries(src.buf, src.index, ref.tag)) add(d, null);
    else for (const ip of geoipEntries(src.buf, src.index, ref.tag)) add(null, ip);
  }
  for (const e of c.manual) {
    if (kind === 'geosite') {
      const d = parseManualDomain(e);
      if (!d) throw bad(c.name, e, 'is not a domain entry');
      add(d, null);
    } else {
      const ip = parseCidr(e);
      if (!ip) throw bad(c.name, e, 'is not an address or a CIDR');
      add(null, ip);
    }
  }
  return { domains, cidrs };
}

/**
 * The `.dat` of the whole definition. A disabled category, and one that comes
 * out empty, is left out of the file (xray refuses a tag with no entries), so
 * a rule that names it shows up in the rollout plan as a tag gone. Throws
 * GeoCompositeError for the first thing that cannot be built; `null` when
 * nothing is left to write.
 */
export function buildCompositeDat(
  kind: GeoSetKind,
  categories: GeoCompositeCategory[],
  sources: ReadonlyMap<string, CompositeSource>,
): Uint8Array | null {
  const sites: { code: string; domains: GeoSiteDomain[] }[] = [];
  const ips: { code: string; cidrs: GeoCidr[] }[] = [];
  for (const c of categories) {
    if (!c.enabled) continue;
    const { domains, cidrs } = composeCategory(kind, c, sources);
    // xray upper-cases the rule's tag and compares bytes (see parseGeoDat).
    const code = c.name.toUpperCase();
    if (domains.length > 0) sites.push({ code, domains });
    if (cidrs.length > 0) ips.push({ code, cidrs });
  }
  if (kind === 'geosite') return sites.length > 0 ? encodeGeoSiteList(sites) : null;
  return ips.length > 0 ? encodeGeoIPList(ips) : null;
}
