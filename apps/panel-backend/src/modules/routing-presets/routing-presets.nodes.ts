import { isDeepStrictEqual } from 'node:util';
import type { DnsCfg } from '@iceslab/shared';
import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../prisma.js';
import { readDefaultPresetId } from './routing-presets.default.js';
import { DnsRulesSchema, dnsRuleProblem } from './routing-presets.dns.js';
import {
  NODE_DNS_MAX_SERVERS,
  allDnsConflicts,
  carriesRule,
  findDnsConflict,
  nodeDnsServerCount,
  resolveDnsConflicts,
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
    this.otherIsPanel = other.presetId === null;
    this.domain = conflict.domain;
  }
  /** The second preset (or the panel-wide rules), named. */
  readonly other: string;
  /** The other side is the panel-wide rules, not a preset: the screen says it in its own words (19.12). */
  readonly otherIsPanel: boolean;
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

/**
 * For each preset: the nodes that serve its users and squads. A squad with the preset serves it to all its members; a user with it, through the squads they belong to. A node a disabled binding or profile does not run is not reached.
 *
 * 19.15: the own preset the panel hands by default (`defaultPresetId`, read from the settings when not given) counts as held by every squad that has no preset of its own, built-in or not: a user without a preset of their own takes their squad's, so squads are enough. It reaches those squads' nodes the way an assigned one does.
 */
export async function presetNodeIndex(db: Db = prisma, defaultPresetId?: string | null): Promise<Map<string, Set<string>>> {
  const fallback = defaultPresetId === undefined ? await readDefaultPresetId(db) : defaultPresetId;
  const held = { customRoutingPresetId: { not: null }, deletedAt: null };
  const squads = await db.group.findMany({
    where: {
      OR: [
        { customRoutingPresetId: { not: null } },
        { members: { some: { user: held } } },
        ...(fallback ? [{ customRoutingPresetId: null, routingPreset: null }] : []),
      ],
    },
    select: {
      customRoutingPresetId: true,
      routingPreset: true,
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
    else if (fallback && !sq.routingPreset) presets.add(fallback);
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

export async function readPanelRules(db: Db): Promise<{ match: string[]; server: string }[]> {
  const row = await db.appSetting.findUnique({ where: { key: 'subscriptionDnsRules' }, select: { value: true } });
  const parsed = DnsRulesSchema.safeParse(row?.value);
  return parsed.success && dnsRuleProblem(parsed.data) === null ? parsed.data.map((r) => ({ match: r.match, server: r.server })) : [];
}

/** What a save proposes: the rules of one preset (an empty list for a deleted one), or the panel-wide rules. */
export interface DnsChange {
  presetId: string | null;
  rules: readonly { match: string[]; server: string }[];
}

/** What a recompute left out of a node, stored in nodes.preset_dns_conflicts (19.11). */
export type StoredDnsConflict =
  | { kind: 'conflict'; presetId: string | null; otherPresetId: string | null; domain: string; server: string }
  | { kind: 'limit'; presetId: string | null; count: number };

export interface NodeDnsPlan {
  nodeId: string;
  next: StoredPresetDns[] | null;
  /** What this plan leaves out of the node (null = nothing). */
  conflicts: StoredDnsConflict[] | null;
  /** The carried rules differ from the stored ones: the node needs a push. */
  changed: boolean;
  /** The record of what was left out differs from the stored one. */
  conflictsChanged: boolean;
}

/** Which nodes a recompute looks at and what it refuses. */
export interface DnsPlanScope {
  /** A save in flight: this source's rules are the proposed ones, not the stored ones. */
  change?: DnsChange;
  /** Refuse a conflict (or the limit) that has this source on one side; undefined = refuse nothing, leave the second out (a change of squads or bindings). */
  refuse?: { presetId: string | null };
  /** Presets whose nodes are looked at: those they reach now and those still carrying them. With a `change` of the panel rules, or with neither this nor `nodeIds`, every node. */
  presets?: readonly string[];
  /** Exactly these nodes. */
  nodeIds?: readonly string[];
  /** 19.15: the panel's default own preset as it will be once a settings save in flight is written; undefined = the stored one. */
  defaultPresetId?: string | null;
}

/**
 * What every node in scope would carry afterwards, or a refusal. Writes nothing.
 * The same function for a save (19.10), an assignment, and the events of squads
 * and bindings (19.11), so a node never carries what a recompute would not.
 *
 * Refusal (only with `scope.refuse`): a NEW conflict with the refused source on
 * one side, the limit when the node's own servers and the carried ones pass 16
 * and the change makes them more than they were (19.15: what was there before,
 * a conflict already written on the node or a node already over the limit, does
 * not stop a save that does not make it worse; it stays a warning, 19.12). "Before"
 * is the same function over the stored rules, and for an assignment over the
 * sources without the assigned preset when the node did not carry it. Without
 * it nothing is refused: the sources are taken in order of who was on the node
 * first (the panel-wide rules, then the presets the node already carried, then the
 * older preset), a rule that clashes with an earlier source is not carried, and
 * the node's record says so. The same rules, run again, give the same plan.
 */
export async function planCarriedDns(scope: DnsPlanScope, db: Db = prisma): Promise<NodeDnsPlan[]> {
  const { change } = scope;
  const defaultId = scope.defaultPresetId !== undefined ? scope.defaultPresetId : await readDefaultPresetId(db);
  const [presetRows, nodes, index, panel, panelStored] = await Promise.all([
    db.routingPreset.findMany({ select: { id: true, name: true, dnsRules: true, createdAt: true } }),
    db.node.findMany({
      where: { deletedAt: null, ...(scope.nodeIds ? { id: { in: [...scope.nodeIds] } } : {}) },
      select: { id: true, name: true, dns: true, presetDnsRules: true, presetDnsConflicts: true },
    }),
    presetNodeIndex(db, defaultId),
    change && change.presetId === null ? Promise.resolve(change.rules) : readPanelRules(db),
    // The panel-wide rules as stored, for "before" of a save of those rules.
    scope.refuse && change && change.presetId === null ? readPanelRules(db) : Promise.resolve(null),
  ]);
  const created = new Map(presetRows.map((p) => [p.id, p.createdAt.getTime()]));
  const sourcesOf = (proposed: boolean): NamedDnsSource[] =>
    presetRows
      .map((p) => ({
        presetId: p.id as string | null,
        name: p.name,
        rules: proposed && change && p.id === change.presetId ? change.rules : DnsRulesSchema.safeParse(p.dnsRules).data ?? [],
      }))
      .filter((p) => p.rules.length > 0);
  const presets = sourcesOf(true);
  const presetsBefore = sourcesOf(false);

  const watchedGiven = scope.presets ?? (change?.presetId ? [change.presetId] : null);
  // The default preset moves with every squad's own choice, so it is always looked at with them.
  const watched = watchedGiven && defaultId ? [...watchedGiven, defaultId] : watchedGiven;
  const storedIds = (n: { presetDnsRules: unknown }): (string | null)[] =>
    Array.isArray(n.presetDnsRules) ? (n.presetDnsRules as StoredPresetDns[]).map((s) => s.presetId) : [];
  const touched = (n: { id: string; presetDnsRules: unknown }): boolean =>
    scope.nodeIds !== undefined ||
    watched === null ||
    watched.some((p) => (index.get(p)?.has(n.id) ?? false) || storedIds(n).includes(p));

  const plan: NodeDnsPlan[] = [];
  for (const n of nodes.filter(touched)) {
    const before = storedIds(n);
    const rank = (id: string | null): number => (before.includes(id) ? before.indexOf(id) : Infinity);
    // Who was here first: already carried (in the order it was carried), then the older preset.
    const order = (a: NamedDnsSource, b: NamedDnsSource): number =>
      rank(a.presetId) - rank(b.presetId) || created.get(a.presetId!)! - created.get(b.presetId!)! || a.presetId!.localeCompare(b.presetId!);
    const reaching = presets.filter((p) => index.get(p.presetId!)?.has(n.id)).sort(order);
    const panelSource: NamedDnsSource[] = panel.length > 0 ? [{ presetId: null, name: PANEL_DNS_NAME, rules: panel }] : [];
    // What the node had before the change: the stored rules; for an assignment, without the preset when the node did not carry it.
    const onNode = (id: string | null): boolean =>
      before.includes(id) || (Array.isArray(n.presetDnsConflicts) ? (n.presetDnsConflicts as unknown as StoredDnsConflict[]) : []).some((c) => c.presetId === id || (c.kind === 'conflict' && c.otherPresetId === id));
    const reachingBefore = presetsBefore
      .filter((p) => index.get(p.presetId!)?.has(n.id) && (change || p.presetId !== scope.refuse?.presetId || onNode(p.presetId)))
      .sort(order);
    const panelBefore = panelStored ?? panel;
    const panelSourceBefore: NamedDnsSource[] = panelBefore.length > 0 ? [{ presetId: null, name: PANEL_DNS_NAME, rules: panelBefore }] : [];
    if (scope.refuse) {
      const known = new Set(allDnsConflicts([...reachingBefore, ...panelSourceBefore]).map((c) => c.key));
      const conflict = findDnsConflict([...reaching, ...panelSource], scope.refuse, known);
      if (conflict) throw new RoutingPresetDnsConflictError(n.name, conflict, scope.refuse.presetId);
    }
    const resolved = resolveDnsConflicts([...panelSource, ...reaching]);
    const left: StoredDnsConflict[] = resolved.dropped.map((d) => ({ kind: 'conflict', ...d }));
    // Presets first, the panel-wide rules last: what a node carries, in the order it carries it.
    const carriedOf = (sources: readonly NamedDnsSource[]): StoredPresetDns[] =>
      [...sources.filter((s) => s.presetId !== null), ...sources.filter((s) => s.presetId === null)]
        .map((s) => ({ presetId: s.presetId, rules: s.rules.filter(carriesRule).map((r) => ({ match: [...r.match], server: r.server })) }))
        .filter((s) => s.rules.length > 0);
    let kept = resolved.kept;
    let next = carriedOf(kept);
    let servers = nodeDnsServerCount(n.dns as DnsCfg | null, next);
    // Only a change that adds servers is refused: a node already over the limit before it is not stopped by a save that leaves it as it was.
    if (servers > NODE_DNS_MAX_SERVERS && scope.refuse) {
      const serversBefore = nodeDnsServerCount(n.dns as DnsCfg | null, carriedOf(resolveDnsConflicts([...panelSourceBefore, ...reachingBefore]).kept));
      if (servers > serversBefore) throw new RoutingPresetDnsLimitError(n.name, servers);
    }
    // Nobody to refuse: the preset that came last is the one left out, until the node fits.
    while (servers > NODE_DNS_MAX_SERVERS && next.some((s) => s.presetId !== null)) {
      const last = [...kept].reverse().find((s) => s.presetId !== null && next.some((c) => c.presetId === s.presetId))!;
      left.push({ kind: 'limit', presetId: last.presetId, count: servers });
      kept = kept.filter((s) => s !== last);
      next = carriedOf(kept);
      servers = nodeDnsServerCount(n.dns as DnsCfg | null, next);
    }
    const nextOrNull = next.length > 0 ? next : null;
    const leftOrNull = left.length > 0 ? left : null;
    plan.push({
      nodeId: n.id,
      next: nextOrNull,
      conflicts: leftOrNull,
      changed: !isDeepStrictEqual(Array.isArray(n.presetDnsRules) ? n.presetDnsRules : null, nextOrNull),
      conflictsChanged: !isDeepStrictEqual(Array.isArray(n.presetDnsConflicts) ? n.presetDnsConflicts : null, leftOrNull),
    });
  }
  return plan;
}

/** A save: the plan of the nodes the changed source touches, refused if the save makes a conflict. */
export function planDnsTransfer(change: DnsChange, db: Db = prisma): Promise<NodeDnsPlan[]> {
  return planCarriedDns({ change, refuse: { presetId: change.presetId } }, db);
}

/** Writes the plan's changed nodes; the ids to push (those whose carried rules changed). Inside the save's transaction. */
export async function writeDnsPlan(db: Db, plan: readonly NodeDnsPlan[]): Promise<string[]> {
  for (const p of plan.filter((q) => q.changed || q.conflictsChanged)) {
    await db.node.update({
      where: { id: p.nodeId },
      data: {
        ...(p.changed ? { presetDnsRules: p.next ? (p.next as unknown as Prisma.InputJsonValue) : Prisma.DbNull } : {}),
        ...(p.conflictsChanged ? { presetDnsConflicts: p.conflicts ? (p.conflicts as unknown as Prisma.InputJsonValue) : Prisma.DbNull } : {}),
      },
    });
  }
  return plan.filter((p) => p.changed).map((p) => p.nodeId);
}

/** One recompute at a time: a plan is read, then written, and two interleaved would write each other's stale view. Held to the end of the transaction. */
const DNS_TRANSFER_LOCK = 1911_0001;
export async function lockDnsTransfer(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${DNS_TRANSFER_LOCK})`;
}

/**
 * An assignment or a change of nodes, inside its own transaction: the carried
 * rules of the presets it touches are recomputed against the state the
 * transaction has just written, and written with it. With `refuse` a conflict
 * throws, which rolls the whole change back: nothing is written. Returns the
 * nodes to push once the transaction has committed (pushDnsNodes).
 */
export async function recomputeCarriedDns(tx: Prisma.TransactionClient, scope: DnsPlanScope): Promise<string[]> {
  await lockDnsTransfer(tx);
  return writeDnsPlan(tx, await planCarriedDns(scope, tx));
}

/**
 * A change that happened already (a squad's profiles, a binding, a deleted squad):
 * recompute without refusing, in its own transaction, then push the nodes whose
 * carried rules changed. What was left out is recorded on the node (19.12 shows it).
 */
export async function recomputeAfterChange(scope: Omit<DnsPlanScope, 'refuse' | 'change'> = {}): Promise<string[]> {
  const pushed = await prisma.$transaction((tx) => recomputeCarriedDns(tx, scope));
  await pushDnsNodes(pushed);
  return pushed;
}

/** The refusal of an assignment as an HTTP answer, or null for any other error. The preset field carries it to the form. */
export function dnsAssignRefusal(err: unknown): { status: number; body: Record<string, unknown> } | null {
  if (err instanceof RoutingPresetDnsConflictError) {
    return { status: 409, body: { error: err.code, message: err.message, field: 'customRoutingPresetId', node: err.node, preset: err.other, panel: err.otherIsPanel, domain: err.domain } };
  }
  if (err instanceof RoutingPresetDnsLimitError) {
    return { status: 409, body: { error: err.code, message: err.message, field: 'customRoutingPresetId', node: err.node, count: err.count } };
  }
  return null;
}

/** Queues the push to the nodes whose carried rules changed (the queue folds repeats per node). */
export async function pushDnsNodes(nodeIds: readonly string[]): Promise<void> {
  if (nodeIds.length === 0) return;
  const { enqueueNodePush } = await import('../inbounds/inbounds.queue.js');
  for (const id of nodeIds) await enqueueNodePush(id);
}
