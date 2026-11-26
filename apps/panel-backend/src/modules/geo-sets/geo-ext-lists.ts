import { GEO_SET_NAME, GEO_SRS_NAME, type GeoSetKind } from '@iceslab/shared';
import { getLogger } from '../../lib/infra/logger.js';
import { geoPublicBytes } from './geo-public-cache.js';
import { geositeEntries, parseGeoDat } from './geo-dat.js';
import { srsFileName } from './geo-names.js';
import { servedSet, type SelfHostedGeo } from './geo-self-host.js';

/**
 * `ext:<set>:<category>` in the operator's custom domain lists (milestone 10.6).
 * A client cannot resolve it (the set is not on the device), so the subscription
 * does: xray-json and clash get the category's domains, sing-box a link to the
 * category's `.srs` on the panel. Only while the panel serves its geo files
 * (GEO_SELF_HOST: `selfHostedGeo()` is not null); off, the entry goes out as the
 * base always sent it. A link that cannot be resolved is left out and logged.
 *
 * Only `geosite`-kind sets: the lists are of domains. A category is a plain tag,
 * no `@attribute` and no `!`: the domains of a list are not filtered.
 */
export type CustomDomainLists = { direct: string[]; proxy: string[]; block: string[] };
const BUCKETS = ['block', 'direct', 'proxy'] as const;
export type ListBucket = (typeof BUCKETS)[number];

/** Per category: what a big built-in category (tens of thousands) would add to every subscription fetch. */
export const EXT_LIST_MAX_ENTRIES = 5000;

const TAG = /^[a-z0-9_-]{1,64}$/;

export interface ExtListRef {
  set: string;
  /** Lower case. */
  tag: string;
}

/** The link in a list entry, or null for any other entry (and a link that is spelled wrong). */
export function parseExtListEntry(entry: string): ExtListRef | null {
  const parts = entry.trim().split(':');
  if (parts.length !== 3 || parts[0] !== 'ext') return null;
  const [, set, tag] = parts as [string, string, string];
  const t = tag.toLowerCase();
  return GEO_SET_NAME.test(set) && TAG.test(t) ? { set, tag: t } : null;
}

/** An entry that starts like a link: whether or not it parses, it is not a domain. */
const looksLikeExt = (entry: string): boolean => entry.trim().startsWith('ext:');

export function hasExtEntries(lists: CustomDomainLists): boolean {
  return BUCKETS.some((b) => lists[b].some(looksLikeExt));
}

interface Warn {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

// Domains by (version sha256, category): the content under it never changes, and
// reading it is a parse of the whole `.dat`. A category over the limit is kept as
// its size, so it is not read again either.
const MEMO_MAX = 128;
const memo = new Map<string, string[] | number>();

/** For tests. */
export function resetExtListMemo(): void {
  memo.clear();
}

const PREFIX = { plain: 'keyword:', regex: 'regexp:', domain: 'domain:', full: 'full:' } as const;

async function categoryEntries(sha256: string, tag: string): Promise<string[] | number | null> {
  const key = `${sha256}\0${tag}`;
  const hit = memo.get(key);
  if (hit !== undefined) {
    memo.delete(key);
    memo.set(key, hit);
    return hit;
  }
  const dat = await geoPublicBytes(sha256);
  if (!dat) return null;
  const all = geositeEntries(dat, parseGeoDat(dat, 'geosite'), tag);
  const out = new Set(all.map((d) => `${PREFIX[d.type]}${d.value}`));
  const value = out.size > EXT_LIST_MAX_ENTRIES ? out.size : [...out];
  memo.set(key, value);
  for (const k of memo.keys()) {
    if (memo.size <= MEMO_MAX) break;
    memo.delete(k);
  }
  return value;
}

/** A served `geosite`-kind set that has the category, or null. */
async function servedCategory(ref: ExtListRef) {
  const set = await servedSet(ref.set);
  return set && (set.kind as GeoSetKind) === 'geosite' && set.tags.has(ref.tag) ? set : null;
}

/** The category's domains with xray's prefixes, or null (and why in the log) when the link cannot be resolved. */
async function resolveExt(entry: string, log: Warn): Promise<string[] | null> {
  const ref = parseExtListEntry(entry);
  if (!ref) {
    log.warn({ entry }, 'subscription: ext: entry is not ext:<set>:<category>, left out');
    return null;
  }
  const set = await servedCategory(ref);
  if (!set) {
    log.warn({ entry }, 'subscription: ext: set or category is not served (missing, not a domain set, no verified version), left out');
    return null;
  }
  const got = await categoryEntries(set.sha256, ref.tag);
  if (got === null) {
    log.warn({ entry }, 'subscription: ext: the set file is gone, left out');
    return null;
  }
  if (typeof got === 'number') {
    log.warn({ entry, entries: got, limit: EXT_LIST_MAX_ENTRIES }, 'subscription: ext: category is over the entry limit, left out');
    return null;
  }
  return got;
}

/**
 * The lists for xray-json and clash: every `ext:` entry replaced, in its place,
 * by the category's domains; one that cannot be resolved is left out. The lists
 * come back as they are while the panel does not serve (`geo` null) or holds no link.
 */
export async function expandExtLists(
  lists: CustomDomainLists,
  geo: SelfHostedGeo | null,
  log: Warn = getLogger(),
): Promise<CustomDomainLists> {
  if (!geo || !hasExtEntries(lists)) return lists;
  const out: CustomDomainLists = { direct: [], proxy: [], block: [] };
  for (const b of BUCKETS) {
    for (const entry of lists[b]) {
      if (!looksLikeExt(entry)) out[b].push(entry);
      else out[b].push(...((await resolveExt(entry, log)) ?? []));
    }
  }
  return out;
}

/** One category as a sing-box remote rule-set, with the list it came from. */
export interface SingboxExtRef {
  bucket: ListBucket;
  /** The rule-set's tag: the `.srs` file's name without the extension. */
  tag: string;
  url: string;
}

/**
 * The `ext:` entries for sing-box: only where the panel can hand the `.srs` out
 * (a sing-box to compile it, a served domain set with the category); no limit,
 * the link is to a file. Each file once per list, in the lists' order.
 */
export async function singboxExtRefs(
  lists: CustomDomainLists,
  geo: SelfHostedGeo | null,
  log: Warn = getLogger(),
): Promise<SingboxExtRef[]> {
  if (!geo || !hasExtEntries(lists)) return [];
  const out: SingboxExtRef[] = [];
  for (const bucket of BUCKETS) {
    for (const entry of lists[bucket]) {
      if (!looksLikeExt(entry)) continue;
      const ref = parseExtListEntry(entry);
      const set = ref && geo.srs ? await servedCategory(ref) : null;
      if (!ref || !set) {
        log.warn({ entry, srs: geo.srs }, 'subscription: ext: not served as a rule-set (spelling, set, category or no sing-box), left out');
        continue;
      }
      const file = srsFileName(set, ref.tag);
      const tag = file.slice(0, -'.srs'.length);
      if (!GEO_SRS_NAME.test(file) || out.some((r) => r.bucket === bucket && r.tag === tag)) continue;
      out.push({ bucket, tag, url: `${geo.baseUrl}/${file}` });
    }
  }
  return out;
}
