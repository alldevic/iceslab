import { prisma } from '../../prisma.js';
import { config } from '../../config.js';
import { eventBus } from '../../lib/event-bus.js';
import { getLogger } from '../../lib/logger.js';
import { rebuildGeo, getGeoBuildMeta, GeoBuildAllSourcesFailed } from './geo.registry.js';
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

  // A rebuilt .dat has to reach the nodes that actually serve it: the cascade
  // members carrying an egress policy. Per NODE, not per cascade - a position is
  // a pool and only the boxes with a split need the new file, so re-pushing the
  // whole cascade would churn nodes whose config cannot have changed.
  // (Filtered in JS rather than a Prisma Json-null WHERE to sidestep the
  // JsonNull/DbNull filter quirks.)
  const members = await prisma.cascadePositionNode.findMany({
    where: { position: { cascade: { enabled: true } } },
    select: { nodeId: true, egressPolicy: true },
  });
  const nodeIds = [...new Set(members.filter((m) => m.egressPolicy != null).map((m) => m.nodeId))];
  if (nodeIds.length > 0) eventBus.emit('cascade.changed', { nodeIds });
  return { rebuilt: true, changed: true, nodes: nodeIds.length };
}
