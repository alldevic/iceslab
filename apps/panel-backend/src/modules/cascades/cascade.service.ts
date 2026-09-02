import type { XrayCascadeFragments, GeoAssetSpec } from '@iceslab/shared';
import { config } from '../../config.js';
import { getGeoBuildMeta } from '../geo/geo.registry.js';
import { geoArtifactBaseUrl } from '../geo/geo.url.js';
import { GEO_SITE_ARTIFACT, GEO_IP_ARTIFACT } from '../geo/geo.orchestrator.js';
import { coerceEgressPolicy, entryDomainStrategy, type EgressPolicy } from './cascade.geo.js';
import { compileRules, nodeEgressTargets } from '../egress/egress.policy.js';
import { zapret2SocksPortFor } from '../egress/egress.zapret2.js';
import { cascadeAutoProfileLabel, cascadeProfileLabel } from '../../lib/country-flag.js';
import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../prisma.js';
import { eventBus } from '../../lib/event-bus.js';
import { getLogger } from '../../lib/logger.js';
import {
  CascadeValidationError,
  foldPositionsIntoHops,
  validateCascadeHops,
  validateCascadeTopology,
} from './cascade.validation.js';
import {
  autoRouteTag,
  buildCascadeConfigs,
  buildBalancerCascadeConfigs,
  buildTopologyFragmentsForNode,
  compileNodeGeoRules,
  dirOutTag,
  directionTargetFor,
  entryDirectionCondition,
  transitDirectionCondition,
  generateLinkCreds,
  generateTopologyLinks,
  normalizeLinkProtocol,
  parseLinkCred,
  type StoredLink,
  routeTag,
  serializeLinkCred,
  type CascadeConfigHopInput,
  type CascadePolicy,
  type HopConfig,
  type LinkCred,
  type TopologyLinkRow,
} from './cascade.config.js';
import type {
  CascadeDirectionInput,
  CascadeHopInput,
  CascadePositionInput,
  CreateCascadeInput,
  UpdateCascadeInput,
} from './cascade.schemas.js';
import { assertEgressCategories } from './cascade.geo.stock.js';
import { getCategories } from '../geo/geo.categories.js';
import { mapCascade, type CascadeDto } from './cascade.mapper.js';

// The two custom .dat files the panel itself produces. A matcher pointing at
// anything else cannot be satisfied by pushing a file, so it is stripped rather
// than shipped.
const CUSTOM_EXT_FILES = new Set([GEO_SITE_ARTIFACT, GEO_IP_ARTIFACT]);

/** `ext:<file>:<category>` -> its parts, or null when the matcher is a standard
 *  geosite:/geoip:/literal one. */
function parseExtMatcher(m: string): { file: string; cat: string } | null {
  if (!m.startsWith('ext:')) return null;
  const rest = m.slice('ext:'.length);
  const i = rest.indexOf(':');
  if (i <= 0 || i === rest.length - 1) return null;
  return { file: rest.slice(0, i), cat: rest.slice(i + 1) };
}

/**
 * G4 - reconcile a node's geo split with what that node can actually resolve, so
 * we NEVER ship an `ext:<file>:<cat>` routing rule whose backing .dat (or the
 * category inside it) the node will not have. xray fails config load on a
 * missing ext file and crash-loops, which would wedge the node for every user.
 *
 * Returns the policy with UNSATISFIABLE ext: matchers stripped, plus the exact
 * custom .dat assets to push (only the files the cleaned policy still needs). An
 * ext:geo-custom.dat:CAT matcher is satisfiable only when self-hosting is on, a
 * build is cached, and CAT is NON-EMPTY in that build (an empty category is
 * omitted from the .dat). Standard geosite:/geoip:/literal matchers are always
 * kept: they resolve from the node's bundled databases, so the source mirror is
 * NOT pushed - overwriting the comprehensive bundle with a narrow mirror would
 * break every standard geosite: rule on the node.
 */
function resolveNodeGeo(policy: EgressPolicy | undefined): {
  policy: EgressPolicy | undefined;
  assets: GeoAssetSpec[] | undefined;
} {
  // meta is null when self-hosting is off (we cannot deliver files to nodes) or
  // no build is cached - either way no custom ext: matcher is satisfiable.
  const meta = config.GEO_SELF_HOST ? getGeoBuildMeta() : null;
  return reconcileEntryGeo(policy, meta, geoArtifactBaseUrl());
}

/** Pure core of resolveNodeGeo (see it): given the policy + the current build
 *  meta (null = no shippable custom geo) + the public base URL, strip
 *  unsatisfiable ext: matchers and return the custom .dat assets to push. */
export function reconcileEntryGeo(
  policy: EgressPolicy | undefined,
  meta: {
    categories: { name: string; domains: number; cidrs: number }[];
    artifacts: { name: string; sha256: string }[];
  } | null,
  baseUrl: string,
): { policy: EgressPolicy | undefined; assets: GeoAssetSpec[] | undefined } {
  if (!policy || policy.length === 0) return { policy, assets: undefined };

  const hasDomains = new Map<string, boolean>();
  const hasCidrs = new Map<string, boolean>();
  for (const c of meta?.categories ?? []) {
    hasDomains.set(c.name.toUpperCase(), c.domains > 0);
    hasCidrs.set(c.name.toUpperCase(), c.cidrs > 0);
  }
  const builtArtifacts = new Set((meta?.artifacts ?? []).map((a) => a.name));

  const extSatisfiable = (m: string): boolean => {
    const e = parseExtMatcher(m);
    if (!e) return true; // not an ext ref -> standard/literal, always keep
    if (e.file === GEO_SITE_ARTIFACT) {
      return builtArtifacts.has(GEO_SITE_ARTIFACT) && hasDomains.get(e.cat.toUpperCase()) === true;
    }
    if (e.file === GEO_IP_ARTIFACT) {
      return builtArtifacts.has(GEO_IP_ARTIFACT) && hasCidrs.get(e.cat.toUpperCase()) === true;
    }
    return false; // an ext file the panel never produces
  };
  const filterArr = (a?: string[]): string[] | undefined => {
    if (!a) return a;
    const kept = a.filter(extSatisfiable);
    return kept.length ? kept : undefined; // drop an emptied array so the rule can fall away
  };

  const neededFiles = new Set<string>();
  const cleaned: EgressPolicy = [];
  for (const r of policy) {
    const hadMatchers = Boolean(
      r.geosite?.length || r.geoip?.length || r.domain?.length || r.ip?.length,
    );
    const next = {
      ...r,
      geosite: filterArr(r.geosite),
      geoip: filterArr(r.geoip),
      domain: filterArr(r.domain),
      ip: filterArr(r.ip),
    };
    const keepsMatchers = Boolean(next.geosite || next.geoip || next.domain || next.ip);
    // If a rule HAD category/literal matchers and stripping removed them ALL,
    // DROP it rather than let a surviving `port`/`network` turn it into a
    // port-scoped catch-all: that would silently broaden the operator's
    // category-scoped rule to ALL traffic on that port (block => DoS all HTTPS;
    // direct => egress all HTTPS off this node, exposing its IP as the exit). A
    // rule that was port/network-only from the start is intentional and kept.
    if (hadMatchers && !keepsMatchers) continue;
    for (const m of [
      ...(next.geosite ?? []),
      ...(next.geoip ?? []),
      ...(next.domain ?? []),
      ...(next.ip ?? []),
    ]) {
      const e = parseExtMatcher(m);
      if (e && CUSTOM_EXT_FILES.has(e.file)) neededFiles.add(e.file);
    }
    cleaned.push(next);
  }

  let assets: GeoAssetSpec[] | undefined;
  if (meta && neededFiles.size > 0) {
    const base = baseUrl.replace(/\/+$/, '');
    const specs = meta.artifacts
      .filter((a) => neededFiles.has(a.name))
      .map((a) => ({ name: a.name, url: `${base}/${a.name}`, sha256: a.sha256 }));
    assets = specs.length ? specs : undefined;
  }
  return { policy: cleaned, assets };
}

/**
 * Cascade members whose geo split still references a custom category, by node id.
 *
 * Deleting a category that a policy names is not an error the operator ever
 * sees: reconciliation strips the unsatisfiable ext: matcher at render time (it
 * has to — xray refuses a config naming a .dat it cannot find), so the split
 * quietly stops splitting on a screen the operator is not looking at. Callers
 * use this to refuse the delete and say where it is used.
 */
export async function nodesUsingGeoCategory(category: string): Promise<string[]> {
  return (await geoCategoryUsage())[category.toUpperCase()] ?? [];
}

/**
 * The whole picture behind nodesUsingGeoCategory: every custom category a live
 * split routes by, mapped to the cascades that name it. Keys are UPPERCASED,
 * the way the builder normalises category names.
 *
 * One scan for every category rather than one scan per category, because the geo
 * screen wants the answer for the whole list at once. It exists so the operator
 * learns where a category is used BEFORE reaching for delete - the 409 tells the
 * truth, but only to somebody who already decided to destroy something.
 *
 * Scoped to ENABLED cascades, exactly like the delete guard it backs: a screen
 * that counted more than the guard refuses would promise a delete would fail
 * when it succeeds.
 */
export async function geoCategoryUsage(): Promise<Record<string, string[]>> {
  const members = await prisma.cascadePositionNode.findMany({
    where: { position: { cascade: { enabled: true } } },
    select: { nodeId: true, egressPolicy: true, position: { select: { cascade: { select: { name: true } } } } },
  });
  const usage = new Map<string, Set<string>>();
  for (const m of members) {
    const policy = coerceEgressPolicy(m.egressPolicy);
    if (!policy) continue;
    const refs = policy.flatMap((r) => [
      ...(r.geosite ?? []),
      ...(r.geoip ?? []),
      ...(r.domain ?? []),
      ...(r.ip ?? []),
    ]);
    for (const ref of refs) {
      // `ext:<file>:<CATEGORY>` - only an ext: reference names a category the
      // panel owns. A bundled `geosite:ads` resolves from the node's own
      // databases and is nothing this registry can break.
      const e = parseExtMatcher(ref);
      if (!e) continue;
      const key = e.cat.toUpperCase();
      const names = usage.get(key) ?? new Set<string>();
      names.add(m.position.cascade.name);
      usage.set(key, names);
    }
  }
  return Object.fromEntries([...usage].map(([cat, names]) => [cat, [...names]]));
}

/** Every matcher a policy names, flattened. Used to say which ones survive
 *  reconciliation and which the node will never see. */
function policyMatchers(policy: EgressPolicy | undefined): string[] {
  return (policy ?? []).flatMap((r) => [
    ...(r.geosite ?? []),
    ...(r.geoip ?? []),
    ...(r.domain ?? []),
    ...(r.ip ?? []),
  ]);
}

export interface GeoPreviewInput {
  policy: EgressPolicy;
  /** The node this split is authored for, so the preview can also show what its
   *  own egress policy contributes ahead of the split. Optional for callers
   *  that predate it. */
  nodeId?: string;
  /** Index of the position holding this node. 0 is the entry, and the entry is
   *  the only hop that can read the client's chosen direction out of its UUID. */
  position: number;
  /** Node ids on the position BEFORE this one. Every one of them opens a link
   *  here per direction, and their credentials are how a transit tells the
   *  directions apart. Empty at the entry. */
  prevNodeIds: string[];
  /** The cascade's directions, with how many outbounds serve each FROM THIS
   *  NODE - i.e. the size of the next step's pool, since a pool means a
   *  balancer rather than a single outbound. */
  directions: { tag: number; outbounds: number }[];
}

export interface GeoPreviewResult {
  /** The routing rules this split compiles to, in match order. */
  rules: Record<string, unknown>[];
  /** The rules the node's OWN egress policy contributes, which the node renders
   *  BEFORE the ones above (see the render-order test in the node agent). Empty
   *  when the node has no policy of its own, or when the caller did not say
   *  which node this is. Separate from `rules` so the operator can see which
   *  half they are looking at rather than one blurred list. */
  nodeRules: Record<string, unknown>[];
  /** The entry's routing.domainStrategy override, when the policy needs one. */
  domainStrategy?: string;
  /** Matchers reconciliation removes before the node ever sees them (a custom
   *  category that is not built, or is empty in the current build). This is the
   *  usual answer to "the rule is there and nothing happens". */
  dropped: string[];
}

/**
 * What a draft geo policy actually compiles to, for the panel to show BEFORE it
 * is saved.
 *
 * Runs the real compiler (compileNodeGeoRules) over the real reconciliation
 * (resolveNodeGeo), so the preview cannot drift from what the node gets: the
 * only thing synthesised here is the topology the draft describes but has not
 * saved yet - which outbounds serve each direction, and which nodes sit on the
 * previous step.
 */
export async function previewNodeGeo(input: GeoPreviewInput): Promise<GeoPreviewResult> {
  const { policy: reconciled } = resolveNodeGeo(input.policy);
  const survived = new Set(policyMatchers(reconciled));
  const dropped = [...new Set(policyMatchers(input.policy).filter((m) => !survived.has(m)))];

  // Pass 1 of the real builder, over the draft's directions. A direction with no
  // outbound from here cannot be steered into, so it is left out rather than
  // given a rule pointing nowhere - exactly what the builder does.
  const balancers: Record<string, unknown>[] = [];
  const dirTargets = new Map<number, Record<string, unknown>>();
  for (const d of [...input.directions].sort((a, b) => a.tag - b.tag)) {
    if (d.outbounds < 1) continue;
    const tags = Array.from({ length: d.outbounds }, (_, i) => dirOutTag(d.tag, i));
    dirTargets.set(d.tag, directionTargetFor(d.tag, tags, balancers));
  }

  // The entry's direction condition names every route policy's ordinal, so the
  // ad-blocking variants of a profile steer the same way as the plain one.
  const ordinals =
    input.position === 0
      ? (await prisma.routePolicy.findMany({ select: { ordinal: true } })).map((p) => p.ordinal)
      : [];

  const rules =
    reconciled && reconciled.length > 0
      ? compileNodeGeoRules(reconciled, dirTargets, (tag) =>
          input.position === 0
            ? entryDirectionCondition(tag, ordinals)
            : transitDirectionCondition(tag, input.prevNodeIds),
        )
      : [];

  // The node's own egress policy, compiled the same way the push compiles it,
  // because the node renders those rules ahead of this split and a preview that
  // omits them answers a question the operator did not ask. Same compiler, same
  // capability resolution: a preview that agrees with the push only until one
  // of them changes is worse than no preview.
  const nodeRules = input.nodeId ? await nodeOwnEgressRules(input.nodeId) : [];

  // One config, one domainStrategy: whichever half needs IP resolution forces
  // it, mirroring how the node combines the two overrides.
  const domainStrategy =
    entryDomainStrategy(reconciled) ??
    (nodeRules.some((r) => Array.isArray(r.ip)) ? 'IPOnDemand' : undefined);
  return { rules, nodeRules, ...(domainStrategy ? { domainStrategy } : {}), dropped };
}

/**
 * The xray rules a node's OWN egress policy (Node.hardening.egressPolicy)
 * compiles to, against the ways out that node actually has. Empty for a node
 * with no policy, an unknown node, or a policy whose every rule names a channel
 * this node does not run.
 */
async function nodeOwnEgressRules(nodeId: string): Promise<Record<string, unknown>[]> {
  const node = await prisma.node.findUnique({
    where: { id: nodeId },
    select: { hardening: true, warpEnabled: true, warpAccount: true },
  });
  if (!node) return [];
  const hardening = node.hardening as { egressPolicy?: unknown; zapret2?: unknown } | null;
  const policy = coerceEgressPolicy(hardening?.egressPolicy);
  if (!policy) return [];
  const warpUsable = Boolean(
    node.warpEnabled &&
      (node.warpAccount as { secretKey?: string } | null)?.secretKey,
  );
  return compileRules(
    policy,
    nodeEgressTargets({
      warp: warpUsable,
      zapret2SocksPort: zapret2SocksPortFor(hardening?.zapret2),
    }),
  ).rules;
}

/** Per-node policies for one cascade, reconciled against the current geo build.
 *  Returns the map to hand the fragment builder plus the union of assets the
 *  node must fetch. */
export function resolveCascadeGeo(
  members: { nodeId: string; egressPolicy: unknown }[],
): { policies: Map<string, EgressPolicy>; assetsByNode: Map<string, GeoAssetSpec[]> } {
  const policies = new Map<string, EgressPolicy>();
  const assetsByNode = new Map<string, GeoAssetSpec[]>();
  for (const m of members) {
    const raw = coerceEgressPolicy(m.egressPolicy);
    if (!raw) continue;
    const { policy, assets } = resolveNodeGeo(raw);
    if (policy && policy.length > 0) policies.set(m.nodeId, policy);
    if (assets && assets.length > 0) assetsByNode.set(m.nodeId, assets);
  }
  return { policies, assetsByNode };
}

export class CascadeNotFoundError extends Error {
  constructor(id: string) {
    super(`Cascade ${id} not found`);
    this.name = 'CascadeNotFoundError';
  }
}
export class CascadeNameTakenError extends Error {
  constructor(name: string) {
    super(`Cascade name "${name}" is already in use`);
    this.name = 'CascadeNameTakenError';
  }
}
export class CascadeNodeMissingError extends Error {
  constructor(nodeId: string) {
    super(`Node ${nodeId} does not exist`);
    this.name = 'CascadeNodeMissingError';
  }
}
export class CascadeEntryCoreTooOldError extends Error {
  constructor(
    public readonly nodeName: string,
    public readonly coreVersion: string,
    public readonly minVersion: string,
  ) {
    super(
      `Entry node "${nodeName}" runs xray ${coreVersion}; enabling a balancer cascade needs xray >= ${minVersion} so exit selection (vlessRoute) works. Upgrade the entry node's xray, or keep the cascade disabled.`,
    );
    this.name = 'CascadeEntryCoreTooOldError';
  }
}

// T7: minimum xray-core version on a balancer ENTRY. Below this, xray doesn't
// understand vlessRoute and rejects the exit-selection UUID at auth (silent
// connect failure), so the panel blocks enabling such a cascade.
export const MIN_XRAY_VLESSROUTE = '25.9.5';

/** Numeric dotted-version compare: is `v` >= `min`? Non-numeric / missing parts
 *  count as 0. Exported for tests. */
export function versionAtLeast(v: string, min: string): boolean {
  const parts = (s: string): number[] => s.split('.').map((n) => parseInt(n, 10) || 0);
  const a = parts(v);
  const b = parts(min);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** T7 gate: an ENABLED balancer entry hands every user vlessRoute-tagged exit
 *  configs, which a pre-25.9.5 xray rejects at auth. Block if the entry's core
 *  is known-old. Unknown version (null: pre-T7 agent, or not yet polled) is
 *  allowed, we can't prove it's old and shouldn't wedge the operator. */
async function assertBalancerEntrySupportsVlessRoute(entryNodeId: string): Promise<void> {
  const node = await prisma.node.findUnique({
    where: { id: entryNodeId },
    select: { name: true, coreVersion: true },
  });
  if (!node?.coreVersion) return; // unknown -> allow
  if (!versionAtLeast(node.coreVersion, MIN_XRAY_VLESSROUTE)) {
    throw new CascadeEntryCoreTooOldError(node.name, node.coreVersion, MIN_XRAY_VLESSROUTE);
  }
}

const hopInclude = {
  hops: {
    orderBy: { position: 'asc' as const },
    include: { node: { select: { id: true, name: true } } },
  },
  // v4 shape, served alongside hops. The panel needs `directions[].id` back on
  // save to keep a direction's tag: without it every edit looks like a new
  // direction and the tag (which lives in clients' UUIDs) would move.
  positions: {
    orderBy: { position: 'asc' as const },
    include: { nodes: { select: { nodeId: true, egressPolicy: true } } },
  },
  directions: {
    orderBy: { tag: 'asc' as const },
    include: { nodes: { select: { nodeId: true } } },
  },
};

async function assertNodesExist(nodeIds: string[]): Promise<void> {
  const found = await prisma.node.findMany({
    where: { id: { in: nodeIds }, deletedAt: null },
    select: { id: true },
  });
  const ok = new Set(found.map((n) => n.id));
  for (const id of nodeIds) {
    if (!ok.has(id)) throw new CascadeNodeMissingError(id);
  }
}

// ───── Subscription exposure (cascade leak fix) ─────
//
// A node that is a NON-ENTRY hop (position > 0) of an ENABLED cascade is
// chain-internal: users reach the cascade through the ENTRY node only, so a
// transit/exit node must never be a directly-connectable subscription endpoint
// - otherwise the client bypasses the chain and connects straight to the exit
// (the leak we hit in the field: Happ connecting directly to the DE exit).
// generateSubscription drops these node ids from a user's endpoint list. A node
// that is ALSO an entry of some enabled cascade stays exposed (entries are the
// reachable surface; v1 keeps a node in <=1 cascade, the subtraction is
// defensive). Cached in-process (cascades change rarely) + busted on every
// cascade write.
let hiddenNodesCache: { value: Set<string>; expiresAt: number } | null = null;
const HIDDEN_NODES_TTL_MS = 60_000;

export function invalidateHiddenCascadeNodeCache(): void {
  hiddenNodesCache = null;
}

export async function getHiddenCascadeNodeIds(): Promise<Set<string>> {
  if (hiddenNodesCache && Date.now() < hiddenNodesCache.expiresAt) {
    return hiddenNodesCache.value;
  }
  // Only cascades that opt INTO hiding (the default) suppress their non-entry
  // hops. An operator who unchecks `hideHopsFromSub` keeps the exits visible as
  // direct subscription picks (they still work standalone; the cascade just
  // additionally offers them behind its "Auto" entry).
  const [hops, positions, directionNodes] = await Promise.all([
    prisma.cascadeHop.findMany({
      where: { cascade: { enabled: true, hideHopsFromSub: true } },
      select: { nodeId: true, position: true },
    }),
    // v4: the same rule, read from the topology tables. Without this a v4-only
    // cascade would leak its transits and exits into subscriptions as direct
    // endpoints, which is exactly the bypass this function exists to stop.
    prisma.cascadePosition.findMany({
      where: { cascade: { enabled: true, hideHopsFromSub: true } },
      select: { position: true, nodes: { select: { nodeId: true } } },
    }),
    prisma.cascadeDirectionNode.findMany({
      where: { direction: { cascade: { enabled: true, hideHopsFromSub: true } } },
      select: { nodeId: true },
    }),
  ]);
  const entry = new Set<string>();
  const nonEntry = new Set<string>();
  for (const p of positions) {
    for (const n of p.nodes) {
      if (p.position === 0) entry.add(n.nodeId);
      else nonEntry.add(n.nodeId);
    }
  }
  // A direction is never an entry: it is the way OUT.
  for (const d of directionNodes) nonEntry.add(d.nodeId);
  for (const h of hops) {
    if (h.position === 0) entry.add(h.nodeId);
    else nonEntry.add(h.nodeId);
  }
  for (const id of entry) nonEntry.delete(id);
  hiddenNodesCache = { value: nonEntry, expiresAt: Date.now() + HIDDEN_NODES_TTL_MS };
  return nonEntry;
}

/** One line a subscriber can pick at a cascade entry: what it is called, the tag
 *  its UUID must encode, and which cascade it belongs to.
 *
 *  `cascadeId` exists because every entry of a pool offers the same profiles, so
 *  the subscription has to recognise "these lines are the same cascade seen from
 *  two ways in" to collapse them. Grouping by label would work until an operator
 *  named two cascades alike. */
export interface CascadeRouteProfile {
  label: string;
  tag: number;
  cascadeId: string;
}

/** A4: map each given node id that is the ENTRY (position 0) of an enabled
 *  cascade to the route-PROFILES a user in `groupIds` can pick there. A profile
 *  = (allowed exit) x (plain OR a granted ad-split policy), carrying a `label`
 *  (client-facing name) and the `tag` its UUID must encode (routeTag).
 *  Two ACL axes: exits are opt-in RESTRICTION (no rows = all exits), policies are
 *  opt-in GRANT (plain always; extra policy only if a squad granted it). Nodes
 *  that aren't entries, and cascades with no allowed exit, are absent. The
 *  subscription builder expands one entry endpoint into one config per profile.
 *
 *  Chains used to be excluded here by a `mode: 'balancer'` filter, on the
 *  reasoning that a fixed path offers no choice. True for the EXIT, false for
 *  the policy: an operator could define an ad-split policy, grant it to a squad,
 *  and get nothing at all on a chain. Chains now take part, with one guard below
 *  so an untouched chain keeps handing out exactly the links it does today. */
export async function getRouteProfilesByEntryNode(
  nodeIds: string[],
  groupIds: string[] = [],
  entryReach?: Map<string, Set<string>>,
): Promise<Map<string, CascadeRouteProfile[]>> {
  const out = new Map<string, CascadeRouteProfile[]>();
  if (nodeIds.length === 0) return out;
  const cascades = await prisma.cascade.findMany({
    where: {
      enabled: true,
      OR: [
        { hops: { some: { nodeId: { in: nodeIds }, position: 0 } } },
        { positions: { some: { position: 0, nodes: { some: { nodeId: { in: nodeIds } } } } } },
      ],
    },
    include: {
      hops: {
        orderBy: { position: 'asc' },
        // countryCode drives the flag and the label of a route profile: what a
        // client picks here is a COUNTRY to leave from, not a machine.
        include: { node: { select: { id: true, name: true, countryCode: true } } },
      },
      positions: {
        orderBy: { position: 'asc' },
        include: { nodes: { select: { nodeId: true, egressPolicy: true } } },
      },
      directions: {
        orderBy: { tag: 'asc' },
        include: {
          nodes: { select: { node: { select: { id: true, name: true, countryCode: true } } } },
        },
      },
    },
  });
  if (cascades.length === 0) return out;

  // A4 increment 2: per-squad exit allow-list. Union the user's allow rows per
  // cascade. OPT-IN restriction: a cascade absent from this map is unrestricted
  // (no rows => all exits); present => keep only the allowed exit nodes.
  const allowByCascade = new Map<string, Set<string>>();
  // Per-SQUAD views of the same two facts, so a policy can be attributed to the
  // squad that granted it (see policiesForDirection).
  const allowByGroupCascade = new Map<string, Set<string>>(); // `${groupId}|${cascadeId}`
  const policiesByGroup = new Map<string, { ordinal: number; name: string }[]>();
  if (groupIds.length > 0) {
    const [exitRows, grants] = await Promise.all([
      prisma.groupCascadeExit.findMany({
        where: { groupId: { in: groupIds }, cascadeId: { in: cascades.map((c) => c.id) } },
        select: { groupId: true, cascadeId: true, exitNodeId: true },
      }),
      prisma.groupRoutePolicy.findMany({
        where: { groupId: { in: groupIds } },
        select: { groupId: true, policy: { select: { ordinal: true, name: true } } },
      }),
    ]);
    for (const r of exitRows) {
      const k = `${r.groupId}|${r.cascadeId}`;
      const s = allowByGroupCascade.get(k) ?? new Set<string>();
      s.add(r.exitNodeId);
      allowByGroupCascade.set(k, s);
    }
    for (const g of grants) {
      const list = policiesByGroup.get(g.groupId) ?? [];
      if (!list.some((p) => p.ordinal === g.policy.ordinal)) list.push(g.policy);
      policiesByGroup.set(g.groupId, list);
    }
    for (const r of exitRows) {
      let set = allowByCascade.get(r.cascadeId);
      if (!set) {
        set = new Set();
        allowByCascade.set(r.cascadeId, set);
      }
      set.add(r.exitNodeId);
    }
  }

  for (const c of cascades) {
    // v4 path: profiles come from DIRECTIONS, and the tag is the direction's
    // own frozen tag rather than its ordinal in a list. This has to match how
    // the node routes (buildTopologyFragmentsForNode uses the same tag): with
    // ordinals, a cascade whose tag 2 was burned by a deletion would hand
    // clients a tag that resolves to a different country.
    if (c.directions.length > 0) {
      const entryPos = c.positions.find((p) => p.position === 0);
      /**
       * EVERY entry of the pool, not just the first one that matched.
       *
       * A position holds interchangeable nodes, so each of them is a way into
       * the same cascade and each must expand into the same per-direction
       * configs. Taking only the first left the others without cascade
       * profiles, and an endpoint with no profiles is emitted as an ordinary
       * direct server: the subscriber saw the second entry as a plain node,
       * picked it, and egressed from the ENTRY country instead of the exit they
       * were choosing. Found 2026-08-15 on a two-node entry pool, where the
       * second entry showed up as its own line next to the cascade's.
       */
      const entryNodeIds = (entryPos?.nodes.map((n) => n.nodeId) ?? []).filter((id) =>
        nodeIds.includes(id),
      );
      if (entryNodeIds.length === 0) continue;
      const allowed = allowByCascade.get(c.id);
      /**
       * Policies that apply to THIS direction: only the ones granted by squads
       * that also let the user reach it.
       *
       * Before this, grants were pooled across every squad and sprayed onto
       * every direction of every cascade, so a squad handing out "no ads" for
       * the Dutch exit also produced a "no ads" profile on the Swedish one -
       * which the operator never configured and cannot switch off. A grant is
       * meaningful only inside the squad that made it, because the squad is
       * also what decides which exits the user sees.
       *
       * A squad with no allow-rows for a cascade is unrestricted there (the
       * existing opt-in convention), so its policies apply to all of that
       * cascade's directions.
       */
      const exitAllowByGroup = new Map<string, Set<string>>();
      for (const groupId of groupIds) {
        const allows = allowByGroupCascade.get(`${groupId}|${c.id}`);
        if (allows) exitAllowByGroup.set(groupId, allows);
      }
      // Per entry, because the granted policies depend on which squads hand out
      // THAT entry: two entries of one pool can legitimately differ.
      for (const entryNodeId of entryNodeIds) {
        const policiesForDirection = (directionNodeIds: string[]): RoutePolicyRef[] =>
          policiesForEntry({
            groupIds,
            entryNodeId,
            policiesByGroup,
            entryReach,
            directionNodeIds,
            exitAllowByGroup,
          });
        const profiles: CascadeRouteProfile[] = [];
        /**
         * AUTO first, when the operator turned it on and the user is free to
         * use every exit.
         *
         * The restriction check is the load-bearing half. A squad's exit
         * allow-list is enforced by which TAGS a user is handed, and Auto names
         * no exit at all: the entry's balancer spans every direction, because a
         * node config is one config for everybody and cannot be narrowed per
         * user. Handing Auto to a restricted user would walk straight past the
         * allow-list their operator set. So they simply do not get the row; a
         * per-subset balancer is the shape that would let them, and that is a
         * separate piece of work.
         *
         * Two directions minimum, matching the node side exactly: with one, Auto
         * resolves to the same single destination as the row above it.
         */
        const usable = c.directions.filter((d) => d.nodes.length > 0);
        if (c.autoProfile && !allowed && usable.length > 1) {
          const autoLabel = cascadeAutoProfileLabel(c.name);
          profiles.push({ label: autoLabel, tag: autoRouteTag(0), cascadeId: c.id });
          // Policy variants of Auto are gated by the direction they can reach,
          // so a policy granted only for one direction does not become an Auto
          // row that can egress through another.
          for (const p of policiesForDirection(usable.flatMap((d) => d.nodes.map((n) => n.node.id)))) {
            profiles.push({
              label: `${autoLabel} · ${p.name}`,
              tag: autoRouteTag(p.ordinal),
              cascadeId: c.id,
            });
          }
        }
        for (const d of c.directions) {
          // A direction with no node serves nobody; offering it would hand out a
          // config that cannot connect.
          if (d.nodes.length === 0) continue;
          // Squad ACL is keyed on exit NODES, so a direction survives if any of
          // its pool is allowed.
          if (allowed && !d.nodes.some((n) => allowed.has(n.node.id))) continue;
          const first = d.nodes[0]!.node;
          const label = cascadeProfileLabel(c.name, d.countryCode ?? first.countryCode, first.name);
          profiles.push({ label, tag: routeTag(0, d.tag - 1), cascadeId: c.id });
          for (const p of policiesForDirection(d.nodes.map((n) => n.node.id))) {
            profiles.push({
              label: `${label} · ${p.name}`,
              tag: routeTag(p.ordinal, d.tag - 1),
              cascadeId: c.id,
            });
          }
        }
        if (profiles.length > 0) out.set(entryNodeId, profiles);
      }
      continue;
    }

    const entry = c.hops.find((h) => h.position === 0);
    if (!entry || !nodeIds.includes(entry.nodeId)) continue;
    const isBalancer = c.mode === 'balancer';
    // Same entry gate as the v4 path above: only squads that hand out THIS
    // entry add their policy variants to it. Exits are filtered separately here
    // (applyExitAcl below), so the direction gate is not used on this path.
    const grantedPolicies = policiesForEntry({
      groupIds,
      entryNodeId: entry.nodeId,
      policiesByGroup,
      entryReach,
    });
    // A chain with no granted policy emits NOTHING, deliberately. Its only
    // profile would be the plain one, which resolves to the same single exit an
    // untagged UUID already reaches, so tagging would rewrite every user's UUID
    // for zero behavioural gain. Balancers always emit: there the tag is what
    // pins the exit, and that is existing shipped behaviour.
    if (!isBalancer && grantedPolicies.length === 0) continue;
    // index = position in the FULL exit list (position-asc), matching the node's
    // cascade-link-out-<index>; computed BEFORE the squad filter so a kept subset
    // still tags each exit with the right link-out.
    //
    // A chain has exactly one exit, its last hop, and it carries index 0: the
    // chain entry emits a single unindexed link-out, so every tag routed there
    // must use exitIndex 0.
    const exitHops = isBalancer ? c.hops.filter((h) => h.position !== 0) : c.hops.slice(-1);
    const fullExits = exitHops.map((h, i) => ({
      name: cascadeProfileLabel(c.name, h.node.countryCode, h.node.name),
      index: i,
      nodeId: h.node.id,
    }));
    const exits = applyExitAcl(fullExits, allowByCascade.get(c.id));
    if (exits.length === 0) continue;
    // Cartesian: each exit x (plain + granted policies). Plain first per exit so
    // the client list reads CH, CH-no-ads, TR, TR-no-ads.
    const profiles: CascadeRouteProfile[] = [];
    // AUTO on the legacy balancer shape. No node change is needed here: that
    // entry ends its rules with a catch-all into the same balancer, so a tag it
    // does not recognise already means "let the balancer choose". Same two gates
    // as the v4 path: the operator asked for it, and the user is unrestricted,
    // since Auto can reach any exit.
    if (c.autoProfile && isBalancer && !allowByCascade.get(c.id) && fullExits.length > 1) {
      const autoLabel = cascadeAutoProfileLabel(c.name);
      profiles.push({ label: autoLabel, tag: autoRouteTag(0), cascadeId: c.id });
      for (const p of grantedPolicies) {
        profiles.push({
          label: `${autoLabel} · ${p.name}`,
          tag: autoRouteTag(p.ordinal),
          cascadeId: c.id,
        });
      }
    }
    for (const ex of exits) {
      profiles.push({ label: ex.name, tag: routeTag(0, ex.index), cascadeId: c.id });
      for (const p of grantedPolicies) {
        profiles.push({
          label: `${ex.name} · ${p.name}`,
          tag: routeTag(p.ordinal, ex.index),
          cascadeId: c.id,
        });
      }
    }
    out.set(entry.nodeId, profiles);
  }
  return out;
}

export interface RoutePolicyRef {
  ordinal: number;
  name: string;
}

/**
 * Which ad-split policies add a variant at ONE entry (and optionally on one
 * direction out of it). Two independent gates, both opt-in restrictions:
 *
 *  - `entryReach`: squads that hand this ENTRY out. A grant lives inside the
 *    squad that made it, and a squad only speaks where it hands something out.
 *    Missing map = no gate (other callers keep their old behaviour); a node
 *    absent FROM the map is reached by nobody, since the caller builds it from
 *    the very bindings the user is being served.
 *  - `exitAllowByGroup`: that squad's exit allow-list for this cascade. A squad
 *    with no rows is unrestricted, the existing convention.
 *
 * Both were needed to fix the field report of 2026-08-08: a squad handing out
 * the Dutch entry with "no ads" granted also stamped a "no ads" variant onto a
 * Swedish entry belonging to a different squad, which the operator never
 * configured, could not switch off, and which the squad screen's own preview
 * did not show. Exit-list scoping alone could not catch it, because neither
 * squad had restricted its exits at all.
 *
 * Pure and exported so the semantics can be tested without a database.
 */
export function policiesForEntry(args: {
  groupIds: string[];
  entryNodeId: string;
  policiesByGroup: Map<string, RoutePolicyRef[]>;
  entryReach?: Map<string, Set<string>>;
  /** Exit nodes of the direction being offered. Omit to skip the exit gate. */
  directionNodeIds?: string[];
  /** groupId -> allowed exit nodes for THIS cascade. */
  exitAllowByGroup?: Map<string, Set<string>>;
}): RoutePolicyRef[] {
  const { groupIds, entryNodeId, policiesByGroup, entryReach, directionNodeIds } = args;
  const reach = entryReach?.get(entryNodeId);
  const seen = new Set<number>();
  const out: RoutePolicyRef[] = [];
  for (const groupId of groupIds) {
    if (entryReach && !reach?.has(groupId)) continue;
    if (directionNodeIds) {
      const allows = args.exitAllowByGroup?.get(groupId);
      if (allows && !directionNodeIds.some((id) => allows.has(id))) continue;
    }
    for (const p of policiesByGroup.get(groupId) ?? []) {
      if (seen.has(p.ordinal)) continue;
      seen.add(p.ordinal);
      out.push(p);
    }
  }
  return out;
}

/** A4 increment 2: apply a squad exit allow-set to a cascade's full exit list.
 *  `allowed` undefined => opt-in default, keep ALL exits. A present set (union of
 *  the user's squads' grants) => keep only those exit nodes. The `index` (link-out
 *  position) is preserved so a filtered subset still selects the right link-out.
 *  Exported for unit testing the semantics without a DB. */
export function applyExitAcl(
  fullExits: { name: string; index: number; nodeId: string }[],
  allowed: Set<string> | undefined,
): { name: string; index: number }[] {
  return fullExits
    .filter((e) => !allowed || allowed.has(e.nodeId))
    .map((e) => ({ name: e.name, index: e.index }));
}

export async function listCascades(): Promise<CascadeDto[]> {
  const rows = await prisma.cascade.findMany({
    include: hopInclude,
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(mapCascade);
}

export async function getCascade(id: string): Promise<CascadeDto> {
  const c = await prisma.cascade.findUnique({ where: { id }, include: hopInclude });
  if (!c) throw new CascadeNotFoundError(id);
  return mapCascade(c);
}

export interface CascadeHopStatus {
  nodeId: string;
  name: string;
  /** The node acknowledged an inbound push made after this cascade was saved. */
  applied: boolean;
  online: boolean;
}

export interface CascadeStatusDto {
  /** Every hop has acknowledged the push. */
  done: boolean;
  hops: CascadeHopStatus[];
}

/**
 * Provisioning status of a cascade's hops. Saving a cascade pushes new inbound
 * config to each hop asynchronously (cascade.changed -> inbound-sync), so the
 * UI otherwise cannot tell whether the save actually landed.
 *
 * `applied` compares the node's `lastInboundSyncAt`, stamped only when
 * applyInbounds returned ok, against the cascade's `updatedAt`. That is a
 * truthful "this node took the config we sent after you saved". Note it is
 * deliberately NOT `lastStatusChange`: that field only moves on an
 * online/offline transition, so a node that stays healthy would never satisfy
 * it and every successful save would look like it was still pending.
 *
 * A node that is offline reports applied=false and online=false, which is the
 * honest answer: the push is queued and the cron re-pushes when it returns.
 */
export async function getCascadeStatus(id: string): Promise<CascadeStatusDto> {
  const c = await prisma.cascade.findUnique({
    where: { id },
    include: {
      hops: {
        orderBy: { position: 'asc' },
        include: {
          node: { select: { id: true, name: true, status: true, lastInboundSyncAt: true } },
        },
      },
    },
  });
  if (!c) throw new CascadeNotFoundError(id);

  const savedAt = c.updatedAt;
  const hops = c.hops.map((h) => ({
    nodeId: h.node.id,
    name: h.node.name,
    applied: !!h.node.lastInboundSyncAt && h.node.lastInboundSyncAt > savedAt,
    online: h.node.status === 'online',
  }));
  return { done: hops.length > 0 && hops.every((h) => h.applied), hops };
}

/**
 * Fold a v4 payload into hops, or return null when the shape cannot be held by
 * the old model (a pool, or transits with several directions).
 *
 * Returning null rather than throwing is the point: v4 is the storage that
 * matters now, and the legacy hop rows are a convenience for rollback. A
 * topology that only v4 can express must still save.
 */
function tryFoldPositions(
  positions: CascadePositionInput[],
  directions: CascadeDirectionInput[],
): { mode: 'chain' | 'balancer'; hops: CascadeHopInput[] } | null {
  try {
    return foldPositionsIntoHops(positions, directions);
  } catch (err) {
    if (err instanceof CascadeValidationError) return null;
    throw err;
  }
}

/**
 * Write a cascade's v4 topology (positions, directions, links) inside `tx`.
 *
 * Runs ALONGSIDE the legacy hop write for now: storage moves first, readers
 * (fragment rendering, route profiles) follow in the next step. Until they do,
 * hops remain the source of truth and this is a shadow copy - which is exactly
 * what makes the switchover boring instead of a big-bang rewrite.
 *
 * Tag preservation is the whole point of the model, so it is spelled out here:
 *   - a direction the client identified by `id` keeps its tag AND its id: the
 *     row is updated in place, because the id is what the next save will use to
 *     name it, and a re-minted id demotes that save to the pool guess below;
 *   - one the client did not identify, but whose node pool matches a stored
 *     direction, is treated as that same direction (the panel does not send ids
 *     yet; without this fallback every save would burn new tags and silently
 *     reroute users);
 *   - anything else is new and draws the next tag from the cascade's counter;
 *   - a stored direction absent from the payload is deleted, and its tag is
 *     never handed out again.
 */
async function writeTopologyV4(
  tx: Prisma.TransactionClient,
  cascadeId: string,
  positions: {
    nodeIds: string[];
    position: number;
    entryProtocol?: string;
    linkProtocol?: string;
    /** E - per-node geo split, keyed by node id (see CascadePositionSchema). */
    egressPolicies?: Record<string, EgressPolicy>;
  }[],
  directions: { id?: string; nodeIds: string[]; countryCode?: string | null }[],
): Promise<void> {
  const stored = await tx.cascadeDirection.findMany({
    where: { cascadeId },
    select: { id: true, tag: true, nodes: { select: { nodeId: true } } },
  });
  const storedById = new Map(stored.map((d) => [d.id, d]));
  const unclaimed = new Set(stored.map((d) => d.id));

  // Resolve each incoming direction to a tag before writing anything.
  const cascade = await tx.cascade.findUniqueOrThrow({
    where: { id: cascadeId },
    select: { nextDirectionTag: true },
  });
  let nextTag = cascade.nextDirectionTag;
  const resolved = directions.map((d) => {
    let match = d.id ? storedById.get(d.id) : undefined;
    if (!match && d.nodeIds.length > 0) {
      // Same pool = same direction. Compared as a set: reordering the pool in
      // the UI must not look like a different way out.
      const want = new Set(d.nodeIds);
      match = stored.find(
        (s) =>
          unclaimed.has(s.id) &&
          s.nodes.length === want.size &&
          s.nodes.every((n) => want.has(n.nodeId)),
      );
    }
    if (match && unclaimed.has(match.id)) {
      unclaimed.delete(match.id);
      // Carry the stored ROW, not only its tag. The row id is what the editor
      // sends back to name this direction on the next save, so a save that
      // re-mints it leaves the client holding an id that identifies nothing and
      // silently demotes the next edit to the pool fallback below.
      return { ...d, tag: match.tag, storedId: match.id };
    }
    return { ...d, tag: nextTag++, storedId: undefined as string | undefined };
  });

  // A policy may force traffic through a named direction. Tags are resolved
  // just above, so this is the first moment the check can be made — and it has
  // to be made HERE rather than left to render time: an unresolvable tag is
  // silently dropped when the fragments are built, so the operator would save a
  // rule, see it accepted, and never learn that it does nothing. Refuse the save
  // instead, naming the tag and what does exist.
  const liveTags = new Set(resolved.map((d) => d.tag));
  for (const p of positions) {
    for (const [nodeId, policy] of Object.entries(p.egressPolicies ?? {})) {
      for (const rule of policy) {
        if (rule.target !== 'direction') continue;
        if (rule.directionTag === undefined || !liveTags.has(rule.directionTag)) {
          throw new CascadeValidationError(
            `geo split on node ${nodeId} forces direction ${rule.directionTag ?? '(none)'}, ` +
              `which this cascade does not have (${
                liveTags.size ? `available: ${[...liveTags].sort((a, b) => a - b).join(', ')}` : 'none'
              })`,
          );
        }
      }
    }
  }

  // Read the legs BEFORE dropping them: a leg that survives this save keeps its
  // credentials. Rebuilding the rows is how the topology is written (they are
  // interdependent), but re-MINTING what a live link authenticates with is a
  // different thing, and it was happening on every save - a rename rotated the
  // uuid, the REALITY keypair and the shortId of every leg, measured against
  // the live panel with a byte-identical topology. Each hop then gets the new
  // secret in its own push, so the chain is down between them, and a hop whose
  // push fails is cut off with nothing saying so. The push path had this right
  // already ("regenerating uuids/ports per push would tear down every live
  // link"); the save path is where it was missing.
  const previousLinks: StoredLink[] = (
    await tx.cascadeLink.findMany({
      where: { cascadeId },
      select: { fromNodeId: true, toNodeId: true, directionTag: true, config: true },
    })
  ).flatMap((l) => {
    const cred = parseLinkCred(l.config);
    return cred
      ? [{ fromNodeId: l.fromNodeId, toNodeId: l.toNodeId, directionTag: l.directionTag, cred }]
      : [];
  });

  await tx.cascadeLink.deleteMany({ where: { cascadeId } });
  await tx.cascadePosition.deleteMany({ where: { cascadeId } });
  // Directions are NOT dropped and rebuilt with the rest. Everything else here
  // is plumbing whose identity nobody outside this function holds; a direction's
  // id is the handle the panel and any deploy script use to say WHICH way out
  // they mean, and re-minting it on every save made that handle a lie the moment
  // it was read. What survives is only what was matched above: a stored row the
  // payload no longer names still goes, and its tag goes with it.
  const claimed = new Set(resolved.flatMap((d) => (d.storedId ? [d.storedId] : [])));
  await tx.cascadeDirection.deleteMany({
    where: { cascadeId, id: { notIn: [...claimed] } },
  });

  for (const p of positions) {
    await tx.cascadePosition.create({
      data: {
        cascadeId,
        position: p.position,
        entryProtocol: p.entryProtocol ?? null,
        linkProtocol: p.linkProtocol ?? null,
        nodes: {
          create: p.nodeIds.map((nodeId) => {
            const policy = p.egressPolicies?.[nodeId];
            // Omit the field entirely when there is no split, so the column stays
            // NULL and the member renders byte-identically to a plain one.
            return policy && policy.length > 0
              ? { nodeId, egressPolicy: policy as unknown as Prisma.InputJsonValue }
              : { nodeId };
          }),
        },
      },
    });
  }
  for (const d of resolved) {
    if (d.storedId) {
      // The pool is replaced rather than diffed: membership is the whole content
      // of the join row, so a delete-and-create of the members is the same state
      // and one round trip fewer than working out which ones moved. The
      // DIRECTION row is what had to survive, and it does.
      await tx.cascadeDirectionNode.deleteMany({ where: { directionId: d.storedId } });
      await tx.cascadeDirection.update({
        where: { id: d.storedId },
        data: {
          countryCode: d.countryCode ?? null,
          nodes: { create: d.nodeIds.map((nodeId) => ({ nodeId })) },
        },
      });
      continue;
    }
    await tx.cascadeDirection.create({
      data: {
        cascadeId,
        tag: d.tag,
        countryCode: d.countryCode ?? null,
        nodes: { create: d.nodeIds.map((nodeId) => ({ nodeId })) },
      },
    });
  }

  const links = generateTopologyLinks(positions, resolved, previousLinks);
  if (links.length > 0) {
    await tx.cascadeLink.createMany({
      data: links.map((l) => ({
        cascadeId,
        fromNodeId: l.fromNodeId,
        toNodeId: l.toNodeId,
        directionTag: l.directionTag,
        protocol: l.protocol,
        config: serializeLinkCred(l.cred),
      })),
    });
  }

  // Advance the counter past every tag handed out. Never `max(tag) + 1`: a
  // direction deleted later must not pass its tag to the next one.
  if (nextTag !== cascade.nextDirectionTag) {
    await tx.cascade.update({ where: { id: cascadeId }, data: { nextDirectionTag: nextTag } });
  }
}

/** Reject an egress policy that references custom categories as bare geosite:/
 *  geoip: or an unknown geoip category, up front (see cascade.geo.stock). No-op
 *  for an absent/empty policy. Throws EgressCategoryError (-> 400). */
async function assertPolicyCategories(policy: EgressPolicy | undefined): Promise<void> {
  if (!policy || policy.length === 0) return;
  const names = (await getCategories()).map((c) => c.name);
  assertEgressCategories(policy, names);
}

/** Same check across every per-node policy in a v4 payload. The category list is
 *  read ONCE: it is the same for all of them, and a position pool can carry a
 *  policy per node. */
async function assertPositionPolicies(
  positions: { egressPolicies?: Record<string, EgressPolicy> }[] | undefined,
): Promise<void> {
  const all = (positions ?? []).flatMap((p) => Object.values(p.egressPolicies ?? {}));
  if (all.length === 0) return;
  const names = (await getCategories()).map((c) => c.name);
  for (const policy of all) assertEgressCategories(policy, names);
}

export async function createCascade(input: CreateCascadeInput): Promise<CascadeDto> {
  // The redesigned screens send positions + directions; storage still holds
  // single-node hops. Fold when that is what arrived, and let the fold decide
  // the mode from the shape rather than trusting a field the new UI no longer
  // has. See foldPositionsIntoHops for what cannot be folded and why.
  // The fold is now BEST-EFFORT. v4 accepts shapes the hop model cannot hold (a
  // pool on a step, transits combined with several directions), and the panel
  // offers them, so refusing here would block the very topologies the rewrite
  // exists for. When a shape does not fold we store v4 only; rendering already
  // prefers it, and hops stay behind purely as the rollback path for shapes
  // that still fit.
  const folded =
    input.positions && input.directions
      ? tryFoldPositions(input.positions, input.directions)
      : null;
  const mode = folded ? folded.mode : (input.mode ?? 'chain');
  const isBalancer = mode === 'balancer';
  // Validate the topology in the effective mode (balancer exits carry no
  // linkProtocol, which the chain rules would wrongly reject). Empty when the
  // shape is v4-only: there are no hops to write, and everything below that
  // touches them is skipped.
  const legacyInput = folded ? folded.hops : input.hops;
  const hops = legacyInput ? validateCascadeHops(legacyInput, mode) : [];
  // Node existence is checked against whatever shape actually arrived.
  const allNodeIds = legacyInput
    ? hops.map((h) => h.nodeId)
    : [
        ...new Set([
          ...(input.positions ?? []).flatMap((p) => p.nodeIds),
          ...(input.directions ?? []).flatMap((d) => d.nodeIds),
        ]),
      ];
  await assertNodesExist(allNodeIds);
  // T7: an enabled balancer entry serves vlessRoute-tagged exit configs; gate
  // it on the entry's xray version. Disabled cascades don't expand in subs.
  // A v4-only shape gates on its entry position instead.
  const entryNodeId = hops[0]?.nodeId ?? input.positions?.find((p) => p.position === 0)?.nodeIds[0];
  if (input.enabled && entryNodeId && (isBalancer || !folded)) {
    await assertBalancerEntrySupportsVlessRoute(entryNodeId);
  }
  await assertPositionPolicies(input.positions);
  // Pre-generate inter-hop link creds.
  //   chain:    one cred per link, stored on each non-exit (originating) hop.
  //   balancer: one cred per exit link (entry->exit), stored on each EXIT hop;
  //             every link uses the entry hop's linkProtocol (uniform DC-to-DC).
  const creds = generateLinkCreds(
    isBalancer
      ? hops.slice(1).map(() => normalizeLinkProtocol(hops[0]!.linkProtocol))
      : hops.slice(0, hops.length - 1).map((h) => normalizeLinkProtocol(h.linkProtocol)),
  );
  // Cred index for hop `idx`, or -1 if it carries no link cred.
  const credIdx = (idx: number): number =>
    isBalancer ? (idx >= 1 ? idx - 1 : -1) : idx < hops.length - 1 ? idx : -1;
  // v4 topology, validated separately from the fold: the fold answers "can the
  // old storage hold this", these rules answer "is this a sane cascade at all".
  const topology =
    input.positions && input.directions
      ? validateCascadeTopology(input.positions, input.directions)
      : null;
  try {
    const c = await prisma.$transaction(async (tx) => {
      const created = await tx.cascade.create({
        data: {
          name: input.name,
          enabled: input.enabled,
          mode,
          hideHopsFromSub: input.hideHopsFromSub,
          autoProfile: input.autoProfile,
          hops: {
            create: hops.map((h, idx) => ({
              // Nested create uses the checked input -> connect the relation
              // rather than setting the raw nodeId scalar.
              node: { connect: { id: h.nodeId } },
              position: h.position,
              entryProtocol: h.entryProtocol ?? null,
              linkProtocol: h.linkProtocol ?? null,
              // Fresh object literal so it's assignable to Prisma's Json input
              // (a typed LinkCred lacks the index signature Json requires).
              ...(credIdx(idx) >= 0
                ? { linkConfig: serializeLinkCred(creds[credIdx(idx)]!) }
                : {}),
            })),
          },
        },
        include: hopInclude,
      });
      if (topology) {
        await writeTopologyV4(tx, created.id, topology.positions, topology.directions);
      }
      // Re-read, the way updateCascade does. `created` was captured BEFORE the
      // topology write, so returning it answers the create with `positions: []`,
      // `directions: []` and a stale `nextDirectionTag` - a body that disagrees
      // with a GET of the same cascade issued a millisecond later. Measured
      // 2026-08-28 against the running panel: POST said `directions: []` and
      // `nextDirectionTag: 1` where the GET said one direction with `tag: 1` and
      // `nextDirectionTag: 2`.
      //
      // The tag is the part that matters. It is minted here and nowhere else,
      // it travels inside the user's UUID, and squad ACL cuts access by it - so
      // the create response was hiding the one value a client could not compute
      // for itself. There is no extra round trip in the common case either:
      // without a v4 topology `created` is already current.
      return topology
        ? tx.cascade.findUniqueOrThrow({ where: { id: created.id }, include: hopInclude })
        : created;
    });
    // Push the chaining fragments to every hop now, not on some later unrelated
    // edit. inbounds.events re-syncs each node's inbound set, where
    // getCascadeFragmentsForNode injects the link-in/out + routing.
    emitCascadeChanged(c.id, allNodeIds, 'create');
    invalidateHiddenCascadeNodeCache();
    return mapCascade(c);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new CascadeNameTakenError(input.name);
    }
    throw err;
  }
}

/**
 * Every node a cascade touches, whichever shape it is stored in.
 *
 * A cascade lives in two storages at once: the legacy `hops` chain and the v4
 * `positions`/`directions` topology. The fold that keeps `hops` in step
 * deliberately refuses two v4 shapes it cannot express, and a pool on a
 * position is one of them, so a perfectly ordinary cascade can have ZERO hop
 * rows. Read the membership from hops alone and such a cascade reports no
 * members at all.
 *
 * That is not cosmetic: this list is who gets the config pushed to them. On
 * 2026-08-15 a live cascade with a two-node entry pool had `hops = 0`, so every
 * save emitted `cascade.changed` with an empty list, no node was ever told
 * anything, and the panel said "Saving pushes the config to all 5 nodes" while
 * pushing to none. The entry cores sat with a config their xray had already
 * rejected and no way to ever receive a fixed one.
 */
/**
 * Announce a cascade change to the nodes it touches.
 *
 * Pushing to nobody is a bug, never a success. The panel tells the operator
 * "saving pushes the config to all N nodes"; when the member list came out
 * empty it pushed to none and said nothing, which is how a cascade with a
 * pooled entry stayed broken for hours on 2026-08-15 while every save looked
 * like it worked. An empty list means the cascade is stored in a shape nobody
 * can read, so it goes in the log at error level with the cascade named.
 */
function emitCascadeChanged(cascadeId: string, nodeIds: string[], action: string): void {
  if (nodeIds.length === 0) {
    getLogger().error(
      { cascadeId, action },
      '[cascades] nothing to push: this cascade has no member nodes in either shape, ' +
        'so no node was told about the change',
    );
    return;
  }
  eventBus.emit('cascade.changed', { nodeIds });
}

export function cascadeMemberNodeIds(c: {
  hops?: { nodeId: string }[];
  positions?: { nodes: { nodeId: string }[] }[];
  directions?: { nodes: { nodeId: string }[] }[];
}): string[] {
  return [
    ...new Set([
      ...(c.hops ?? []).map((h) => h.nodeId),
      ...(c.positions ?? []).flatMap((p) => p.nodes.map((n) => n.nodeId)),
      ...(c.directions ?? []).flatMap((d) => d.nodes.map((n) => n.nodeId)),
    ]),
  ];
}

/**
 * The legs a hop-shaped cascade currently has, as (from, to, cred) triples.
 *
 * The stored cred lives on the ORIGINATING hop, and which hop that is depends
 * on the shape: a chain's hop i originates the leg to hop i+1, a balancer's
 * entry originates the leg to each exit. Reading it here rather than at the
 * call site keeps that pairing in one place.
 */
async function storedHopLinks(cascadeId: string, mode: string): Promise<StoredLink[]> {
  const rows = await prisma.cascadeHop.findMany({
    where: { cascadeId },
    select: { nodeId: true, position: true, linkConfig: true },
    orderBy: { position: 'asc' },
  });
  const out: StoredLink[] = [];
  for (let i = 0; i < rows.length; i++) {
    const cred = parseLinkCred(rows[i]!.linkConfig);
    if (!cred) continue;
    // Mirrors credIdx() in updateCascade, from the other side: a balancer keeps
    // the cred for leg (entry -> hop i) ON hop i, a chain keeps the cred for
    // leg (hop i -> hop i+1) on hop i.
    const from = mode === 'balancer' ? rows[0] : rows[i];
    const to = mode === 'balancer' ? rows[i] : rows[i + 1];
    if (!from || !to || from === to) continue;
    out.push({ fromNodeId: from.nodeId, toNodeId: to.nodeId, directionTag: 0, cred });
  }
  return out;
}

export async function updateCascade(id: string, input: UpdateCascadeInput): Promise<CascadeDto> {
  const existing = await prisma.cascade.findUnique({
    where: { id },
    select: {
      id: true,
      mode: true,
      enabled: true,
      hops: { select: { nodeId: true, position: true } },
      // Read the v4 side too, or a cascade with no hop rows looks memberless.
      positions: { select: { nodes: { select: { nodeId: true } } } },
      directions: { select: { nodes: { select: { nodeId: true } } } },
    },
  });
  if (!existing) throw new CascadeNotFoundError(id);
  // Capture the pre-update members: a node dropped from the cascade (or a
  // disable toggle) must also re-push so its now-stale fragments are removed.
  const oldNodeIds = cascadeMemberNodeIds(existing);

  // Same fold as create. A v4 payload also decides the mode, since the shape
  // now says it: one direction is a chain, several are a balancer.
  // Best-effort, same as create: a v4-only shape saves without hops.
  const folded =
    input.positions && input.directions
      ? tryFoldPositions(input.positions, input.directions)
      : null;
  const mode = (folded?.mode ?? input.mode ?? existing.mode) as 'chain' | 'balancer';
  const isBalancer = mode === 'balancer';
  const incomingHops = folded ? folded.hops : input.hops;
  const hops = incomingHops ? validateCascadeHops(incomingHops, mode) : null;
  await assertPositionPolicies(input.positions);
  if (hops) await assertNodesExist(hops.map((h) => h.nodeId));
  // T7: gate an effectively-enabled balancer on the entry node's xray version
  // (covers both enabling an existing cascade and swapping in a new entry hop).
  const willBeEnabled = input.enabled ?? existing.enabled;
  if (isBalancer && willBeEnabled) {
    const entryNodeId = hops
      ? hops[0]!.nodeId
      : existing.hops.find((h) => h.position === 0)?.nodeId;
    if (entryNodeId) await assertBalancerEntrySupportsVlessRoute(entryNodeId);
  }
  // Same reasoning as writeTopologyV4: a leg that survives the save keeps its
  // credentials. The legacy shapes have no directions, so a leg is just its two
  // ends (tag 0), and both shapes agree on which pair each cred belongs to -
  // a chain links hop i to hop i+1, a balancer links the entry to each exit.
  const previousHopLinks: StoredLink[] = hops ? await storedHopLinks(id, existing.mode) : [];
  const legs = hops
    ? (isBalancer
        ? hops.slice(1).map((h) => ({ fromNodeId: hops[0]!.nodeId, toNodeId: h.nodeId }))
        : hops.slice(0, hops.length - 1).map((h, i) => ({
            fromNodeId: h.nodeId,
            toNodeId: hops[i + 1]!.nodeId,
          })))
    : [];
  const creds = hops
    ? generateLinkCreds(
        isBalancer
          ? hops.slice(1).map(() => normalizeLinkProtocol(hops[0]!.linkProtocol))
          : hops.slice(0, hops.length - 1).map((h) => normalizeLinkProtocol(h.linkProtocol)),
        legs,
        previousHopLinks,
      )
    : [];
  // Cred index for hop `idx` (of `n` total), or -1 if it carries no link cred.
  const credIdx = (idx: number, n: number): number =>
    isBalancer ? (idx >= 1 ? idx - 1 : -1) : idx < n - 1 ? idx : -1;

  try {
    const c = await prisma.$transaction(async (tx) => {
      await tx.cascade.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          ...(input.mode !== undefined ? { mode: input.mode } : {}),
          ...(input.hideHopsFromSub !== undefined
            ? { hideHopsFromSub: input.hideHopsFromSub }
            : {}),
          ...(input.autoProfile !== undefined ? { autoProfile: input.autoProfile } : {}),
        },
      });
      if (!hops && input.positions && input.directions) {
        // v4-only shape replacing a foldable one: the stale hop rows would
        // otherwise keep describing a topology that no longer exists.
        await tx.cascadeHop.deleteMany({ where: { cascadeId: id } });
      }
      if (hops) {
        // Hops are interdependent (positions/protocols), so replace the whole
        // set rather than diffing.
        await tx.cascadeHop.deleteMany({ where: { cascadeId: id } });
        await tx.cascadeHop.createMany({
          // createMany uses the unchecked input, so the raw nodeId scalar is
          // correct here (no relation connect).
          data: hops.map((h, idx) => ({
            cascadeId: id,
            nodeId: h.nodeId,
            position: h.position,
            entryProtocol: h.entryProtocol ?? null,
            linkProtocol: h.linkProtocol ?? null,
            ...(credIdx(idx, hops.length) >= 0
              ? { linkConfig: serializeLinkCred(creds[credIdx(idx, hops.length)]!) }
              : {}),
          })),
        });
      }
      // Shadow-write the v4 topology alongside the hops. Only when the payload
      // actually carried one: an enabled-only toggle must not wipe positions.
      if (input.positions && input.directions) {
        const topology = validateCascadeTopology(input.positions, input.directions);
        await writeTopologyV4(tx, id, topology.positions, topology.directions);
      }
      return tx.cascade.findUniqueOrThrow({ where: { id }, include: hopInclude });
    });
    // Re-push old + new members (deduped): old-only nodes drop their fragments,
    // new/kept nodes get the refreshed chain. An enabled-only toggle carries
    // neither shape, so newNodeIds is empty and we re-push the existing members.
    //
    // Both shapes are read, because either can be the only one present: a v4
    // payload whose entry carries a pool writes no hops at all.
    const newNodeIds = [
      ...(hops ?? []).map((h) => h.nodeId),
      ...(input.positions ?? []).flatMap((p) => p.nodeIds),
      ...(input.directions ?? []).flatMap((d) => d.nodeIds),
    ];
    emitCascadeChanged(id, [...new Set([...oldNodeIds, ...newNodeIds])], 'update');
    invalidateHiddenCascadeNodeCache();
    return mapCascade(c);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new CascadeNameTakenError(input.name ?? '');
    }
    throw err;
  }
}

/**
 * C3 - resolve the xray cascade fragments (link-in inbound, link-out outbound,
 * routing rules) for a node's hop, or null if the node is not part of any
 * enabled cascade. The inbound-sync push injects the result into the node's
 * XrayInboundCfg so the node-agent can chain entry->exit.
 *
 * Link creds are read from each originating hop's persisted linkConfig
 * (generated once at cascade create/update) so the chain stays stable across
 * pushes - regenerating uuids/ports per push would tear down every live link.
 *
 * The `direct` (freedom) outbound that buildCascadeConfigs emits is dropped
 * here: the node's base xray config already ships a `direct` outbound, and two
 * outbounds sharing a tag make xray reject the whole config.
 */
/**
 * The wire shape a node receives, from a built hop config. Every path goes
 * through here.
 *
 * It exists because the three paths (v4 topology, legacy balancer, legacy
 * chain) each hand-copied the same field list, and the v4 one copied all of
 * them except `observatory`. A node then got a `leastPing` balancer with nobody
 * to measure the pings, and xray answers that by refusing the ENTIRE config
 * with "not all dependencies are resolved": no inbound, no cascade, core never
 * starts. The entry of a live cascade sat dead for hours behind a green node
 * card (2026-08-15).
 *
 * What makes it worth a helper rather than a fixed line: the builder was
 * correct and its config-validity test passed, because that test feeds xray the
 * BUILDER's output. The field was lost afterwards, in the copy. A shared mapper
 * is the only version of this that a future field cannot fall out of.
 */
export function toWireFragments(mine: HopConfig): XrayCascadeFragments {
  return {
    inbounds: mine.inbounds,
    // The node ships its own `direct` outbound; two with one tag make xray
    // reject the whole config.
    outbounds: mine.outbounds.filter((o) => o.tag !== 'direct'),
    routingRules: mine.routingRules,
    // Carry the link port + peer address so the node-agent can open UFW for the
    // inter-hop link itself (was a manual `ufw allow from <entry-ip>` step).
    linkIngressPort: mine.linkIngressPort,
    linkAllowFrom: mine.linkAllowFrom,
    // These two travel together or not at all: a balancer without its
    // observatory is a config xray rejects outright.
    balancers: mine.balancers,
    observatory: mine.observatory,
    // E - IPOnDemand for a node whose split matches on ip/geoip; absent keeps
    // the node's default, so a member without a split is unchanged.
    domainStrategy: mine.domainStrategy,
  };
}

export async function getCascadeFragmentsForNode(
  nodeId: string,
): Promise<XrayCascadeFragments | null> {
  // v4 first. Falls through to the hop path for cascades written before the
  // topology tables existed, so a half-migrated fleet keeps serving.
  const v4 = await getTopologyFragmentsForNode(nodeId);
  if (v4) return v4;

  // A node belongs to at most one cascade in the v1 model; first enabled match.
  const member = await prisma.cascadeHop.findFirst({
    where: { nodeId, cascade: { enabled: true } },
    select: { cascadeId: true },
  });
  if (!member) return null;

  const cascade = await prisma.cascade.findUnique({
    where: { id: member.cascadeId },
    include: {
      hops: {
        orderBy: { position: 'asc' },
        include: { node: { select: { id: true, address: true } } },
      },
    },
  });
  // A single-hop "cascade" has no links to build - treat as not-a-cascade.
  if (!cascade || cascade.hops.length < 2) return null;

  const hopInputs: CascadeConfigHopInput[] = cascade.hops.map((h) => ({
    nodeId: h.nodeId,
    position: h.position,
    // Public host the previous hop dials. node.address is host[:agentPort];
    // the link binds its own port (cred.port), so strip any agent port.
    nodeHost: h.node.address.split(':')[0]!,
  }));

  // A4 ad-split: emit EVERY defined policy's rules on the entry (policies are
  // global). The per-squad grant only gates which profiles the subscription
  // hands out; the node carries all so any granted tag resolves. Plain
  // (ordinal 0) is implicit in the builders.
  //
  // Read once for BOTH shapes. Until 2026-07-30 this lived inside the balancer
  // branch only, which is half of why ad-split silently did nothing on chains.
  const policies: CascadePolicy[] = (
    await prisma.routePolicy.findMany({
      select: { ordinal: true, directDomains: true, blockDomains: true },
    })
  ).map((p) => ({
    ordinal: p.ordinal,
    directDomains: p.directDomains,
    blockDomains: p.blockDomains,
  }));

  // C3-auto: a `balancer` cascade fans one entry out to N parallel exits. The
  // link creds live on the EXIT hops (hops[1..]); the entry dials each. The
  // entry's fragments carry the observatory + balancer; each exit terminates its
  // own link. The `direct` outbound is dropped (the node ships its own).
  if (cascade.mode === 'balancer') {
    const exitCreds: LinkCred[] = [];
    for (const eh of cascade.hops.slice(1)) {
      const cred = parseLinkCred(eh.linkConfig);
      // Malformed/missing cred (data drift): ship nothing rather than a
      // half-wired auto node that blackholes user traffic.
      if (!cred) return null;
      exitCreds.push(cred);
    }
    const configs = buildBalancerCascadeConfigs(
      hopInputs[0]!,
      hopInputs.slice(1),
      exitCreds,
      policies,
    );
    const mine = configs.find((c) => c.nodeId === nodeId);
    if (!mine) return null;
    return toWireFragments(mine);
  }

  // Rebuild link creds from each originating hop's persisted linkConfig.
  // Hops are position-sorted; hops[0..n-2] each carry one linkConfig.
  const linkCreds: LinkCred[] = [];
  for (let i = 0; i < cascade.hops.length - 1; i++) {
    const cred = parseLinkCred(cascade.hops[i]!.linkConfig);
    if (!cred) {
      // Malformed/missing cred (data drift) - safer to ship no cascade than a
      // half-wired chain that silently blackholes user traffic.
      return null;
    }
    linkCreds.push(cred);
  }

  const configs = buildCascadeConfigs(hopInputs, linkCreds, policies);
  const mine = configs.find((c) => c.nodeId === nodeId);
  if (!mine) return null;

  return toWireFragments(mine);
}

/**
 * v4 fragment resolution: read the topology tables and let the shape-agnostic
 * builder do the work. Returns null when this node has no v4 links, which is
 * both "not in a cascade" and "this cascade predates the topology tables" - the
 * caller then falls back to the hop path.
 */
async function getTopologyFragmentsForNode(
  nodeId: string,
): Promise<XrayCascadeFragments | null> {
  const link = await prisma.cascadeLink.findFirst({
    where: {
      cascade: { enabled: true },
      OR: [{ fromNodeId: nodeId }, { toNodeId: nodeId }],
    },
    select: { cascadeId: true },
  });
  if (!link) return null;

  const [cascadeRow, positions, directions, links, policyRows] = await Promise.all([
    prisma.cascade.findUnique({
      where: { id: link.cascadeId },
      select: { autoProfile: true },
    }),
    prisma.cascadePosition.findMany({
      where: { cascadeId: link.cascadeId },
      orderBy: { position: 'asc' },
      select: { position: true, nodes: { select: { nodeId: true, egressPolicy: true } } },
    }),
    prisma.cascadeDirection.findMany({
      where: { cascadeId: link.cascadeId },
      orderBy: { tag: 'asc' },
      select: { tag: true, nodes: { select: { nodeId: true } } },
    }),
    prisma.cascadeLink.findMany({
      where: { cascadeId: link.cascadeId },
      select: { fromNodeId: true, toNodeId: true, directionTag: true, config: true },
    }),
    prisma.routePolicy.findMany({
      select: { ordinal: true, directDomains: true, blockDomains: true },
    }),
  ]);

  // Public host per node, for dialling and for the firewall allow-list. The
  // stored address is host[:agentPort]; the link binds its own port.
  const nodeIds = new Set<string>();
  for (const l of links) {
    nodeIds.add(l.fromNodeId);
    nodeIds.add(l.toNodeId);
  }
  const nodeRows = await prisma.node.findMany({
    where: { id: { in: [...nodeIds] } },
    select: { id: true, address: true },
  });
  const hosts = new Map(nodeRows.map((n) => [n.id, n.address.split(':')[0]!]));

  const rows: TopologyLinkRow[] = [];
  for (const l of links) {
    const cred = parseLinkCred(l.config);
    // Malformed cred (data drift): ship nothing rather than a half-wired path
    // that blackholes user traffic.
    if (!cred) return null;
    rows.push({
      fromNodeId: l.fromNodeId,
      toNodeId: l.toNodeId,
      directionTag: l.directionTag,
      cred,
    });
  }

  // E - per-node geo split, reconciled against the current build: an ext: rule
  // whose .dat the node cannot get is stripped here rather than shipped, because
  // xray fails config load on a missing ext file and crash-loops.
  const { policies: egressPolicies, assetsByNode } = resolveCascadeGeo(
    positions.flatMap((p) => p.nodes),
  );

  const mine = buildTopologyFragmentsForNode(nodeId, {
    positions: positions.map((p) => ({
      position: p.position,
      nodeIds: p.nodes.map((n) => n.nodeId),
    })),
    egressPolicies,
    directions: directions.map((d) => ({ tag: d.tag, nodeIds: d.nodes.map((n) => n.nodeId) })),
    links: rows,
    hosts,
    policies: policyRows.map((p) => ({
      ordinal: p.ordinal,
      directDomains: p.directDomains,
      blockDomains: p.blockDomains,
    })),
    // The node has to know before the subscription hands the tag out: an Auto
    // profile whose rule is missing at the entry egresses from the entry
    // country instead of failing, which is the one outcome worth preventing.
    auto: cascadeRow?.autoProfile ?? false,
  });
  if (!mine) return null;

  // Assets for THIS node: the files its own policy still references after
  // reconciliation. Absent when it has no split, so the fragment stays
  // byte-identical to a plain cascade member.
  const geoAssets = assetsByNode.get(nodeId);
  return { ...toWireFragments(mine), ...(geoAssets ? { geoAssets } : {}) };
}

export async function deleteCascade(id: string): Promise<void> {
  // Grab the member nodes before deleting so we can re-push them afterwards to
  // strip the cascade fragments from their live xray config. Both shapes: a
  // v4-only cascade has no hop rows, and reading hops alone would leave its
  // nodes serving a cascade that no longer exists.
  const existing = await prisma.cascade.findUnique({
    where: { id },
    select: {
      hops: { select: { nodeId: true } },
      positions: { select: { nodes: { select: { nodeId: true } } } },
      directions: { select: { nodes: { select: { nodeId: true } } } },
    },
  });
  try {
    await prisma.cascade.delete({ where: { id } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      throw new CascadeNotFoundError(id);
    }
    throw err;
  }
  const members = existing ? cascadeMemberNodeIds(existing) : [];
  emitCascadeChanged(id, members, 'delete');
  invalidateHiddenCascadeNodeCache();
}
