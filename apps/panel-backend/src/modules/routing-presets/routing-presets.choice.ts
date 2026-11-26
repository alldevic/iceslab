/**
 * A-229: the request-side half of the one-preset rule, without the database
 * (routing-presets.assign.ts holds the rest and imports prisma). Its own file
 * so the user and squad schemas, and through them the panel's form tests, load
 * without a Prisma client.
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
