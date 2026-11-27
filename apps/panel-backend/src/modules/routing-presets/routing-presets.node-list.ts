import { isRoutingPresetId, type DnsCfg, type NodeCores } from '@iceslab/shared';
import { prisma } from '../../prisma.js';
import { DnsRulesSchema } from './routing-presets.dns.js';
import { carriesRule, overriddenNames, type StoredPresetDns } from './routing-presets.dns-merge.js';
import { RoutingPresetMissingError } from './routing-presets.service.js';
import { nodesOfPreset, readPanelRules, type StoredDnsConflict } from './routing-presets.nodes.js';

/**
 * 19.12: which nodes get the DNS rules of a preset and in what state, for the
 * preset screen. Read from what 19.10 and 19.11 stored (nodes.preset_dns_rules,
 * nodes.preset_dns_conflicts) and from the node's own DNS; nothing is computed
 * that a push would not also compute.
 *
 * For a built-in preset (it has no rules of its own) the list is the panel-wide
 * rules and every node: they act on all of them.
 */

/** Why a rule of the source is not in force on a node. */
export type SkippedKind =
  /** The node's core does not run this kind of server (DoT on xray): never carried. */
  | 'server-kind'
  /** Another preset (or the panel-wide rules) names the same name with another server; this rule was left out (19.11). */
  | 'conflict'
  /** The node would pass 16 servers; this preset was left out whole (19.11). */
  | 'limit'
  /** The node's own DNS names these names, and it answers first (19.10). */
  | 'manual';

export interface SkippedRule {
  /** Position in the source's rules. */
  index: number;
  kind: SkippedKind;
  /** conflict: the other preset's name, null for the panel-wide rules, '' for a preset that is gone. */
  otherPreset?: string | null;
  /** conflict: the name that clashed. manual: the names the node's own DNS takes. */
  names?: string[];
}

export interface PresetNodeEntry {
  id: string;
  name: string;
  online: boolean;
  /** none: nothing of this source is carried to the node. sent: carried and the node has applied its config. waiting: carried, the node has not applied it (offline or the push is queued). */
  state: 'none' | 'sent' | 'waiting';
  /** How many of the source's rules the node carries. */
  carried: number;
  /** The cores as reported, null = never reported; the screen reads rendersDns off them. */
  cores: NodeCores['cores'] | null;
  skipped: SkippedRule[];
}

export interface PresetNodeList {
  /** preset: the rules of an own preset, for the nodes of its squads and users. panel: a built-in, which has the panel-wide rules on every node. */
  scope: 'preset' | 'panel';
  ruleCount: number;
  nodes: PresetNodeEntry[];
}

export async function presetNodeList(id: string): Promise<PresetNodeList> {
  const panel = isRoutingPresetId(id);
  let source: { match: string[]; server: string }[];
  let nodeIds: string[] | null;
  if (panel) {
    source = await readPanelRules(prisma);
    nodeIds = null;
  } else {
    const row = await prisma.routingPreset.findUnique({ where: { id }, select: { dnsRules: true } });
    if (!row) throw new RoutingPresetMissingError(id);
    source = DnsRulesSchema.safeParse(row.dnsRules).data ?? [];
    nodeIds = await nodesOfPreset(id);
  }
  const sourceId: string | null = panel ? null : id;

  const rows = await prisma.node.findMany({
    where: { deletedAt: null, ...(nodeIds ? { id: { in: nodeIds } } : {}) },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      status: true,
      cores: true,
      dns: true,
      presetDnsRules: true,
      presetDnsConflicts: true,
      lastInboundSyncAt: true,
      appliedRevision: true,
      desiredRevision: true,
    },
  });
  const otherIds = new Set<string>();
  for (const n of rows) {
    for (const c of (Array.isArray(n.presetDnsConflicts) ? n.presetDnsConflicts : []) as unknown as StoredDnsConflict[]) {
      if (c.kind === 'conflict' && c.presetId === sourceId && c.otherPresetId) otherIds.add(c.otherPresetId);
    }
  }
  const names = new Map(
    (await prisma.routingPreset.findMany({ where: { id: { in: [...otherIds] } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]),
  );

  const nodes = rows.map((n): PresetNodeEntry => {
    const stored = (Array.isArray(n.presetDnsRules) ? n.presetDnsRules : []) as unknown as StoredPresetDns[];
    const carriedHere = stored.find((s) => s.presetId === sourceId)?.rules ?? [];
    const left = (Array.isArray(n.presetDnsConflicts) ? n.presetDnsConflicts : []) as unknown as StoredDnsConflict[];
    const skipped: SkippedRule[] = [];
    source.forEach((rule, index) => {
      if (!carriesRule(rule)) {
        skipped.push({ index, kind: 'server-kind' });
        return;
      }
      const clash = left.find((c) => c.kind === 'conflict' && c.presetId === sourceId && c.server === rule.server && rule.match.includes(c.domain));
      if (clash && clash.kind === 'conflict') {
        skipped.push({ index, kind: 'conflict', otherPreset: clash.otherPresetId === null ? null : (names.get(clash.otherPresetId) ?? ''), names: [clash.domain] });
        return;
      }
      if (left.some((c) => c.kind === 'limit' && c.presetId === sourceId)) {
        skipped.push({ index, kind: 'limit' });
        return;
      }
      const taken = overriddenNames(n.dns as DnsCfg | null, rule);
      if (taken.length > 0) skipped.push({ index, kind: 'manual', names: taken });
    });
    const applied = n.lastInboundSyncAt !== null && n.appliedRevision >= n.desiredRevision;
    return {
      id: n.id,
      name: n.name,
      online: n.status === 'online',
      state: carriedHere.length === 0 ? 'none' : applied ? 'sent' : 'waiting',
      carried: carriedHere.length,
      cores: (n.cores as NodeCores | null)?.cores ?? null,
      skipped,
    };
  });
  return { scope: panel ? 'panel' : 'preset', ruleCount: source.length, nodes };
}
