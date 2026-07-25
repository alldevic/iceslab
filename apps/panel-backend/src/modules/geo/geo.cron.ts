import { prisma } from '../../prisma.js';
import { config } from '../../config.js';
import { eventBus } from '../../lib/event-bus.js';
import { getLogger } from '../../lib/logger.js';
import {
  rebuildGeo,
  getGeoBuildMeta,
  GeoBuildAllSourcesFailed,
  type GeoBuildMeta,
} from './geo.registry.js';
import { GEO_SITE_ARTIFACT, GEO_IP_ARTIFACT } from './geo.orchestrator.js';
import { getEnabledSources } from './geo.sources.js';
import { isSourceDue } from './geo.sourcecache.js';

// The composed custom .dat files whose content the cascade entry nodes install.
const CUSTOM_ARTIFACTS = [GEO_SITE_ARTIFACT, GEO_IP_ARTIFACT];

function customArtifactShas(): Record<string, string> {
  const meta = getGeoBuildMeta();
  const out: Record<string, string> = {};
  for (const a of meta?.artifacts ?? []) {
    if (CUSTOM_ARTIFACTS.includes(a.name)) out[a.name] = a.sha256;
  }
  return out;
}

/**
 * Scheduled geo refresh (daily cron). A source URL like
 * `.../releases/latest/download/geosite.dat` changes content upstream over time,
 * but the panel only fetches it at BUILD time and caches the result in-process -
 * so without this, an upstream update never propagates until an operator clicks
 * Rebuild or the panel restarts. This re-fetches every enabled source, rebuilds
 * the artifacts, and:
 *   - CLIENTS pick up new geo automatically: their subscription references the
 *     panel's `/geo/<token>/...` URL, which now serves the fresh build (clash/
 *     sing-box also self-update on their own interval).
 *   - NODES don't re-fetch on their own, so if a COMPOSED custom .dat actually
 *     changed we re-emit `cascade.changed` for cascades with an egress policy;
 *     the node then sees the new sha256 in its fragment and atomically swaps the
 *     file in. We only re-push when the custom .dat content changed, so an
 *     unchanged rebuild causes no node restarts (no thrash).
 * No-op when self-hosting is off. Fail-soft: an all-sources-down rebuild keeps
 * the last-good build rather than clearing it.
 */
export async function refreshGeoAndRepush(): Promise<{
  rebuilt: boolean;
  changed: boolean;
  nodes: number;
}> {
  if (!config.GEO_SELF_HOST) return { rebuilt: false, changed: false, nodes: 0 };

  // Cheap short-circuit: only rebuild when at least one enabled source is due per
  // its own refreshIntervalHours (reads in-process cache timestamps, no network).
  // The cron fires hourly, so per-source intervals get honoured at ~1h grain.
  const now = Date.now();
  const sources = await getEnabledSources();
  const anyDue = sources.some((s) => {
    const ms = Math.max(1, s.refreshIntervalHours) * 3_600_000;
    return (
      (s.geositeUrl ? isSourceDue(s.geositeUrl, ms, now) : false) ||
      (s.geoipUrl ? isSourceDue(s.geoipUrl, ms, now) : false)
    );
  });
  if (!anyDue) return { rebuilt: false, changed: false, nodes: 0 };

  const before = customArtifactShas();
  try {
    await rebuildGeo({ respectInterval: true });
  } catch (err) {
    if (err instanceof GeoBuildAllSourcesFailed) {
      getLogger().warn('[cron] geo-rebuild - every source failed to fetch; kept last-good build');
      return { rebuilt: false, changed: false, nodes: 0 };
    }
    throw err;
  }
  const after = customArtifactShas();
  const changed = CUSTOM_ARTIFACTS.some((n) => before[n] !== after[n]);
  if (!changed) return { rebuilt: true, changed: false, nodes: 0 };

  // A custom category .dat changed -> re-push the cascade entry nodes so they
  // fetch the new file.
  const nodes = await repushEgressCascades();
  return { rebuilt: true, changed: true, nodes };
}

/**
 * Emit `cascade.changed` for every enabled cascade that carries an egress
 * policy, so its entry nodes re-render their split and re-fetch the current
 * custom .dat. Returns the affected node count. (Filtered in JS rather than a
 * Prisma Json-null WHERE to sidestep JsonNull/DbNull filter quirks.) The node
 * agent dedupes an identical push, so a re-emit for an unchanged standard-only
 * policy is a no-op on the node.
 */
export async function repushEgressCascades(): Promise<number> {
  const cascades = await prisma.cascade.findMany({
    where: { enabled: true },
    include: { hops: { select: { nodeId: true } } },
  });
  const nodeIds = [
    ...new Set(cascades.filter((c) => c.egressPolicy != null).flatMap((c) => c.hops.map((h) => h.nodeId))),
  ];
  if (nodeIds.length > 0) eventBus.emit('cascade.changed', { nodeIds });
  return nodeIds.length;
}

/**
 * Rebuild the geo artifacts and propagate the result to cascade entry nodes.
 * Used by the boot warm-up (forceRepush: a cascade rendered during the
 * cold-cache window had its ext: matchers stripped and would otherwise stay
 * stale until the content changes or the cascade is edited) and by the manual
 * POST /api/geo/build (forceRepush off: re-push only when a custom .dat actually
 * changed, to avoid thrash on a no-op rebuild). Lets GeoBuildAllSourcesFailed
 * propagate so the caller (route -> 502, warm-up -> logged) handles it.
 */
export async function rebuildGeoAndRepush(opts: { forceRepush: boolean }): Promise<GeoBuildMeta> {
  const before = customArtifactShas();
  const meta = await rebuildGeo();
  const after = customArtifactShas();
  const changed = CUSTOM_ARTIFACTS.some((n) => before[n] !== after[n]);
  if (opts.forceRepush || changed) await repushEgressCascades();
  return meta;
}
