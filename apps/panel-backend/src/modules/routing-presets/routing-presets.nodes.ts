import { isDeepStrictEqual } from 'node:util';
import type { DnsCfg } from '@iceslab/shared';
import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../prisma.js';
import { DnsRulesSchema, dnsRuleProblem } from './routing-presets.dns.js';
import {
  NODE_DNS_MAX_SERVERS,
  carriesRule,
  findDnsConflict,
  mergeNodeDns,
  type DnsConflict,
  type NamedDnsSource,
  type StoredPresetDns,
} from './routing-presets.dns-merge.js';

/**
 * 19.10: carrying the DNS rules of presets (and the panel-wide ones) to the
 * nodes. The node's DNS is one for all its clients, so a rule of a preset has
 * to reach every node that serves its users, and two presets on one node must
 * not name different servers for one name.
 *
 * What a node carries is a pure function of the database (the presets' rules,
 * who holds them, which nodes those users' squads reach, the panel-wide rules),
 * recomputed whole for a node, never patched: nodes.preset_dns_rules. A save
 * recomputes the nodes it touches; 19.11 calls the same for the changes of
 * assignment and of a squad's nodes.
 */

type Db = Prisma.TransactionClient | typeof prisma;

export const PANEL_DNS_NAME = 'the panel-wide DNS rules';

export class RoutingPresetDnsConflictError extends Error {
  readonly code = 'ROUTING_PRESET_DNS_CONFLICT';
  constructor(
    public readonly node: string,
    public readonly conflict: DnsConflict,
    /** Whose save was refused: the other side is the one the operator must look at. */
    saved: string | null,
  ) {
    const other = conflict.a.presetId === saved ? conflict.b : conflict.a;
    const mine = conflict.a.presetId === saved ? conflict.a : conflict.b;
    super(
      `${JSON.stringify(conflict.domain)} gets a different DNS server from ${label(other)} (${other.server}) than from ` +
        `${label(mine)} (${mine.server}) on node "${node}": one node has one DNS for all its clients. Give the name the same server or remove it from one of them.`,
    );
    this.name = 'RoutingPresetDnsConflictError';
    this.other = other.presetId === null ? PANEL_DNS_NAME : other.name;
    this.domain = conflict.domain;
  }
  /** The second preset (or the panel-wide rules), named. */
  readonly other: string;
  readonly domain: string;
}

export class RoutingPresetDnsLimitError extends Error {
  readonly code = 'ROUTING_PRESET_DNS_NODE_LIMIT';
  constructor(
    public readonly node: string,
    public readonly count: number,
  ) {
    super(
      `node "${node}" would have ${count} DNS servers, its own and those of the presets that reach it; the limit is ${NODE_DNS_MAX_SERVERS}. ` +
        'Remove a server from the node (DNS screen) or merge rules that name the same server.',
    );
    this.name = 'RoutingPresetDnsLimitError';
  }
}

const label = (s: { presetId: string | null; name: string }): string =>
  s.presetId === null ? PANEL_DNS_NAME : `preset "${s.name}"`;

/** For each preset: the nodes that serve its users and squads. A squad with the preset serves it to all its members; a user with it, through the squads they belong to. A node a disabled binding or profile does not run is not reached. */
export async function presetNodeIndex(db: Db = prisma): Promise<Map<string, Set<string>>> {
  const held = { customRoutingPresetId: { not: null }, deletedAt: null };
  const squads = await db.group.findMany({
    where: { OR: [{ customRoutingPresetId: { not: null } }, { members: { some: { user: held } } }] },
    select: {
      customRoutingPresetId: true,
      members: { where: { user: held }, select: { user: { select: { customRoutingPresetId: true } } } },
      groupProfiles: {
        where: { profile: { enabled: true } },
        select: { profile: { select: { bindings: { where: { enabled: true }, select: { nodeId: true } } } } },
      },
    },
  });
  const out = new Map<string, Set<string>>();
  for (const sq of squads) {
    const nodes = sq.groupProfiles.flatMap((gp) => gp.profile.bindings.map((b) => b.nodeId));
    const presets = new Set<string>();
    if (sq.customRoutingPresetId) presets.add(sq.customRoutingPresetId);
    for (const m of sq.members) if (m.user.customRoutingPresetId) presets.add(m.user.customRoutingPresetId);
    for (const p of presets) {
      const set = out.get(p) ?? new Set<string>();
      for (const n of nodes) set.add(n);
      out.set(p, set);
    }
  }
  return out;
}

/** The nodes that serve the users and squads of one preset. */
export async function nodesOfPreset(presetId: string, db: Db = prisma): Promise<string[]> {
  return [...((await presetNodeIndex(db)).get(presetId) ?? [])];
}

async function readPanelRules(db: Db): Promise<{ match: string[]; server: string }[]> {
  const row = await db.appSetting.findUnique({ where: { key: 'subscriptionDnsRules' }, select: { value: true } });
  const parsed = DnsRulesSchema.safeParse(row?.value);
  return parsed.success && dnsRuleProblem(parsed.data) === null ? parsed.data.map((r) => ({ match: r.match, server: r.server })) : [];
}

/** What a save proposes: the rules of one preset (an empty list for a deleted one), or the panel-wide rules. */
export interface DnsChange {
  presetId: string | null;
  rules: readonly { match: string[]; server: string }[];
}

export interface NodeDnsPlan {
  nodeId: string;
  next: StoredPresetDns[] | null;
  changed: boolean;
}

/**
 * What every node the change touches would carry afterwards, or a refusal. Writes
 * nothing. A conflict is refused only when the saved source is one side of it; the
 * limit when the node's own servers and the carried ones together pass 16.
 */
export async function planDnsTransfer(change: DnsChange, db: Db = prisma): Promise<NodeDnsPlan[]> {
  const [presetRows, nodes, index, panel] = await Promise.all([
    db.routingPreset.findMany({ select: { id: true, name: true, dnsRules: true } }),
    db.node.findMany({ where: { deletedAt: null }, select: { id: true, name: true, dns: true, presetDnsRules: true } }),
    presetNodeIndex(db),
    change.presetId === null ? Promise.resolve(change.rules) : readPanelRules(db),
  ]);
  const presets = presetRows
    .map((p) => ({
      presetId: p.id as string | null,
      name: p.name,
      rules: p.id === change.presetId ? change.rules : DnsRulesSchema.safeParse(p.dnsRules).data ?? [],
    }))
    .filter((p) => p.rules.length > 0)
    .sort((a, b) => a.presetId!.localeCompare(b.presetId!));

  const touched = (n: { id: string; presetDnsRules: unknown }): boolean =>
    change.presetId === null ||
    (index.get(change.presetId)?.has(n.id) ?? false) ||
    (Array.isArray(n.presetDnsRules) && (n.presetDnsRules as StoredPresetDns[]).some((s) => s.presetId === change.presetId));

  const plan: NodeDnsPlan[] = [];
  for (const n of nodes.filter(touched)) {
    const sources: NamedDnsSource[] = presets.filter((p) => index.get(p.presetId!)?.has(n.id));
    if (panel.length > 0) sources.push({ presetId: null, name: PANEL_DNS_NAME, rules: panel });
    const conflict = findDnsConflict(sources, { presetId: change.presetId });
    if (conflict) throw new RoutingPresetDnsConflictError(n.name, conflict, change.presetId);
    const next = sources
      .map((s) => ({ presetId: s.presetId, rules: s.rules.filter(carriesRule).map((r) => ({ match: [...r.match], server: r.server })) }))
      .filter((s) => s.rules.length > 0);
    const servers = mergeNodeDns(n.dns as DnsCfg | null, next)?.servers.length ?? 0;
    if (servers > NODE_DNS_MAX_SERVERS) throw new RoutingPresetDnsLimitError(n.name, servers);
    const current = Array.isArray(n.presetDnsRules) ? n.presetDnsRules : null;
    plan.push({ nodeId: n.id, next: next.length > 0 ? next : null, changed: !isDeepStrictEqual(current, next.length > 0 ? next : null) });
  }
  return plan;
}

/** Writes the plan's changed nodes; the ids to push. Inside the save's transaction. */
export async function writeDnsPlan(db: Db, plan: readonly NodeDnsPlan[]): Promise<string[]> {
  const changed = plan.filter((p) => p.changed);
  for (const p of changed) {
    await db.node.update({
      where: { id: p.nodeId },
      data: { presetDnsRules: p.next ? (p.next as unknown as Prisma.InputJsonValue) : Prisma.DbNull },
    });
  }
  return changed.map((p) => p.nodeId);
}

/** Queues the push to the nodes whose carried rules changed (the queue folds repeats per node). */
export async function pushDnsNodes(nodeIds: readonly string[]): Promise<void> {
  if (nodeIds.length === 0) return;
  const { enqueueNodePush } = await import('../inbounds/inbounds.queue.js');
  for (const id of nodeIds) await enqueueNodePush(id);
}
