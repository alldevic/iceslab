import { createHash } from 'node:crypto';
import { getEnabledSources } from './geo.sources.js';
import { getEnabledCategories } from './geo.categories.js';
import { parseGeoSite, parseGeoIP, type Domain, type CIDR } from './geo.dat.js';
import {
  composeCategory,
  composedToGeoSiteDat,
  composedToGeoIPDat,
  domainMatchers,
  type ComposedCategory,
} from './geo.compose.js';
import { fetchDat as defaultFetchDat, type DatFetcher } from './geo.fetch.js';
import { loadSourceDat } from './geo.sourcecache.js';
import { compileSrs } from './geo.srs.js';
import { config } from '../../config.js';

/**
 * G2/G3 glue - the build orchestrator. Fetches every enabled source's
 * geosite/geoip .dat once, parses each, composes every enabled custom-category
 * spec against them, and emits two minimal artifacts (geo-custom.dat +
 * geo-custom-ip.dat) with sha256s. The fetcher is injected so the whole pipe is
 * unit-testable without network. A source whose fetch/parse fails is recorded
 * in `sourceErrors` and simply contributes nothing (its refs surface as
 * `missing` on the affected categories) rather than failing the whole build.
 */

export interface GeoArtifact {
  /** ext: filename the node/client references (geo-custom.dat / geo-custom-ip.dat). */
  name: string;
  bytes: Uint8Array;
  sha256: string;
}

export interface GeoBuildResult {
  geosite: GeoArtifact;
  geoip: GeoArtifact;
  /** Full-database passthrough of the primary (first enabled) source, so the
   *  fleet fetches standard categories from the panel instead of GitHub/jsdelivr
   *  (unstable from RU). null when no source provided that database. */
  mirror: { geosite: GeoArtifact | null; geoip: GeoArtifact | null };
  /** Per-category sing-box .srs rule-sets (named `<x>.srs`), compiled from the
   *  mirror when SINGBOX_BIN is configured; empty otherwise. */
  ruleSets: GeoArtifact[];
  /** Composed custom categories' domains as xray matcher strings, for inlining
   *  a category into a subscription that cannot fetch a remote .dat. */
  categoryDomains: { name: string; domains: string[] }[];
  categories: { name: string; domains: number; cidrs: number; missing: string[] }[];
  sourceErrors: { sourceId: string; url: string; error: string }[];
  /** True when sources WERE configured but every fetch failed (no mirror at
   *  all) - a transient upstream/network outage, not a legitimately empty
   *  build. The registry refuses to cache this so the next request retries
   *  instead of serving an empty build forever. */
  allSourcesFailed: boolean;
}

export const GEO_SITE_ARTIFACT = 'geo-custom.dat';
export const GEO_IP_ARTIFACT = 'geo-custom-ip.dat';
export const GEO_MIRROR_SITE = 'geosite.dat';
export const GEO_MIRROR_IP = 'geoip.dat';

/** The sing-box .srs artifact name for an operator custom category, referenced
 *  by the sing-box subscription as a self-hosted remote rule-set. Category names
 *  are already tag-safe ([A-Za-z0-9._-], see geo.schemas), so the tag
 *  `custom-<name>` and its `.srs` file need no further sanitisation. */
export function customSrsName(category: string): string {
  return `custom-${category}.srs`;
}

/**
 * The custom categories that get their own sing-box .srs, with the artifact name
 * each will be served under. DOMAIN-ONLY selection (a category with no domains is
 * skipped) so sing-box matches the xray/clash inline path (getCategoryDomains is
 * domains-only) instead of silently blocking/routing IPs the other formats leak.
 * Pure - the compile loop iterates this, so a test can assert selection + naming
 * without a sing-box binary.
 */
export function plannedCustomSrs(
  composed: ComposedCategory[],
): { category: ComposedCategory; artifact: string }[] {
  return composed
    .filter((c) => c.domains.length > 0)
    .map((c) => ({ category: c, artifact: customSrsName(c.name) }));
}

// Standard preset categories the sing-box subscription format references; their
// .srs are compiled from the mirror so sing-box fetches them from the panel.
const SRS_GEOSITE = ['category-ads-all', 'category-ru', 'category-gov-ru', 'cn'];
const SRS_GEOIP = ['ru', 'cn'];

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function buildGeoArtifacts(opts?: {
  fetchDat?: DatFetcher;
  singboxBin?: string;
  /** true = only re-fetch sources whose per-source refresh interval elapsed
   *  (reuse cached bytes otherwise); false/undefined = revalidate every source
   *  (conditional GET, cheap on 304). The cron passes true; manual/lazy/warm-up
   *  builds pass false. */
  respectInterval?: boolean;
}): Promise<GeoBuildResult> {
  const fetchDat = opts?.fetchDat ?? defaultFetchDat;
  const singboxBin = opts?.singboxBin ?? config.SINGBOX_BIN;
  const mode = opts?.respectInterval ? 'ifDue' : 'force';
  const now = Date.now();
  const sources = await getEnabledSources();
  const specs = await getEnabledCategories();
  const attemptedSources = sources.filter((s) => s.geositeUrl || s.geoipUrl).length;

  const intervalMs = (s: { refreshIntervalHours: number }): number =>
    Math.max(1, s.refreshIntervalHours) * 3_600_000;

  // Fetch + parse each source's .dat once, keyed by sourceId. A failure is
  // recorded and the source is skipped (degrade, don't fail the build).
  const siteMaps = new Map<string, Map<string, Domain[]>>();
  const ipMaps = new Map<string, Map<string, CIDR[]>>();
  const sourceErrors: GeoBuildResult['sourceErrors'] = [];
  // Full-database mirror = raw bytes of the first source that provides each db.
  let mirrorSite: GeoArtifact | null = null;
  let mirrorIp: GeoArtifact | null = null;
  for (const s of sources) {
    if (s.geositeUrl) {
      try {
        const bytes = await loadSourceDat(s.geositeUrl, intervalMs(s), mode, now, fetchDat);
        siteMaps.set(s.id, parseGeoSite(bytes));
        if (!mirrorSite) mirrorSite = { name: GEO_MIRROR_SITE, bytes, sha256: sha256(bytes) };
      } catch (err) {
        sourceErrors.push({ sourceId: s.id, url: s.geositeUrl, error: (err as Error).message });
      }
    }
    if (s.geoipUrl) {
      try {
        const bytes = await loadSourceDat(s.geoipUrl, intervalMs(s), mode, now, fetchDat);
        ipMaps.set(s.id, parseGeoIP(bytes));
        if (!mirrorIp) mirrorIp = { name: GEO_MIRROR_IP, bytes, sha256: sha256(bytes) };
      } catch (err) {
        sourceErrors.push({ sourceId: s.id, url: s.geoipUrl, error: (err as Error).message });
      }
    }
  }

  const composed = specs.map((spec) =>
    composeCategory({
      name: spec.name,
      domainSources: spec.domainRefs.map((r) => ({
        site: siteMaps.get(r.sourceId) ?? new Map(),
        category: r.category,
      })),
      ipSources: spec.ipRefs.map((r) => ({
        ip: ipMaps.get(r.sourceId) ?? new Map(),
        category: r.category,
      })),
      manualDomains: spec.manualDomains,
      manualIps: spec.manualIps,
      excludeDomains: spec.excludeDomains,
    }),
  );

  const geositeBytes = composedToGeoSiteDat(composed);
  const geoipBytes = composedToGeoIPDat(composed);

  // Compile the standard preset categories to sing-box .srs from the mirror, so
  // the sing-box format fetches them from the panel. Best-effort: a compile
  // failure (or no binary) just omits that .srs.
  const ruleSets: GeoArtifact[] = [];
  if (singboxBin && mirrorSite) {
    const site = parseGeoSite(mirrorSite.bytes);
    for (const cat of SRS_GEOSITE) {
      const doms = site.get(cat.toUpperCase());
      if (!doms) continue;
      try {
        const bytes = await compileSrs(singboxBin, doms, []);
        ruleSets.push({ name: `geosite-${cat}.srs`, bytes, sha256: sha256(bytes) });
      } catch (err) {
        sourceErrors.push({ sourceId: 'srs', url: `geosite-${cat}.srs`, error: (err as Error).message });
      }
    }
    if (mirrorIp) {
      const ips = parseGeoIP(mirrorIp.bytes);
      for (const cat of SRS_GEOIP) {
        const cidrs = ips.get(cat.toUpperCase());
        if (!cidrs) continue;
        try {
          const bytes = await compileSrs(singboxBin, [], cidrs);
          ruleSets.push({ name: `geoip-${cat}.srs`, bytes, sha256: sha256(bytes) });
        } catch (err) {
          sourceErrors.push({ sourceId: 'srs', url: `geoip-${cat}.srs`, error: (err as Error).message });
        }
      }
    }
  }

  // Compile each operator custom category to its own .srs so the sing-box
  // subscription can reference it as a self-hosted remote rule-set - sing-box
  // 1.12+ dropped inline geosite:, so .srs is its only portable custom-category
  // vehicle. DOMAINS ONLY (not cidrs), symmetric with the xray/clash path
  // (getCategoryDomains inlines only domains): a custom domain list is a
  // domain-matching feature, and matching cidrs here too would silently block/
  // route IPs on sing-box while xray/clash leak them (the formats must agree).
  // IP-based egress splits belong to the cascade egressPolicy (geoip/ip) path.
  // A category with no domains yields no .srs (nothing for any format to match).
  if (singboxBin) {
    for (const { category, artifact } of plannedCustomSrs(composed)) {
      try {
        const bytes = await compileSrs(singboxBin, category.domains, []);
        ruleSets.push({ name: artifact, bytes, sha256: sha256(bytes) });
      } catch (err) {
        sourceErrors.push({ sourceId: 'srs', url: artifact, error: (err as Error).message });
      }
    }
  }

  return {
    geosite: { name: GEO_SITE_ARTIFACT, bytes: geositeBytes, sha256: sha256(geositeBytes) },
    geoip: { name: GEO_IP_ARTIFACT, bytes: geoipBytes, sha256: sha256(geoipBytes) },
    mirror: { geosite: mirrorSite, geoip: mirrorIp },
    ruleSets,
    categoryDomains: composed
      .filter((c) => c.domains.length > 0)
      .map((c) => ({ name: c.name, domains: domainMatchers(c.domains) })),
    categories: composed.map((c) => ({
      name: c.name,
      domains: c.domains.length,
      cidrs: c.cidrs.length,
      missing: c.missing,
    })),
    sourceErrors,
    // Sources were configured but not one produced a mirror -> every fetch
    // failed. (A source returning a valid-but-empty .dat still sets a mirror,
    // so that is a real - cacheable - build, not a failure.)
    allSourcesFailed: attemptedSources > 0 && mirrorSite === null && mirrorIp === null,
  };
}
