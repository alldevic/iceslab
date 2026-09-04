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

/**
 * The standard categories the routing presets reference by name.
 *
 * They are needed in TWO places, and for a long time only one of them used the
 * list. sing-box gets them as self-hosted `.srs`; xray and clash reference them
 * inside the document as `geosite:category-ru` and friends, and have no way to
 * fetch anything - they read whatever .dat the client happens to hold.
 *
 * So the artifact this build emits must CARRY them. Until 2026-09-04 it carried
 * only the operator's own categories, and a client holding it as its geosite.dat
 * could not start xray at all: `code not found in geosite.dat: CATEGORY-ADS-ALL`
 * - the first geosite lookup in the rule list, named in the error not because it
 * is special but because it is first. Two buyers reported it as an ad-blocking
 * category being missing; what they had was a dead channel.
 *
 * Copied through under their STANDARD names, from the mirror, which is the same
 * parse the .srs step already paid for.
 */
export const PRESET_GEOSITE = ['category-ads-all', 'category-ru', 'category-gov-ru', 'cn'];
export const PRESET_GEOIP = ['ru', 'cn'];

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

  // What each source is actually READ for, by database. A source contributes to
  // a build only through the categories an enabled spec names in it, so nothing
  // else has to be turned into objects.
  //
  // Before this, parsing was unconditional, because parsing is how categories get
  // enumerated - so a build with no custom categories at all still turned 3.15M
  // domains and 1.23M networks into JS objects to produce an output that is a
  // copy of bytes already in hand. Measured 590 MB of heap and 762 MB RSS, above
  // the image's own --max-old-space-size=512, which with GEO_SELF_HOST on made
  // start-up warm-up a crash loop.
  const siteWanted = new Map<string, Set<string>>();
  const ipWanted = new Map<string, Set<string>>();
  const want = (m: Map<string, Set<string>>, sourceId: string, category: string): void => {
    const set = m.get(sourceId) ?? new Set<string>();
    set.add(category);
    m.set(sourceId, set);
  };
  for (const spec of specs) {
    for (const r of spec.domainRefs) want(siteWanted, r.sourceId, r.category);
    for (const r of spec.ipRefs) want(ipWanted, r.sourceId, r.category);
  }

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
        // The FETCH is unconditional even when nothing reads this source: the
        // raw bytes are the mirror clients pull, and the cache revalidation is
        // the point of running the build. Only the parse is narrowed.
        const cats = siteWanted.get(s.id);
        if (cats) siteMaps.set(s.id, parseGeoSite(bytes, cats));
        if (!mirrorSite) mirrorSite = { name: GEO_MIRROR_SITE, bytes, sha256: sha256(bytes) };
      } catch (err) {
        sourceErrors.push({ sourceId: s.id, url: s.geositeUrl, error: (err as Error).message });
      }
    }
    if (s.geoipUrl) {
      try {
        const bytes = await loadSourceDat(s.geoipUrl, intervalMs(s), mode, now, fetchDat);
        const cats = ipWanted.get(s.id);
        if (cats) ipMaps.set(s.id, parseGeoIP(bytes, cats));
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

  // Preset categories, copied through from the mirror under their standard
  // names so the artifact satisfies the documents this panel itself emits.
  //
  // This is the SAME parse the .srs step below already performs on every build,
  // hoisted so it happens once and regardless of whether a sing-box binary is
  // configured - the xray and clash formats need these categories even where
  // no .srs is ever compiled. Nothing new is turned into objects: the narrowed
  // parse that keeps this build inside its heap budget stays narrowed.
  const presetSite =
    mirrorSite !== null ? parseGeoSite(mirrorSite.bytes, PRESET_GEOSITE) : new Map<string, Domain[]>();
  const presetIp =
    mirrorIp !== null ? parseGeoIP(mirrorIp.bytes, PRESET_GEOIP) : new Map<string, CIDR[]>();

  // An operator category of the same name WINS. Two entries under one name
  // would silently drop one of them (see composedToGeoSiteDat), and the one
  // worth keeping is the one somebody chose on purpose.
  const taken = new Set(composed.map((c) => c.name));
  const presets: ComposedCategory[] = [];
  for (const cat of PRESET_GEOSITE) {
    const name = cat.toUpperCase();
    if (taken.has(name)) continue;
    const domains = presetSite.get(name);
    if (!domains?.length) continue;
    taken.add(name);
    presets.push({ name, domains, cidrs: presetIp.get(name) ?? [], missing: [] });
  }
  for (const cat of PRESET_GEOIP) {
    const name = cat.toUpperCase();
    if (taken.has(name)) continue;
    const cidrs = presetIp.get(name);
    if (!cidrs?.length) continue;
    taken.add(name);
    presets.push({ name, domains: presetSite.get(name) ?? [], cidrs, missing: [] });
  }
  const emitted = [...composed, ...presets];

  const geositeBytes = composedToGeoSiteDat(emitted);
  const geoipBytes = composedToGeoIPDat(emitted);

  // Compile the standard preset categories to sing-box .srs from the mirror, so
  // the sing-box format fetches them from the panel. Best-effort: a compile
  // failure (or no binary) just omits that .srs.
  const ruleSets: GeoArtifact[] = [];
  if (singboxBin && mirrorSite) {
    // The four presets, not the whole database: this is the parse that a
    // production panel pays on every build, because self-hosting the .srs is
    // exactly the reason the subsystem is switched on.
    const site = presetSite;
    for (const cat of PRESET_GEOSITE) {
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
      const ips = presetIp;
      for (const cat of PRESET_GEOIP) {
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
    categories: emitted.map((c) => ({
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
