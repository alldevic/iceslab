import type { XrayCascadeFragments } from '@iceslab/shared';
import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../prisma.js';
import { eventBus } from '../../lib/event-bus.js';
import { validateCascadeHops } from './cascade.validation.js';
import {
  buildCascadeConfigs,
  buildBalancerCascadeConfigs,
  generateLinkCreds,
  normalizeLinkProtocol,
  parseLinkCred,
  routeTag,
  serializeLinkCred,
  type CascadeConfigHopInput,
  type CascadePolicy,
  type LinkCred,
} from './cascade.config.js';
import type { CreateCascadeInput, UpdateCascadeInput } from './cascade.schemas.js';
import { mapCascade, type CascadeDto } from './cascade.mapper.js';

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
  const hops = await prisma.cascadeHop.findMany({
    where: { cascade: { enabled: true, hideHopsFromSub: true } },
    select: { nodeId: true, position: true },
  });
  const entry = new Set<string>();
  const nonEntry = new Set<string>();
  for (const h of hops) {
    if (h.position === 0) entry.add(h.nodeId);
    else nonEntry.add(h.nodeId);
  }
  for (const id of entry) nonEntry.delete(id);
  hiddenNodesCache = { value: nonEntry, expiresAt: Date.now() + HIDDEN_NODES_TTL_MS };
  return nonEntry;
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
): Promise<Map<string, { label: string; tag: number }[]>> {
  const out = new Map<string, { label: string; tag: number }[]>();
  if (nodeIds.length === 0) return out;
  const cascades = await prisma.cascade.findMany({
    where: {
      enabled: true,
      hops: { some: { nodeId: { in: nodeIds }, position: 0 } },
    },
    include: {
      hops: {
        orderBy: { position: 'asc' },
        include: { node: { select: { id: true, name: true } } },
      },
    },
  });
  if (cascades.length === 0) return out;

  // A4 increment 2: per-squad exit allow-list. Union the user's allow rows per
  // cascade. OPT-IN restriction: a cascade absent from this map is unrestricted
  // (no rows => all exits); present => keep only the allowed exit nodes.
  const allowByCascade = new Map<string, Set<string>>();
  // A4 ad-split: policies GRANTED to the user's squads (opt-in grant). The plain
  // profile (ordinal 0) is always available and synthesized below; these are the
  // extra ad-split policies, deduped by ordinal across squads.
  const grantedPolicies: { ordinal: number; name: string }[] = [];
  if (groupIds.length > 0) {
    const [exitRows, grants] = await Promise.all([
      prisma.groupCascadeExit.findMany({
        where: { groupId: { in: groupIds }, cascadeId: { in: cascades.map((c) => c.id) } },
        select: { cascadeId: true, exitNodeId: true },
      }),
      prisma.groupRoutePolicy.findMany({
        where: { groupId: { in: groupIds } },
        select: { policy: { select: { ordinal: true, name: true } } },
      }),
    ]);
    for (const r of exitRows) {
      let set = allowByCascade.get(r.cascadeId);
      if (!set) {
        set = new Set();
        allowByCascade.set(r.cascadeId, set);
      }
      set.add(r.exitNodeId);
    }
    const seenOrdinal = new Set<number>();
    for (const g of grants) {
      if (!seenOrdinal.has(g.policy.ordinal)) {
        seenOrdinal.add(g.policy.ordinal);
        grantedPolicies.push(g.policy);
      }
    }
  }

  for (const c of cascades) {
    const entry = c.hops.find((h) => h.position === 0);
    if (!entry || !nodeIds.includes(entry.nodeId)) continue;
    const isBalancer = c.mode === 'balancer';
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
    const fullExits = exitHops.map((h, i) => ({ name: h.node.name, index: i, nodeId: h.node.id }));
    const exits = applyExitAcl(fullExits, allowByCascade.get(c.id));
    if (exits.length === 0) continue;
    // Cartesian: each exit x (plain + granted policies). Plain first per exit so
    // the client list reads CH, CH-no-ads, TR, TR-no-ads.
    const profiles: { label: string; tag: number }[] = [];
    for (const ex of exits) {
      profiles.push({ label: ex.name, tag: routeTag(0, ex.index) });
      for (const p of grantedPolicies) {
        profiles.push({ label: `${ex.name} · ${p.name}`, tag: routeTag(p.ordinal, ex.index) });
      }
    }
    out.set(entry.nodeId, profiles);
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

export async function createCascade(input: CreateCascadeInput): Promise<CascadeDto> {
  const mode = input.mode ?? 'chain';
  const isBalancer = mode === 'balancer';
  // Validate the topology in the effective mode (balancer exits carry no
  // linkProtocol, which the chain rules would wrongly reject).
  const hops = validateCascadeHops(input.hops, mode);
  await assertNodesExist(hops.map((h) => h.nodeId));
  // T7: an enabled balancer entry serves vlessRoute-tagged exit configs; gate
  // it on the entry's xray version. Disabled cascades don't expand in subs.
  if (isBalancer && input.enabled) {
    await assertBalancerEntrySupportsVlessRoute(hops[0]!.nodeId);
  }
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
  try {
    const c = await prisma.cascade.create({
      data: {
        name: input.name,
        enabled: input.enabled,
        mode,
        hideHopsFromSub: input.hideHopsFromSub,
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
    // Push the chaining fragments to every hop now, not on some later unrelated
    // edit. inbounds.events re-syncs each node's inbound set, where
    // getCascadeFragmentsForNode injects the link-in/out + routing.
    eventBus.emit('cascade.changed', { nodeIds: hops.map((h) => h.nodeId) });
    invalidateHiddenCascadeNodeCache();
    return mapCascade(c);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new CascadeNameTakenError(input.name);
    }
    throw err;
  }
}

export async function updateCascade(id: string, input: UpdateCascadeInput): Promise<CascadeDto> {
  const existing = await prisma.cascade.findUnique({
    where: { id },
    select: {
      id: true,
      mode: true,
      enabled: true,
      hops: { select: { nodeId: true, position: true } },
    },
  });
  if (!existing) throw new CascadeNotFoundError(id);
  // Capture the pre-update hop nodes: a node dropped from the cascade (or a
  // disable toggle) must also re-push so its now-stale fragments are removed.
  const oldNodeIds = existing.hops.map((h) => h.nodeId);

  // Effective mode: an explicit input.mode wins, else keep the stored one.
  const mode = (input.mode ?? existing.mode) as 'chain' | 'balancer';
  const isBalancer = mode === 'balancer';
  const hops = input.hops ? validateCascadeHops(input.hops, mode) : null;
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
  const creds = hops
    ? generateLinkCreds(
        isBalancer
          ? hops.slice(1).map(() => normalizeLinkProtocol(hops[0]!.linkProtocol))
          : hops.slice(0, hops.length - 1).map((h) => normalizeLinkProtocol(h.linkProtocol)),
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
        },
      });
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
      return tx.cascade.findUniqueOrThrow({ where: { id }, include: hopInclude });
    });
    // Re-push old + new hops (deduped): old-only nodes drop their fragments,
    // new/kept nodes get the refreshed chain. An enabled-only toggle has no
    // `hops` input, so newNodeIds is empty and we re-push the existing hops.
    const newNodeIds = hops ? hops.map((h) => h.nodeId) : [];
    eventBus.emit('cascade.changed', { nodeIds: [...new Set([...oldNodeIds, ...newNodeIds])] });
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
export async function getCascadeFragmentsForNode(
  nodeId: string,
): Promise<XrayCascadeFragments | null> {
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
    return {
      inbounds: mine.inbounds,
      outbounds: mine.outbounds.filter((o) => o.tag !== 'direct'),
      routingRules: mine.routingRules,
      linkIngressPort: mine.linkIngressPort,
      linkAllowFrom: mine.linkAllowFrom,
      observatory: mine.observatory,
      balancers: mine.balancers,
    };
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

  return {
    inbounds: mine.inbounds,
    outbounds: mine.outbounds.filter((o) => o.tag !== 'direct'),
    routingRules: mine.routingRules,
    // Carry the link port + peer address so the node-agent can open UFW for the
    // inter-hop link itself (was a manual `ufw allow from <entry-ip>` step).
    linkIngressPort: mine.linkIngressPort,
    linkAllowFrom: mine.linkAllowFrom,
  };
}

export async function deleteCascade(id: string): Promise<void> {
  // Grab the hop nodes before deleting so we can re-push them afterwards to
  // strip the cascade fragments from their live xray config.
  const existing = await prisma.cascade.findUnique({
    where: { id },
    select: { hops: { select: { nodeId: true } } },
  });
  try {
    await prisma.cascade.delete({ where: { id } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      throw new CascadeNotFoundError(id);
    }
    throw err;
  }
  if (existing && existing.hops.length > 0) {
    eventBus.emit('cascade.changed', { nodeIds: existing.hops.map((h) => h.nodeId) });
  }
  invalidateHiddenCascadeNodeCache();
}
