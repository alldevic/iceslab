import type { Client } from '../pgutil.js';
import { ident, rows } from '../pgutil.js';
import type { Report } from '../report.js';
import { step, warn } from '../report.js';
import { checkCompositeShape, GeoCompositeError } from '../../../src/modules/geo-sets/geo-composite.js';
import type { GeoCompositeCategory } from '@iceslab/shared';

/**
 * geoSources / geoCategories of the old fork (app_settings) into the geo sets
 * of omega (question 5): a source with its own URLs becomes url sets (one per
 * kind, the default runetfreedom source is not carried: the built-in sets take
 * its place); the categories become two composite sets, `geo-custom` for
 * domains and `geo-custom-ip` for addresses, with the same category names, and
 * `ext:geo-custom.dat:X` in stored rules is rewritten to `ext:geo-custom:x`.
 * Nothing is rolled out to a node: that stays the operator's act, as in omega.
 */

export const COMPOSITE_DOMAIN_SET = 'geo-custom';
export const COMPOSITE_IP_SET = 'geo-custom-ip';
const RESERVED = new Set(['geosite', 'geoip', COMPOSITE_DOMAIN_SET, COMPOSITE_IP_SET]);

export interface OldGeoSource {
  id: string;
  name: string;
  geositeUrl: string | null;
  geoipUrl: string | null;
  enabled: boolean;
  refreshIntervalHours: number;
}
export interface OldGeoCategory {
  id: string;
  name: string;
  domainRefs: Array<{ sourceId: string; category: string }>;
  ipRefs: Array<{ sourceId: string; category: string }>;
  manualDomains: string[];
  manualIps: string[];
  excludeDomains: string[];
  enabled: boolean;
}
export interface PlannedUrlSet {
  name: string;
  kind: 'geosite' | 'geoip';
  url: string;
  refreshHours: number;
  fromSource: string;
}
export interface PlannedComposite {
  name: string;
  kind: 'geosite' | 'geoip';
  categories: GeoCompositeCategory[];
}
export interface GeoPlan {
  urlSets: PlannedUrlSet[];
  composites: PlannedComposite[];
  /** old category name (lower case) -> the tag in the composite set, per old set file. */
  tags: { domain: Map<string, string>; ip: Map<string, string> };
  skipped: Array<{ what: string; reason: string }>;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []);
const refs = (v: unknown): Array<{ sourceId: string; category: string }> =>
  Array.isArray(v)
    ? v.flatMap((r) => {
        const o = (r ?? {}) as Record<string, unknown>;
        return typeof o['sourceId'] === 'string' && typeof o['category'] === 'string' && o['category'] ? [{ sourceId: o['sourceId'], category: o['category'] }] : [];
      })
    : [];

export function coerceSources(v: unknown): OldGeoSource[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    const s = (x ?? {}) as Record<string, unknown>;
    if (typeof s['id'] !== 'string') return [];
    const geositeUrl = str(s['geositeUrl']);
    const geoipUrl = str(s['geoipUrl']);
    if (!geositeUrl && !geoipUrl) return [];
    const h = typeof s['refreshIntervalHours'] === 'number' && Number.isFinite(s['refreshIntervalHours']) ? Math.round(s['refreshIntervalHours']) : 24;
    return [{ id: s['id'], name: str(s['name']) ?? s['id'], geositeUrl, geoipUrl, enabled: s['enabled'] !== false, refreshIntervalHours: Math.min(720, Math.max(1, h)) }];
  });
}

export function coerceCategories(v: unknown): OldGeoCategory[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    const s = (x ?? {}) as Record<string, unknown>;
    if (typeof s['id'] !== 'string' || typeof s['name'] !== 'string' || !s['name']) return [];
    return [
      {
        id: s['id'],
        name: s['name'],
        domainRefs: refs(s['domainRefs']),
        ipRefs: refs(s['ipRefs']),
        manualDomains: strs(s['manualDomains']),
        manualIps: strs(s['manualIps']),
        excludeDomains: strs(s['excludeDomains']),
        enabled: s['enabled'] !== false,
      },
    ];
  });
}

/** A category name as omega's composite names it: `[a-z0-9_-]{1,64}`, so a dot becomes a hyphen. */
export const normalizeTag = (name: string): string => name.toLowerCase().replace(/\./g, '-');

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 27).replace(/-+$/g, '') || 'source';
}

function isHttp(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export function planGeo(sources: OldGeoSource[], categories: OldGeoCategory[], takenNames: ReadonlySet<string>): GeoPlan {
  const plan: GeoPlan = { urlSets: [], composites: [], tags: { domain: new Map(), ip: new Map() }, skipped: [] };
  const used = new Set([...takenNames, ...RESERVED]);
  /** source id -> set names by kind; 'default' is the built-in pair. */
  const setOf = new Map<string, { geosite?: string; geoip?: string }>([['default', { geosite: 'geosite', geoip: 'geoip' }]]);

  for (const s of sources) {
    if (s.id === 'default') continue; // the built-in sets are its successor
    if (!s.enabled) {
      plan.skipped.push({ what: `source "${s.name}"`, reason: 'disabled in the old fork; not carried over (a url set always fetches)' });
      continue;
    }
    const entry: { geosite?: string; geoip?: string } = {};
    for (const [kind, url, suffix] of [['geosite', s.geositeUrl, 'site'], ['geoip', s.geoipUrl, 'ip']] as const) {
      if (!url) continue;
      if (!isHttp(url)) {
        plan.skipped.push({ what: `source "${s.name}" ${kind} url`, reason: `"${url}" is not an http(s) URL` });
        continue;
      }
      let name = `${slug(s.name)}-${suffix}`;
      for (let n = 2; used.has(name); n++) name = `${slug(s.name).slice(0, 27 - String(n).length - 1)}-${n}-${suffix}`.slice(0, 32);
      used.add(name);
      entry[kind] = name;
      plan.urlSets.push({ name, kind, url, refreshHours: s.refreshIntervalHours, fromSource: s.name });
    }
    setOf.set(s.id, entry);
  }

  const domainCats: GeoCompositeCategory[] = [];
  const ipCats: GeoCompositeCategory[] = [];
  for (const c of categories) {
    const tag = normalizeTag(c.name);
    const refsFor = (kind: 'geosite' | 'geoip', list: Array<{ sourceId: string; category: string }>): { ok: GeoCompositeCategory['refs']; why?: string } => {
      const ok: GeoCompositeCategory['refs'] = [];
      for (const r of list) {
        const set = setOf.get(r.sourceId)?.[kind];
        if (!set) return { ok, why: `references source "${r.sourceId}" that is not carried over or has no ${kind} URL` };
        ok.push({ set, tag: r.category.toLowerCase() });
      }
      return { ok };
    };
    const build = (kind: 'geosite' | 'geoip', target: GeoCompositeCategory[], map: Map<string, string>): void => {
      const isDomain = kind === 'geosite';
      const list = isDomain ? c.domainRefs : c.ipRefs;
      const manual = isDomain ? c.manualDomains : c.manualIps;
      if (list.length === 0 && manual.length === 0) return;
      const label = `category "${c.name}" (${isDomain ? 'domains' : 'addresses'})`;
      if (!/^[a-z0-9_-]{1,64}$/.test(tag)) return void plan.skipped.push({ what: label, reason: `the name "${tag}" is not a composite category name (a-z, 0-9, _ and -)` });
      if (target.some((t) => t.name === tag)) return void plan.skipped.push({ what: label, reason: `the name collides with another category once lower-cased ("${tag}")` });
      const r = refsFor(kind, list);
      if (r.why) return void plan.skipped.push({ what: label, reason: r.why });
      const cat: GeoCompositeCategory = { name: tag, refs: r.ok, manual: [...manual], exclude: isDomain ? [...c.excludeDomains] : [], enabled: c.enabled };
      try {
        checkCompositeShape(kind, [cat]);
      } catch (err) {
        if (err instanceof GeoCompositeError) return void plan.skipped.push({ what: label, reason: err.message });
        throw err;
      }
      target.push(cat);
      map.set(c.name.toLowerCase(), tag);
    };
    build('geosite', domainCats, plan.tags.domain);
    build('geoip', ipCats, plan.tags.ip);
    if (c.domainRefs.length + c.manualDomains.length + c.ipRefs.length + c.manualIps.length === 0) {
      plan.skipped.push({ what: `category "${c.name}"`, reason: 'it holds no references and no entries' });
    }
  }
  if (domainCats.length) plan.composites.push({ name: COMPOSITE_DOMAIN_SET, kind: 'geosite', categories: domainCats });
  if (ipCats.length) plan.composites.push({ name: COMPOSITE_IP_SET, kind: 'geoip', categories: ipCats });
  return plan;
}

const EXT = /^(ext|ext-domain|ext-ip):(geo-custom|geo-custom-ip)\.dat:(.+)$/i;

/** A stored matcher with the old file name, rewritten; null when it is none or its category was not carried. */
export function rewriteExt(entry: string, tags: GeoPlan['tags']): { value: string | null; unresolved?: string } {
  const m = EXT.exec(entry);
  if (!m) return { value: null };
  const prefix = m[1]!.toLowerCase();
  const isIpFile = m[2]!.toLowerCase() === 'geo-custom-ip';
  const [rawTag, ...attr] = m[3]!.split('@');
  const tag = (isIpFile ? tags.ip : tags.domain).get(rawTag!.toLowerCase());
  if (!tag) return { value: null, unresolved: entry };
  return { value: `${prefix}:${isIpFile ? COMPOSITE_IP_SET : COMPOSITE_DOMAIN_SET}:${tag}${attr.length ? '@' + attr.join('@') : ''}` };
}

/** Every string of a JSON value, rewritten in place; counts what changed. */
export function rewriteDeep(v: unknown, tags: GeoPlan['tags'], acc: { changed: number; unresolved: string[] }): unknown {
  if (typeof v === 'string') {
    const r = rewriteExt(v, tags);
    if (r.unresolved) acc.unresolved.push(r.unresolved);
    if (r.value !== null) {
      acc.changed++;
      return r.value;
    }
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => rewriteDeep(x, tags, acc));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rewriteDeep(x, tags, acc)]));
  return v;
}

const SKIP_TABLES = new Set(['_prisma_migrations', 'geo_sets', 'geo_set_versions']);

export async function geoStep(c: Client, report: Report): Promise<void> {
  const settings = await rows<{ key: string; value: unknown }>(c, `SELECT key, value FROM app_settings WHERE key IN ('geoSources', 'geoCategories')`);
  const sources = coerceSources(settings.find((s) => s.key === 'geoSources')?.value);
  const categories = coerceCategories(settings.find((s) => s.key === 'geoCategories')?.value);
  const taken = new Set((await rows<{ name: string }>(c, `SELECT name FROM geo_sets`)).map((r) => r.name));
  const plan = planGeo(sources, categories, taken);

  for (const s of plan.urlSets) {
    if (taken.has(s.name)) continue;
    await c.query(
      `INSERT INTO geo_sets (id, name, kind, source_type, url, sha256_source, refresh_hours, status, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'url', $3, 'sidecar', $4, 'checking', now())`,
      [s.name, s.kind, s.url, s.refreshHours],
    );
  }
  for (const k of plan.composites) {
    if (taken.has(k.name)) continue;
    await c.query(
      `INSERT INTO geo_sets (id, name, kind, source_type, composite_def, status, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'composite', $3::jsonb, 'checking', now())`,
      [k.name, k.kind, JSON.stringify(k.categories)],
    );
  }

  // Stored rules: every jsonb and text[] column of the panel's tables.
  const cols = await rows<{ table_name: string; column_name: string; udt_name: string }>(
    c,
    `SELECT table_name, column_name, udt_name FROM information_schema.columns
      WHERE table_schema = 'public' AND udt_name IN ('jsonb', '_text') ORDER BY table_name, column_name`,
  );
  const rewrites: Array<{ column: string; rows: number; entries: number }> = [];
  const acc = { changed: 0, unresolved: [] as string[] };
  for (const col of cols) {
    if (SKIP_TABLES.has(col.table_name)) continue;
    const t = ident(col.table_name);
    const cn = ident(col.column_name);
    const where = col.table_name === 'app_settings' ? `AND key NOT IN ('geoSources', 'geoCategories')` : '';
    const hits = await rows<{ ctid: string; v: unknown }>(c, `SELECT ctid::text AS ctid, ${cn} AS v FROM ${t} WHERE ${cn}::text ILIKE '%geo-custom%' ${where}`);
    let rowsChanged = 0;
    let entries = 0;
    for (const h of hits) {
      const local = { changed: 0, unresolved: acc.unresolved };
      const next = rewriteDeep(h.v, plan.tags, local);
      if (local.changed === 0) continue;
      if (col.udt_name === 'jsonb') await c.query(`UPDATE ${t} SET ${cn} = $1::jsonb WHERE ctid = $2::tid`, [JSON.stringify(next), h.ctid]);
      else await c.query(`UPDATE ${t} SET ${cn} = $1::text[] WHERE ctid = $2::tid`, [next, h.ctid]);
      rowsChanged++;
      entries += local.changed;
    }
    if (rowsChanged) rewrites.push({ column: `${col.table_name}.${col.column_name}`, rows: rowsChanged, entries });
    acc.changed += entries;
  }
  if (acc.unresolved.length) {
    warn(report, 'geo-ext-unresolved', `${acc.unresolved.length} stored matchers name a geo-custom category that was not carried over`, [...new Set(acc.unresolved)]);
  }
  if (plan.skipped.length) warn(report, 'geo-not-carried', `${plan.skipped.length} geo sources or categories were not carried over`, plan.skipped);
  if (plan.urlSets.length || plan.composites.length) {
    warn(
      report,
      'geo-rollout',
      'geo sets were created but nothing was rolled out: the url sets are fetched by the panel, the composite sets build after their sources, and each is rolled out to nodes by the operator',
      { urlSets: plan.urlSets.map((s) => s.name), composites: plan.composites.map((s) => s.name) },
    );
  }
  report.data['geo'] = { urlSets: plan.urlSets, composites: plan.composites, skipped: plan.skipped, rewrites, unresolved: [...new Set(acc.unresolved)] };
  step(report, {
    step: 'geo',
    status: 'done',
    summary: `${plan.urlSets.length} url sets, ${plan.composites.length} composite sets (${plan.composites.reduce((n, k) => n + k.categories.length, 0)} categories); ${acc.changed} stored matchers rewritten; ${plan.skipped.length} skipped`,
  });
}
