import { prisma } from '../../prisma.js';

/**
 * A-229: a user or a squad takes at most one routing preset, either a built-in
 * key (`routingPreset`) or the operator's own (`customRoutingPresetId`). The
 * database says it with a CHECK (users_one_routing_preset,
 * groups_one_routing_preset); this file is the same rule on the request side,
 * shared by users and squads so the two cannot drift.
 */

export interface PresetChoice {
  routingPreset?: string | null;
  customRoutingPresetId?: string | null;
}

export const BOTH_PRESETS_MESSAGE =
  'routingPreset and customRoutingPresetId are both set: a user or a squad takes one preset, a built-in or an own one';

/** Schema-side refusal: both set to a value in one request. Either one with
 *  null next to it is a clear, and fine. */
export function bothPresetsGiven(v: PresetChoice): boolean {
  return v.routingPreset != null && v.customRoutingPresetId != null;
}

export class RoutingPresetNotFoundError extends Error {
  readonly code = 'ROUTING_PRESET_NOT_FOUND';
  constructor(public id: string) {
    super(`Routing preset ${id} does not exist`);
    this.name = 'RoutingPresetNotFoundError';
  }
}

/** An own preset named by id must exist, refused in words before the foreign
 *  key answers with a bare constraint error. */
export async function assertCustomPresetExists(id: string | null | undefined): Promise<void> {
  if (id == null) return;
  const row = await prisma.routingPreset.findUnique({ where: { id }, select: { id: true } });
  if (!row) throw new RoutingPresetNotFoundError(id);
}

/**
 * The existence check and the write are two statements: a preset deleted in
 * between makes the write fail on the foreign key (P2003). That is the same
 * fact as the check would have found, so it gets the same refusal, not a 500.
 * Rethrows anything else.
 */
export function rethrowPresetGone(err: unknown, id: string | null | undefined): never {
  const e = err as { code?: unknown; meta?: unknown; message?: unknown };
  if (id != null) {
    const said = `${JSON.stringify(e?.meta ?? {})} ${String(e?.message ?? '')}`;
    // A scalar write fails on the foreign key (P2003, naming the column); a
    // nested `connect` finds no row (P2025, naming the model). Either one that
    // names the preset is the preset gone; any other is not ours to rename.
    const fk = e?.code === 'P2003' && said.includes('custom_routing_preset');
    const connect = e?.code === 'P2025' && said.includes('RoutingPreset');
    if (fk || connect) throw new RoutingPresetNotFoundError(id);
  }
  throw err;
}

/**
 * The columns an UPDATE writes for the preset choice. An absent key is not an
 * edit; a value written to one side clears the other, so the pair never ends
 * up holding both; null clears only its own side.
 */
export function presetUpdateData(v: PresetChoice): {
  routingPreset?: string | null;
  customRoutingPresetId?: string | null;
} {
  const out: { routingPreset?: string | null; customRoutingPresetId?: string | null } = {};
  if ('routingPreset' in v && v.routingPreset !== undefined) {
    out.routingPreset = v.routingPreset;
    if (v.routingPreset !== null) out.customRoutingPresetId = null;
  }
  if ('customRoutingPresetId' in v && v.customRoutingPresetId !== undefined) {
    out.customRoutingPresetId = v.customRoutingPresetId;
    if (v.customRoutingPresetId !== null) out.routingPreset = null;
  }
  return out;
}
