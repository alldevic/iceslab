import { prisma } from '../../prisma.js';
import { PRESET_COLUMNS_SELECT, presetOf, type ResolvedPreset } from './routing-presets.resolve.js';

/**
 * 19.15: an own preset as the panel's default. The built-in default stays the
 * key `subscriptionRoutingPreset`; `subscriptionDefaultPresetId` (an own
 * preset's id, or no row) is stronger when it is set: whoever has no preset of
 * their own and none from their squad is handed it.
 */

export const DEFAULT_PRESET_KEY = 'subscriptionDefaultPresetId';

type Db = Pick<typeof prisma, 'appSetting'>;

/** The own preset the panel hands by default, or null. A damaged row reads as none. */
export async function readDefaultPresetId(db: Db = prisma): Promise<string | null> {
  const row = await db.appSetting.findUnique({ where: { key: DEFAULT_PRESET_KEY }, select: { value: true } });
  return typeof row?.value === 'string' && row.value.length > 0 ? row.value : null;
}

/**
 * The default own preset with its rules, read fresh (the settings cache would
 * hold the rules of a preset that was edited a minute ago). Null: none set, or
 * the row is gone, and the built-in default answers.
 */
export async function loadDefaultPreset(id: string | null): Promise<ResolvedPreset | null> {
  if (!id) return null;
  const row = await prisma.routingPreset.findUnique({ where: { id }, select: PRESET_COLUMNS_SELECT.customRoutingPreset.select });
  return row ? presetOf({ routingPreset: null, customRoutingPreset: row }) : null;
}
