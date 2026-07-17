import { randomUUID } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../prisma.js';
import { assertFetchableUrl } from '../recipes/recipes.ssrf.js';

/**
 * G1 - operator-managed geo sources ("bring your own geo"). Each source points
 * at an upstream geosite.dat and/or geoip.dat that the geo builder (G2) mirrors
 * to nodes and parses to compile minimal per-category artifacts. Stored as a
 * JSON array in the generic app_settings KV table, so no schema migration is
 * needed - the same pattern as recipe sources (recipes.sources.ts). The seeded
 * default points at runetfreedom (the RU-focused v2ray-rules-dat); it is
 * returned only while the operator has never touched the list, so once they
 * edit it their choices (including removing the default) stick.
 */

const SETTINGS_KEY = 'geoSources';

/** Stable id so the default source survives without ever being persisted. */
const DEFAULT_SOURCE_ID = 'default';

/** Default per-source refresh interval (hours) when the operator doesn't set one. */
export const DEFAULT_REFRESH_INTERVAL_HOURS = 24;
const MIN_REFRESH_INTERVAL_HOURS = 1;
const MAX_REFRESH_INTERVAL_HOURS = 24 * 30; // 30 days

function clampInterval(h: unknown): number {
  const n = typeof h === 'number' && Number.isFinite(h) ? Math.round(h) : DEFAULT_REFRESH_INTERVAL_HOURS;
  return Math.min(MAX_REFRESH_INTERVAL_HOURS, Math.max(MIN_REFRESH_INTERVAL_HOURS, n));
}

export interface GeoSource {
  id: string;
  name: string;
  /** URL of an upstream geosite.dat (v2ray/xray format), or null. */
  geositeUrl: string | null;
  /** URL of an upstream geoip.dat, or null. At least one of the two is set. */
  geoipUrl: string | null;
  enabled: boolean;
  /** How often the scheduled refresh re-checks this source upstream (hours). The
   *  check is a conditional GET (ETag), so it's cheap even at a short interval;
   *  a longer interval simply leaves a rarely-updated source alone. */
  refreshIntervalHours: number;
  /** Seeded defaults are trusted; operator-added sources are not (v1 label). */
  trusted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GeoSourceInput {
  name: string;
  geositeUrl?: string | null;
  geoipUrl?: string | null;
  enabled?: boolean;
  refreshIntervalHours?: number;
}

const DEFAULT_SOURCE: GeoSource = {
  id: DEFAULT_SOURCE_ID,
  name: 'runetfreedom (official)',
  geositeUrl:
    process.env.GEO_SOURCE_GEOSITE_URL ??
    'https://github.com/runetfreedom/russia-v2ray-rules-dat/releases/latest/download/geosite.dat',
  geoipUrl:
    process.env.GEO_SOURCE_GEOIP_URL ??
    'https://github.com/runetfreedom/russia-v2ray-rules-dat/releases/latest/download/geoip.dat',
  enabled: true,
  refreshIntervalHours: DEFAULT_REFRESH_INTERVAL_HOURS,
  trusted: true,
  createdAt: '',
  updatedAt: '',
};

/** Defensive parse of the stored JSON: drop anything not source-shaped (needs a
 *  string id and at least one of geositeUrl/geoipUrl). */
function coerceSources(value: unknown): GeoSource[] {
  if (!Array.isArray(value)) return [DEFAULT_SOURCE];
  const out: GeoSource[] = [];
  for (const v of value) {
    if (!v || typeof v !== 'object') continue;
    const s = v as Record<string, unknown>;
    if (typeof s.id !== 'string') continue;
    const geositeUrl = typeof s.geositeUrl === 'string' ? s.geositeUrl : null;
    const geoipUrl = typeof s.geoipUrl === 'string' ? s.geoipUrl : null;
    if (!geositeUrl && !geoipUrl) continue;
    out.push({
      id: String(s.id),
      name: typeof s.name === 'string' && s.name ? s.name : String(s.id),
      geositeUrl,
      geoipUrl,
      enabled: s.enabled !== false,
      refreshIntervalHours: clampInterval(s.refreshIntervalHours),
      trusted: s.trusted === true,
      createdAt: typeof s.createdAt === 'string' ? s.createdAt : '',
      updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : '',
    });
  }
  return out;
}

export async function getSources(): Promise<GeoSource[]> {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } });
  if (!row) return [DEFAULT_SOURCE]; // untouched: offer the curated default
  return coerceSources(row.value);
}

export async function getEnabledSources(): Promise<GeoSource[]> {
  return (await getSources()).filter((s) => s.enabled);
}

export async function getSourceById(id: string): Promise<GeoSource | null> {
  return (await getSources()).find((s) => s.id === id) ?? null;
}

/**
 * Serialize a read-modify-write of the geoSources blob. A transaction-scoped
 * advisory lock keyed on the settings key makes concurrent source mutations
 * (two admin tabs, a double-submit, an API script) apply one after another
 * instead of silently dropping each other (lost update on the shared blob).
 */
async function mutateSources<T>(
  apply: (sources: GeoSource[]) => { next: GeoSource[]; result: T },
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${SETTINGS_KEY}))`;
    const row = await tx.appSetting.findUnique({ where: { key: SETTINGS_KEY } });
    const current = row ? coerceSources(row.value) : [DEFAULT_SOURCE];
    const { next, result } = apply(current);
    const value = next as unknown as Prisma.InputJsonValue;
    await tx.appSetting.upsert({
      where: { key: SETTINGS_KEY },
      create: { key: SETTINGS_KEY, value, isPublic: false },
      update: { value },
    });
    return result;
  });
}

/** Validate the input's URLs (SSRF guard); throws -> 400 in the route. */
function assertSourceUrls(input: Pick<GeoSourceInput, 'geositeUrl' | 'geoipUrl'>): void {
  if (input.geositeUrl) assertFetchableUrl(input.geositeUrl);
  if (input.geoipUrl) assertFetchableUrl(input.geoipUrl);
}

export async function addSource(input: GeoSourceInput): Promise<GeoSource> {
  assertSourceUrls(input);
  const now = new Date().toISOString();
  const source: GeoSource = {
    id: randomUUID(),
    name: input.name.trim(),
    geositeUrl: input.geositeUrl?.trim() || null,
    geoipUrl: input.geoipUrl?.trim() || null,
    enabled: input.enabled ?? true,
    refreshIntervalHours: clampInterval(input.refreshIntervalHours),
    trusted: false,
    createdAt: now,
    updatedAt: now,
  };
  // Persisting [...sources] pins the (possibly virtual) default alongside the
  // new one so it does not silently vanish on first write.
  return mutateSources((sources) => ({ next: [...sources, source], result: source }));
}

export async function updateSource(
  id: string,
  patch: Partial<GeoSourceInput>,
): Promise<GeoSource | null> {
  assertSourceUrls(patch);
  return mutateSources((sources) => {
    const idx = sources.findIndex((s) => s.id === id);
    if (idx === -1) return { next: sources, result: null };
    const existing = sources[idx]!;
    const updated: GeoSource = {
      ...existing,
      name: patch.name?.trim() ?? existing.name,
      // A key present with null clears it; absent leaves it unchanged.
      geositeUrl:
        patch.geositeUrl !== undefined ? patch.geositeUrl?.trim() || null : existing.geositeUrl,
      geoipUrl: patch.geoipUrl !== undefined ? patch.geoipUrl?.trim() || null : existing.geoipUrl,
      enabled: patch.enabled ?? existing.enabled,
      refreshIntervalHours:
        patch.refreshIntervalHours !== undefined
          ? clampInterval(patch.refreshIntervalHours)
          : existing.refreshIntervalHours,
      updatedAt: new Date().toISOString(),
    };
    // A source with no URL left is meaningless; reject the update.
    if (!updated.geositeUrl && !updated.geoipUrl) return { next: sources, result: null };
    const next = [...sources];
    next[idx] = updated;
    return { next, result: updated };
  });
}

export async function deleteSource(id: string): Promise<boolean> {
  return mutateSources((sources) => {
    const next = sources.filter((s) => s.id !== id);
    return { next, result: next.length !== sources.length };
  });
}

/**
 * Reorder the sources to match `orderedIds`. Source list order IS the priority:
 * the full-database MIRROR that clients fetch (geosite.dat / geoip.dat) is the
 * first ENABLED source that provides each database, so moving a source up makes
 * it the mirror. Ids not present are ignored; sources omitted from `orderedIds`
 * keep their relative order at the end (defensive). Materialises the virtual
 * default into the persisted order.
 */
export async function reorderSources(orderedIds: string[]): Promise<GeoSource[]> {
  return mutateSources((sources) => {
    const byId = new Map(sources.map((s) => [s.id, s]));
    const next: GeoSource[] = [];
    for (const id of orderedIds) {
      const s = byId.get(id);
      if (s) {
        next.push(s);
        byId.delete(id);
      }
    }
    for (const s of sources) if (byId.has(s.id)) next.push(s); // leftovers, original order
    return { next, result: next };
  });
}
