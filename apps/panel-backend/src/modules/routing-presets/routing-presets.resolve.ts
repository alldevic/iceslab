import { isRoutingPresetId, type RoutingPresetId } from '@iceslab/shared';
import type { DeviceRouteRule } from './routing-presets.builtins.js';

/**
 * A-229 part 3: which preset a subscription is built with, the built-in key or
 * the operator's own rules. Pure: the subscription and the user card read the
 * rows, this decides.
 *
 * Order (unchanged from R3, an own preset only adds a second kind to each
 * tier): `?routing=` on the request, then the user, then the squads, then the
 * panel-wide default.
 */

export type ResolvedPreset =
  | { kind: 'builtin'; id: RoutingPresetId }
  | { kind: 'custom'; id: string; name: string; rules: DeviceRouteRule[] };

/** A user's or a squad's two preset columns as read, the own one with its row. */
export interface PresetColumns {
  routingPreset: string | null;
  customRoutingPreset: { id: string; name: string; rules: unknown } | null;
}

/** What one row holds, or null for "inherit". A built-in key the code no
 *  longer knows is ignored, as before. */
export function presetOf(row: PresetColumns): ResolvedPreset | null {
  if (row.customRoutingPreset) {
    const p = row.customRoutingPreset;
    return { kind: 'custom', id: p.id, name: p.name, rules: Array.isArray(p.rules) ? (p.rules as DeviceRouteRule[]) : [] };
  }
  return isRoutingPresetId(row.routingPreset) ? { kind: 'builtin', id: row.routingPreset } : null;
}

function keyOf(p: ResolvedPreset): string {
  return p.kind === 'builtin' ? `builtin:${p.id}` : `custom:${p.id}`;
}

/**
 * The squads' preset: the single DISTINCT one across the user's squads, null
 * when none set one or they disagree (R3-a, resolveSquadRouting). Distinct is
 * by kind and id, so a built-in in one squad and an own preset in another are
 * two, even if their rules read the same: that is a disagreement and falls
 * through to the panel default, the same as two different built-ins.
 */
export function resolveSquadPreset(squads: PresetColumns[]): { preset: ResolvedPreset | null; conflict: boolean } {
  const distinct = new Map<string, ResolvedPreset>();
  for (const s of squads) {
    const p = presetOf(s);
    if (p) distinct.set(keyOf(p), p);
  }
  if (distinct.size === 1) return { preset: [...distinct.values()][0]!, conflict: false };
  return { preset: null, conflict: distinct.size > 1 };
}

/** The select that gives presetOf what it reads, for a user or a group. */
export const PRESET_COLUMNS_SELECT = {
  routingPreset: true,
  customRoutingPreset: { select: { id: true, name: true, rules: true } },
} as const;
