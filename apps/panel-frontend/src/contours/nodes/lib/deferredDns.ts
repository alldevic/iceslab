import type { DeferredDnsEntry } from '@/lib/domain/nodes';

type Translate = (key: string, vars?: Record<string, unknown>) => string;

/**
 * Why a rule of a preset did not reach the node (19.15), in the panel's words:
 * another source names the same name with another server (the one that came to
 * the node first keeps it), or the preset was left out whole because the node
 * would have more than 16 servers. `nameOf` gives a preset's name, the panel-wide
 * rules for null.
 */
export function deferredReason(d: DeferredDnsEntry, nameOf: (presetId: string | null) => string, t: Translate): string {
  return d.kind === 'conflict'
    ? t('nodeEdit.dnsDeferredConflict', { other: nameOf(d.otherPresetId), domain: d.domain, server: d.server })
    : t('nodeEdit.dnsDeferredLimit', { count: d.count });
}
