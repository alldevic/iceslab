import type { RoutingPresetId } from '@iceslab/shared';
import { loadFailure, type LoadFailure } from '@/lib/ui/loadView';

/**
 * Two decisions of the Routes page (A-228), out of the markup so they are held
 * by a test.
 *
 * The panel default preset is `proxy-all` only when the settings ANSWERED
 * without one. Settings that did not arrive (or are on their way) are not a
 * preset at all: they used to read as `proxy-all`, and the device tab marked
 * it as what clients are handed.
 */
export function defaultPresetOf(
  settings: { subscriptionRoutingPreset?: RoutingPresetId | null } | undefined,
): RoutingPresetId | null {
  if (!settings) return null;
  return settings.subscriptionRoutingPreset ?? 'proxy-all';
}

type Q = { data: unknown; isError: boolean; error: unknown; refetch: () => unknown };

/**
 * The failure the open tab is drawn over, or null. Each tab names the lists it
 * is drawn from; the first one that failed is said with a retry in place of
 * the tab, never as «no policies». The node-policy tab asks its own lists
 * (PolicyPane), so it has none here.
 */
export function routesPaneFailure(
  pane: 'policy' | 'node' | 'device',
  lists: { routePolicies: Q; squads: Q; settings: Q },
  say: (err: unknown) => string,
): LoadFailure | null {
  const asked = pane === 'node' ? [lists.routePolicies, lists.squads] : pane === 'device' ? [lists.settings, lists.squads] : [];
  return asked.map((q) => loadFailure(q, say)).find((f) => f !== null) ?? null;
}
