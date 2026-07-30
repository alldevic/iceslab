import type { RoutingPresetId } from '@iceslab/shared';

/**
 * The three built-in device presets, and how to name them.
 *
 * These live here rather than on the Routes page because two screens ask about
 * them: Routes edits them, and the Users filter narrows the roster by which one
 * a user overrides to. Their names are panel copy, not operator data, so both
 * screens translate the id rather than trusting whatever the API calls it.
 */
export const PRESET_IDS: RoutingPresetId[] = ['ru-split', 'cn-split', 'proxy-all'];

export function isBuiltInPresetId(id: string): id is RoutingPresetId {
  return (PRESET_IDS as string[]).includes(id);
}

/** The i18n suffix under `metadata.preset*` for a built-in id. */
export function presetKey(id: RoutingPresetId): string {
  return id === 'ru-split' ? 'RuSplit' : id === 'cn-split' ? 'CnSplit' : 'ProxyAll';
}
