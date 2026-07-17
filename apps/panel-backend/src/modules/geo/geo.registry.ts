import {
  buildGeoArtifacts,
  type GeoArtifact,
  type GeoBuildResult,
} from './geo.orchestrator.js';
import type { DatFetcher } from './geo.fetch.js';

/**
 * In-process cache of the last geo build. Building fetches every source .dat
 * (network + parse), so it is explicit (POST /api/geo/build) or lazy on first
 * artifact request - NOT re-run on every source/category edit. Serving reads the
 * cached artifact bytes. Single-process cache (the panel is one process); a
 * multi-replica deploy would move this to shared storage.
 */
interface Cached {
  result: GeoBuildResult;
  builtAt: string;
}
let cached: Cached | null = null;
// Single-flight guard for the LAZY path only: a cold-cache fleet (many nodes
// fetching artifacts right after a config push) must share ONE build instead of
// stampeding. An explicit rebuild (POST /api/geo/build) deliberately does NOT
// join this - see rebuildGeo.
let inflight: Promise<Cached> | null = null;
// Monotonic build ticket. Each build takes one at START; a build only writes
// `cached` if its ticket is still the newest applied. This stops a slow LAZY
// build (started on a cold cache with pre-edit config) from overwriting a
// fresher explicit rebuild that an operator kicked off after an edit.
let buildTicket = 0;
let appliedTicket = 0;

/** Thrown when every configured source failed to fetch (transient outage / the
 *  RU-blocked environment this feature targets). Carries the (uncached) build's
 *  meta so the POST /build route can still show the operator WHICH sources
 *  failed. NOT cached - see runBuild. */
export class GeoBuildAllSourcesFailed extends Error {
  constructor(readonly meta: GeoBuildMeta) {
    super('geo build: every configured source failed to fetch');
    this.name = 'GeoBuildAllSourcesFailed';
  }
}

/** Run one build, caching it UNLESS every configured source failed to fetch
 *  (allSourcesFailed) - caching that would pin an empty "successful" build
 *  forever (no TTL/cron), 404-ing already-distributed client configs. Throws
 *  the typed sentinel instead so the cache stays untouched (next request
 *  retries) while callers fall back to external geo URLs / bundled databases. */
async function runBuild(opts?: { fetchDat?: DatFetcher; respectInterval?: boolean }): Promise<Cached> {
  const ticket = ++buildTicket;
  const result = await buildGeoArtifacts(opts);
  const c: Cached = { result, builtAt: new Date().toISOString() };
  if (result.allSourcesFailed) {
    throw new GeoBuildAllSourcesFailed(toMeta(c));
  }
  // Don't let an older (slower) build clobber a newer one that already applied.
  if (ticket >= appliedTicket) {
    appliedTicket = ticket;
    cached = c;
  }
  return c;
}

/** Lazy, single-flight build for the serve path. */
function buildShared(opts?: { fetchDat?: DatFetcher }): Promise<Cached> {
  if (!inflight) {
    inflight = runBuild(opts).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

export interface GeoBuildMeta {
  builtAt: string;
  categories: GeoBuildResult['categories'];
  sourceErrors: GeoBuildResult['sourceErrors'];
  artifacts: { name: string; sha256: string; size: number }[];
}

/** Flatten every servable artifact (custom .dat + source mirror + .srs). */
function collectArtifacts(r: GeoBuildResult): GeoArtifact[] {
  const all: GeoArtifact[] = [r.geosite, r.geoip];
  if (r.mirror.geosite) all.push(r.mirror.geosite);
  if (r.mirror.geoip) all.push(r.mirror.geoip);
  all.push(...r.ruleSets);
  return all;
}

function toMeta(c: Cached): GeoBuildMeta {
  return {
    builtAt: c.builtAt,
    categories: c.result.categories,
    sourceErrors: c.result.sourceErrors,
    artifacts: collectArtifacts(c.result).map((a) => ({
      name: a.name,
      sha256: a.sha256,
      size: a.bytes.length,
    })),
  };
}

/** Explicit rebuild (POST /api/geo/build, boot warm-up). Always runs a FRESH
 *  build - never joins an in-flight lazy build, whose result may predate the
 *  edit the operator just made and would otherwise be returned+cached as if
 *  fresh. Throws if every source failed (the route surfaces it; warm-up logs). */
export async function rebuildGeo(opts?: {
  fetchDat?: DatFetcher;
  respectInterval?: boolean;
}): Promise<GeoBuildMeta> {
  return toMeta(await runBuild(opts));
}

export function getGeoBuildMeta(): GeoBuildMeta | null {
  return cached ? toMeta(cached) : null;
}

/** Return a built artifact's bytes+sha by name, building lazily on a cold cache.
 *  Uses the build's own result (not the mutable `cached`), so an invalidate
 *  racing the await cannot null it out from under us. */
export async function getGeoArtifact(name: string): Promise<GeoArtifact | null> {
  let c = cached;
  if (!c) {
    try {
      c = await buildShared();
    } catch (err) {
      if (err instanceof GeoBuildAllSourcesFailed) {
        // Our (lazy) build found every source down. A concurrent explicit
        // rebuild may have SUCCEEDED and populated `cached` in the meantime, so
        // re-read it before giving up - otherwise we'd 404 an artifact that is
        // now servable.
        c = cached;
        if (!c) return null; // genuinely nothing built -> 404, next request retries
      } else {
        // Any OTHER error (e.g. a DB outage in getEnabledSources) must propagate
        // to a 5xx, not masquerade as not-found and vanish from monitoring.
        throw err;
      }
    }
  }
  return collectArtifacts(c.result).find((a) => a.name === name) ?? null;
}

/** A composed custom category's domains (xray matcher strings), for inlining
 *  into a subscription. null if not built or unknown. Case-insensitive. */
export function getCategoryDomains(name: string): string[] | null {
  if (!cached) return null;
  const c = cached.result.categoryDomains.find((x) => x.name === name.toUpperCase());
  return c ? c.domains : null;
}

export function invalidateGeoBuild(): void {
  cached = null;
}
