import { Queue, Worker, type Job } from 'bullmq';
import type {
  AddUserRequest,
  ApplyInboundsRequest,
  DnsCfg,
  InboundDto,
  ProtocolName,
  XrayCascadeFragments,
} from '@iceslab/shared';
import { redis } from '../../lib/infra/redis.js';
import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../prisma.js';
import { mtprotoSecret } from '../../core-adapters/mtproto/index.js';
import { NodeTransport, NodeRequestError } from '../nodes/nodes.transport.js';
import { inboundSyncJobs } from '../../lib/infra/metrics.js';
import { allocateAwgAddresses } from '../amneziawg/awg-addresses.js';
import { reachOfUsers } from '../users/user-reach.js';
import { getCascadeFragmentsForNode, getChainForNode, giveCascadeLegsReality } from '../cascades/cascade.service.js';
import { resolvePolicyForNode } from '../node-policies/node-policies.service.js';
import { cascadeXrayDrawingOf, type CascadeXrayDrawing } from '../cascades/cascade.config.js';
import { layOutGeo } from '../geo-sets/geo-push.js';
import { deriveTuicPassword, deriveAnytlsPassword, deriveShadowtlsPassword } from '../../lib/auth/credentials.js';
import { getLogger } from '../../lib/infra/logger.js';
import { acmeHostnameFor } from './acme-hostname.js';
import { checkRenderDrift, recordPushed } from './render-drift.js';
import { ensureHysteriaTls } from '../nodes/hysteria-tls.js';
import { ensureAwg3Geometry } from '../nodes/awg3-geometry.js';
import { pushedBindingsWhere } from '../nodes/pushed-bindings.js';

// Moved to its own module (E30) so the install command reads the address the
// same way; re-exported for the callers that import it from here.
export { acmeHostnameFor };

// ───── Job data shapes ─────

export interface ApplyNodeInboundsJobData {
  /** Which node's inbound set to recompute and push. */
  nodeId: string;
}

// ───── Queue ─────

const QUEUE_NAME = 'inbound-sync';

/**
 * A-162: every push is asked for HERE, and asking bumps the node's revision.
 *
 * BullMQ drops an add whose jobId is still active, so an edit landing during
 * the 5-30 s of a push of the same node used to vanish. A Redis "dirty" flag
 * was meant to catch that, and did not: the re-queue ran inside the job,
 * where the jobId was still active, so it was dropped too, after the flag had
 * been eaten; a node with no hosts returned before the check; a last failed
 * attempt never got there. And the status then compared the acknowledgement
 * time with updatedAt maxima, so the lost edit read as applied.
 *
 * Now the intent lives in the database as nodes.desired_revision. The job
 * reads it at the start of building the request and acknowledges exactly
 * that revision (applied_revision). When the job ends, completed or out of
 * attempts, and the revision moved meanwhile, it is queued again from the
 * worker's event, where the old job no longer holds the jobId.
 */
export async function enqueueNodePush(nodeId: string): Promise<void> {
  // The panel's clock, not the database's now(): lastInboundSyncAt beside it
  // is stamped by the panel too, and the node card puts the two side by side.
  // A Postgres in a VM can run seconds off the host (seen locally 22.10, a
  // test reading "changed after it was applied").
  await prisma.$executeRaw`
    UPDATE nodes SET desired_revision = desired_revision + 1, config_changed_at = ${new Date()}
    WHERE id = ${nodeId}::uuid`;
  await inboundSyncQueue.add('applyNodeInbounds', { nodeId }, { jobId: `apply-${nodeId}` });
}

/** The revision a push about to be built stands for. Null: no such node. */
export async function readDesiredRevision(nodeId: string): Promise<bigint | null> {
  const row = await prisma.node.findUnique({ where: { id: nodeId }, select: { desiredRevision: true } });
  return row?.desiredRevision ?? null;
}

export const inboundSyncQueue = new Queue<ApplyNodeInboundsJobData>(QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    // Two retries (exponential 1 s / 2 s). Inbound config push is idempotent
    // by design so retrying is always safe; we stop sooner than addUser
    // because applyInbounds restarts the protocol server and stacking
    // restarts on a flaky network is louder than stacking addUser noops.
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: true,
    // Coalescing uses `jobId: apply-<nodeId>` so duplicate enqueues collapse
    // into one push. BUT BullMQ's deduplication treats a failed job in the
    // failed-set as still "owning" the jobId, new enqueues become silent
    // no-ops until the failed job is reaped. With `age: 86400` that's a
    // 24-hour deadlock per node after a single transient failure (panel
    // rebuilds, network blips, mTLS hiccups during cert rotation).
    //
    // Fix: drop failed jobs immediately. Operators see retries via the
    // `[worker:inbound-sync] applyInbounds X FAILED: ...` getLogger().info
    // before the final retry; long-term failures will re-enqueue on the
    // next event (binding/profile change), which is the right behaviour.
    removeOnFail: true,
  },
});

// ───── Sync helper ─────

interface NodeRow {
  id: string;
  name: string;
  address: string;
  /** Э3 F: the resolver this node's users get; null = the host's own. */
  dns: unknown;
}

async function fetchNode(nodeId: string): Promise<NodeRow | null> {
  return prisma.node.findFirst({
    where: { id: nodeId, deletedAt: null, status: { not: 'disabled' } },
    select: { id: true, name: true, address: true, dns: true },
  });
}

interface ActiveUser {
  id: string;
  shortId: string;
  username: string;
  xrayUuid: string;
  hysteriaPassword: string;
  amneziawgPublicKey: string;
  naivePassword: string;
}

/**
 * Users a node should be able to serve right now.
 *
 * ⚠ `deletedAt: null` is load-bearing. Deletion is soft and leaves `status` as
 * `active`, so without it a deleted person is handed back to the node on the
 * next inbound change. Their subscription link is dead, but the credentials
 * their client already holds keep working - deletion would revoke access only
 * until the next config push, which is not what anyone means by deleting a user.
 *
 * Seen in the field 2026-08-10: adding an inbound on a node re-seeded 19 users
 * onto it while the panel had exactly one. The sibling backfill in
 * `users.queue.ts` had the filter; this one did not, and the two silently
 * disagreed about who exists.
 *
 * Exported for the test that pins this.
 */
export async function fetchActiveUsers(): Promise<ActiveUser[]> {
  const now = new Date();
  return prisma.user.findMany({
    where: {
      deletedAt: null,
      status: 'active',
      OR: [{ expireAt: null }, { expireAt: { gt: now } }],
    },
    select: {
      id: true,
      shortId: true,
      username: true,
      xrayUuid: true,
      hysteriaPassword: true,
      amneziawgPublicKey: true,
      naivePassword: true,
    },
  });
}

/**
 * The legacy cascade fragments as a push carries them (A-232): the node's
 * fragments, and only when it has an enabled xray inbound to carry them, which
 * is where the push puts them. A node in a cascade without one gets none, and
 * its xray draws no way out. ONE function for the push and for the read of the
 * drawing (cascadeXrayDrawingForNode), so the read cannot say "drawn" about a
 * node the push sends nothing to. `inbounds`: the push's own list; without it
 * the enabled bindings are asked, by the same filter fetchEnabledInbounds uses.
 */
export async function legacyCascadeAsPushed(
  nodeId: string,
  inbounds?: { protocol: string }[],
): Promise<XrayCascadeFragments | null> {
  const fragments = await getCascadeFragmentsForNode(nodeId);
  if (!fragments) return null;
  const hasXray = inbounds
    ? inbounds.some((i) => i.protocol === 'xray')
    : (await prisma.profileNodeBinding.count({
        where: { AND: [pushedBindingsWhere(nodeId), { profile: { protocol: 'xray' } }] },
      })) > 0;
  if (!hasXray) {
    getLogger().info(
      `[inbound-sync] node ${nodeId} is in an enabled cascade but has no xray inbound; cascade not applied`,
    );
    return null;
  }
  return fragments;
}

/**
 * A-232: the drawing a push gives this node's xray, read without pushing: the
 * push's inputs (its chain block and, without one, legacyCascadeAsPushed)
 * through the same cascadeXrayDrawingOf.
 */
export async function cascadeXrayDrawingForNode(nodeId: string): Promise<CascadeXrayDrawing> {
  const chain = await getChainForNode(nodeId);
  return cascadeXrayDrawingOf(chain, chain ? null : await legacyCascadeAsPushed(nodeId));
}

export async function fetchEnabledInbounds(nodeId: string): Promise<InboundDto[]> {
  // Slice 27: walks ProfileNodeBinding rows joined to Profile, and resolves
  // the deployable config for each. Replaces the old per-node `inbounds`
  // table read while keeping the wire format identical (the node-agent
  // doesn't know about profile/binding split, it just gets a flat list).
  const bindings = await prisma.profileNodeBinding.findMany({
    // The one filter of what a push sends, shared with the reports (A-204).
    where: pushedBindingsWhere(nodeId),
    include: {
      profile: {
        select: { id: true, name: true, protocol: true, engine: true, config: true, awgProtocol: true },
      },
    },
    // The id breaks a tie (443/TCP and 443/UDP): the push's order is part of
    // its drawing, which render-drift.ts compares (A-278).
    orderBy: [{ port: 'asc' }, { id: 'asc' }],
  });
  // t07-6: the node's 3.1 geometry, minted on the first push that needs it.
  const awg3Geometry = bindings.some((b) => b.profile.protocol === 'amneziawg' && b.profile.awgProtocol === 3)
    ? await ensureAwg3Geometry(nodeId)
    : null;

  const inbounds = bindings.map((b) => {
    // Shallow merge: per-binding overrides win over profile.config. Used for
    // ACME domain, AmneziaWG private key, Shadowsocks server PSK, etc.
    const baseConfig = (b.profile.config ?? {}) as Record<string, unknown>;
    const overrides = (b.overrides ?? {}) as Record<string, unknown>;
    let config = { ...baseConfig, ...overrides } as InboundDto['config'];

    // Slice 41: mtproto secret derived from (binding.id, domain). Both
    // the wire push (here) and subscription generator key on binding.id so
    // the secret stays in lock-step on both sides.
    if (b.profile.protocol === 'mtproto') {
      const cfg = config as { domain?: string };
      if (cfg && cfg.domain) {
        config = {
          ...cfg,
          secret: mtprotoSecret(b.id, cfg.domain),
        } as InboundDto['config'];
      }
    }

    // Multi-inbound: tell the agent WHICH inbound this config is, so it can
    // hold several at once instead of letting each push overwrite the last.
    // It travels inside the config because ApplyInbound is shared by all seven
    // core adapters, and widening that signature would touch every one of them
    // for the benefit of a single core.
    //
    // The binding id is the right identity here: it is what the panel already
    // keys everything else on (mtproto secrets above, subscription rendering),
    // and it lives as long as the inbound does. Traffic counters end up tagged
    // with it, so it must not be regenerated per push.
    if (b.profile.protocol === 'xray') {
      config = {
        ...(config as Record<string, unknown>),
        inboundId: b.id,
      } as InboundDto['config'];
    }

    // AmneziaWG: inject the binding-level port into the protocol config so
    // the agent binds the awg-quick interface to the port the admin set
    // (typical 443 for stealth) instead of WireGuard's default 51820.
    // Without this, the wgconf subscription advertises Endpoint=:443 but
    // the server actually listens on 51820, handshake never completes.
    // Caught live awg-VPS cycle #6 2026-05-12.
    if (b.profile.protocol === 'amneziawg') {
      config = {
        ...(config as Record<string, unknown>),
        listenPort: b.port,
        // t07-6: which binding, so the agent can take down the interface of
        // one the push stops carrying; and, for a 3.1 profile, the generation
        // and the node's geometry, which replace the profile's jc..h4 there.
        inboundId: b.id,
        ...(b.profile.awgProtocol === 3 && awg3Geometry ? { awgProtocol: 3, geometry3: awg3Geometry } : {}),
      } as InboundDto['config'];
    }

    return {
      id: b.id,
      name: b.profile.name,
      protocol: b.profile.protocol as ProtocolName,
      // Engine-choice (EC5): NULL profile.engine -> omit so the node resolves the
      // protocol's native core; 'singbox' routes to the sing-box adapter.
      engine: (b.profile.engine ?? undefined) as InboundDto['engine'],
      port: b.port,
      config,
    };
  });

  // Two per-NODE names get injected into per-profile configs below, so both read
  // the node row once.
  //
  // B3/G - REALITY self-steal: serverNames is a per-NODE property (must resolve
  // to THIS node's IP), not per-profile. For any xray inbound whose profile is in
  // self-steal mode, override serverNames with the node's own domain so SNI and IP
  // stay consistent (the node-agent serves a local TLS fallback for it; see
  // selfsteal.go). One self-steal profile can deploy to N nodes, each using its
  // own domain. If the node has no domain set, self-steal cannot work; surface it.
  const selfStealInbounds = inbounds.filter(
    (i) =>
      i.protocol === 'xray' &&
      (i.config as { realityMode?: string }).realityMode === 'self-steal',
  );
  const hysteriaInbounds = inbounds.filter((i) => i.protocol === 'hysteria');
  if (selfStealInbounds.length > 0 || hysteriaInbounds.length > 0) {
    const nodeRow = await prisma.node.findUnique({
      where: { id: nodeId },
      select: { domain: true, address: true },
    });

    // Hysteria ACME: the cert has to carry the name the CLIENT validates, and a
    // hysteria client sends the address it dialled as its SNI (buildHysteriaUri
    // sets sni from the host, and unlike xray it has no sniOverride path). The
    // node's own address is therefore the only name a cert can match, and
    // pushing it lets an admin move a node to a new domain from the panel
    // instead of re-onboarding it. Emphatically NOT node.domain: that is the
    // self-steal camouflage name, and issuing hysteria's cert for it would
    // leave every client validating a name the cert no longer covers.
    const acmeHostname = acmeHostnameFor(nodeRow?.address);
    if (acmeHostname) {
      for (const ib of hysteriaInbounds) {
        ib.config = {
          ...(ib.config as Record<string, unknown>),
          hostname: acmeHostname,
        } as InboundDto['config'];
      }
    } else {
      // E30a: no name a public CA issues for, so native hysteria serves the
      // panel's self-signed pair and clients pin it. Native only: hysteria on
      // sing-box brings its own certificate, and the key has no business in a
      // config the sing-box adapter keeps.
      const native = hysteriaInbounds.filter((ib) => ib.engine === undefined || ib.engine === 'hysteria');
      const pair = native.length > 0 ? await ensureHysteriaTls(nodeId) : null;
      if (pair) {
        for (const ib of native) {
          ib.config = {
            ...(ib.config as Record<string, unknown>),
            tlsCertPem: pair.certPem,
            tlsKeyPem: pair.keyPem,
          } as InboundDto['config'];
        }
      }
    }

    const domain = nodeRow?.domain ?? null;
    for (const ib of selfStealInbounds) {
      if (domain) {
        // Key MUST be `realityServerNames` (the wire-contract field the
        // node reads - see packages/shared XrayInboundCfg + the Go adapter).
        // A bare `serverNames` is an unknown key the agent's JSON decode
        // silently drops, leaving REALITY with the profile serverName and an
        // empty per-node SNI: SNI/IP mismatch + the local TLS fallback never
        // starts, so self-steal fails closed. Caught in review 2026-06-17.
        ib.config = {
          ...(ib.config as Record<string, unknown>),
          realityServerNames: [domain],
        } as InboundDto['config'];
      } else {
        getLogger().info(
          `[inbound-sync] node ${nodeId} xray inbound ${ib.id} is REALITY self-steal but the node has no domain set; serverNames not overridden (self-steal will not work until a domain is set on the node)`,
        );
      }
    }
  }

  // C3 - if this node is a hop in an enabled cascade, attach its chaining
  // fragments (link-in inbound, link-out outbound, routing rules) to the node's
  // xray inbound. The node-agent merges them into the xray config and forwards
  // entry->exit. Non-cascade nodes: getCascadeFragmentsForNode returns null and
  // this is a no-op, so the wire stays byte-identical to before.
  const cascade = await legacyCascadeAsPushed(nodeId, inbounds);
  if (cascade) {
    // A node runs a single xray config.json, so the first xray inbound is the
    // one (and only one) that carries the cascade.
    const xrayInbound = inbounds.find((i) => i.protocol === 'xray')!;
    xrayInbound.config = {
      ...(xrayInbound.config as Record<string, unknown>),
      cascade,
    } as InboundDto['config'];
  }

  // WARP egress (feat/warp-native) - if this node has WARP enabled, attach the
  // registered creds to its xray inbound's config. The node renders a wireguard
  // outbound to Cloudflare WARP + a routing rule (per-node egress v1). Like
  // cascade, a node runs one xray config so the first xray inbound carries it.
  // Only the node-relevant subset is sent (NOT the panel-only token/clientId/
  // deviceId/license). Non-WARP nodes: no-op, wire stays byte-identical.
  const warpXrayInbound = inbounds.find((i) => i.protocol === 'xray');
  if (warpXrayInbound) {
    const nodeWarp = await prisma.node.findUnique({
      where: { id: nodeId },
      select: { warpEnabled: true, warpAccount: true },
    });
    if (nodeWarp?.warpEnabled && nodeWarp.warpAccount) {
      const acct = nodeWarp.warpAccount as {
        secretKey?: string;
        address?: string[];
        publicKey?: string;
        endpoint?: string;
        reserved?: number[];
      };
      if (acct.secretKey && acct.address?.length) {
        warpXrayInbound.config = {
          ...(warpXrayInbound.config as Record<string, unknown>),
          warp: {
            secretKey: acct.secretKey,
            address: acct.address,
            publicKey: acct.publicKey,
            endpoint: acct.endpoint,
            reserved: acct.reserved,
          },
        } as InboundDto['config'];
      } else {
        getLogger().info(
          `[inbound-sync] node ${nodeId} has warpEnabled but warpAccount is incomplete; WARP egress not applied`,
        );
      }
    }
  }

  return inbounds;
}

/**
 * Everything one push carries: the inbounds, plus the two settings that belong
 * to the NODE rather than to any one of them.
 *
 * Э3: the policy rides in the SAME request as the inbounds, not in one of its
 * own. Two sources of config would mean two acknowledgements, and "saved but not
 * applied" would have to be worked out from two stamps instead of the one
 * lastInboundSyncAt everything already reads. Direction ids become outbound
 * names inside this call, in the same pass that prints the cascade fragments
 * those outbounds come from: within one push the two cannot disagree.
 *
 * Э3 F: so does the resolver, for that reason and one more. Every core we render
 * to keeps ONE dns section per process and the process is one per node, so the
 * setting arrives once per node. It started out on the inbound, where two
 * profiles on one node could ask for different resolvers.
 */
async function buildApplyInboundsRequest(node: NodeRow): Promise<ApplyInboundsRequest> {
  const inbounds = await fetchEnabledInbounds(node.id);
  const dns = (node.dns as DnsCfg | null) ?? undefined;
  // Э3 шаг 1: the cascade is a node-level block now, next to the policy and the
  // resolver. Read back off the xray inbound rather than fetched a second time,
  // so the node-level block and the transitional copy are literally the same
  // object and cannot disagree on the wire.
  //
  // ⚠ Both are sent for one release. A Go decoder ignores fields it does not
  // know, so an agent that has not been updated would see no cascade at all if
  // we stopped sending the old one, and would sit without a chain silently.
  const fragments = (
    inbounds.find((i) => i.protocol === 'xray')?.config as
      | { cascade?: XrayCascadeFragments }
      | undefined
  )?.cascade;
  // `engine` names the node's ROUTER. One core draws the chain, and today that
  // is xray on every node: the shape that would have to look it up (a second
  // router) does not exist yet, and guessing from the reported cores could name
  // a core that draws nothing, which loses the cascade instead of keeping the
  // behaviour it has. When a second router arrives this becomes a lookup over
  // node.cores (the core reporting rendersPolicy is the router).
  const cascade = fragments ? { engine: 'xray' as const, fragments } : undefined;
  // Phase 4, К6: the chain as its own process. Sent BESIDE the cascade above,
  // not instead of it, for one release.
  //
  // ⚠ The two blocks are two drawings of one cascade for two kinds of agent,
  // and they must not be swapped. `cascade` stays the legacy leg-dialling
  // version because an agent that cannot see `chain` applies it; `chain`
  // carries the handover version inside `userCore`, because an agent that can
  // see it ignores `cascade` entirely. Put the handover drawing in `cascade`
  // and an old agent points its xray at a loopback port nothing on that machine
  // is listening on, which is every user behind that entry.
  //
  // The rollback runs on the same rule from the other side: a panel rolled back
  // to a version that does not send `chain` simply sends the old block alone,
  // the agent stops holding a chain and hands its core the legacy fragments
  // again. Nobody logs in to the box.
  const chain = await getChainForNode(node.id);
  // A-108: the node policy names the cascade's outbounds of the drawing THIS
  // push gives the node's xray. Under a chain an xray entry hands over (socks
  // outbounds), and a node whose users are not on xray draws no way out at all.
  const policy = await resolvePolicyForNode(node.id, cascadeXrayDrawingOf(chain, fragments));
  return {
    inbounds,
    ...(policy ? { policy } : {}),
    ...(dns ? { dns } : {}),
    ...(cascade ? { cascade } : {}),
    ...(chain ? { chain } : {}),
  };
}

/** The request the worker WOULD send for this node, without sending it. Exists
 *  for tests: the push itself needs a live agent behind mTLS, so without this
 *  the only way to check what a node is told is to stand one up. Null when the
 *  node is gone or disabled, which is when nothing is pushed at all. */
export async function applyInboundsRequestForNode(
  nodeId: string,
): Promise<ApplyInboundsRequest | null> {
  const node = await fetchNode(nodeId);
  return node ? buildApplyInboundsRequest(node) : null;
}

/**
 * Compute the current set of enabled inbounds for `nodeId` and push it to
 * that node-agent over mTLS. Idempotent (the node-side endpoint diffs).
 *
 * Slice 24: replaces the manual `/etc/iceslab-node/env` editing dance
 * caught during the 2026-05-06 VPS test.
 */
export async function applyInboundsForNode(nodeId: string, revision?: bigint | null): Promise<void> {
  // A-162: the revision and the time this push stands for are taken BEFORE
  // anything is read for the request, so an edit that lands while it is being
  // built or delivered is newer than what it acknowledges.
  const rev = revision !== undefined ? revision : await readDesiredRevision(nodeId);
  const builtAt = new Date();

  const node = await fetchNode(nodeId);
  if (!node) {
    getLogger().info(`[worker:inbound-sync] applyInbounds ${nodeId}: node not active, skipping`);
    return;
  }

  /**
   * BUILDING the push is inside the try, not before it.
   *
   * It used to sit outside, and on 2026-09-22 that cost two cascade entries a
   * night: a direction pointed at a soft-deleted node, so the builder threw
   * "Cascade topology is broken around node ...", the throw missed this catch,
   * nothing was written to the node, and BullMQ retired the job with
   * removeOnFail. The panel showed two RU entries that simply never applied,
   * and the only copy of the reason was a failedReason in a Redis key nobody
   * reads. The pushes had been failing for a day before anyone looked.
   *
   * A refusal to build is a failure of this push in exactly the way a refusal
   * to deliver it is, so it belongs in the same branch and lands on the node
   * card the same way.
   */
  let req: ApplyInboundsRequest;
  let built: ApplyInboundsRequest | null = null;
  let inbounds: InboundDto[] = [];
  // A-275: the agent's ADAPTER_FAILED, held until the roster has gone out.
  let partial: NodeRequestError | null = null;
  // Whether the push being tried carries a chain block (E46, see the catch).
  let sentChain = false;
  const transport = new NodeTransport(node);

  try {
    // A-157: a vless leg stored without REALITY gets it before anything reads
    // the cascade, here and on the other end (which this queues).
    await giveCascadeLegsReality(node.id);
    req = await buildApplyInboundsRequest(node);
    // What the drawing check compares with later (render-drift.ts): the
    // request as built, before the geo block that needs the agent.
    built = req;
    inbounds = req.inbounds;
    // Phase 9.2: the geo files go out before the push that names them, since
    // the agent refuses a push whose files it does not hold (GEO_MISSING). An
    // agent older than geo gets no `geo` and the push it always got.
    const geo = await layOutGeo(transport, node.id);
    if (geo) req = { ...req, geo };

    getLogger().info(
      `[worker:inbound-sync] applyInbounds ${node.name}: pushing ${inbounds.length} inbound(s)`,
    );

    sentChain = req.chain !== undefined;
    const res = await transport.applyInbounds(req);
    if (res.skipped > 0) {
      // The agent answers 200 even for an inbound whose (protocol, engine) pair
      // matches no adapter it has: the config is persisted for a later restart
      // to pick up, but nothing is listening now. Meanwhile the subscription
      // generator keeps handing that endpoint to users, who connect to a server
      // that will never answer. Logging it as a clean success is how an adapter
      // gap during a staged rollout stays invisible until users complain.
      getLogger().warn(
        `[worker:inbound-sync] applyInbounds ${node.name}: applied=${res.applied} SKIPPED=${res.skipped} ` +
          `(no matching adapter on this node, config persisted but not live); ` +
          `subscriptions still advertise the skipped endpoints`,
      );
      inboundSyncJobs.inc({ result: 'skipped' });
    } else {
      getLogger().info(
        `[worker:inbound-sync] applyInbounds ${node.name} ok: applied=${res.applied}`,
      );
      inboundSyncJobs.inc({ result: 'ok' });
    }
    // Record the acknowledgement. Stamped ONLY on success, so a failed or a
    // still-queued push leaves the marker stale and a caller can tell a config
    // that landed from one that is still in flight (cascade status today, node
    // failover later). A partial push counts: the node did process this
    // request, and the response carries aggregate counts only, so we could not
    // attribute a skip to a particular inbound even if we wanted to. Withholding
    // the stamp would instead wedge every reader forever on an unrelated skip.
    // Best-effort: this bookkeeping must never turn an otherwise successful push
    // into a failed job.
    await prisma.node
      .update({
        where: { id: nodeId },
        // Cleared here, beside the stamp, so the pair always reads as one
        // state. A stale error next to a fresh stamp would say the node is
        // both current and broken, and an operator has no way to tell which
        // half is the old one.
        data: {
          // A-162: when the request was BUILT, not when the agent answered:
          // an edit saved during the push is then later than this stamp.
          lastInboundSyncAt: builtAt,
          lastInboundSyncError: Prisma.DbNull,
          /**
           * Whether this node was sent a chain block, recorded by the side
           * that sent it.
           *
           * It is what lets a missing chain mean something. The agent reports
           * no chain on every node until phase 4 starts sending one, and the
           * status rule may only call that a fault where the panel actually
           * asked for a chain. Stamped on the acknowledged push, not on the
           * attempt: a block that never arrived is not something to hold the
           * node to.
           */
          chainSentAt: req.chain ? new Date() : null,
        },
      })
      .catch(() => null);
    // A-162: the revision read before building, never a later one: an edit
    // that landed meanwhile stays above it and is pushed again. GREATEST so a
    // slow answer to an older request cannot lower what a newer one set.
    if (rev !== null) {
      await prisma.$executeRaw`
        UPDATE nodes SET applied_revision = GREATEST(applied_revision, ${rev})
        WHERE id = ${nodeId}::uuid`.catch(() => null);
    }
    // Applied in full: the drawing the node now has, as a sha. A partial push
    // (A-275) goes to the catch and records nothing, so the check asks again.
    if (built) await recordPushed(nodeId, built).catch(() => null);
  } catch (err) {
    const detail =
      err instanceof NodeRequestError
        ? `${err.status} ${err.message}`
        : err instanceof Error
        ? err.message
        : String(err);
    getLogger().info(`[worker:inbound-sync] applyInbounds ${node.name} FAILED: ${detail}`);
    inboundSyncJobs.inc({ result: 'fail' });
    /**
     * Keep the refusal where the operator looks.
     *
     * The core answers a bad field by refusing the WHOLE config, so a node that
     * was serving fine goes dark on the next restart, and until now the panel
     * said nothing at all: this branch logged one line and rethrew, and
     * `lastInboundSyncAt` merely stopped moving. The screen then showed "not
     * applied yet", which is what a push still in flight looks like, about one
     * that will never apply. The only copy of the reason was in the agent's
     * journal, behind ssh.
     *
     * `detail` is kept whole rather than cut at "core rejected the config":
     * everything before that marker is the agent naming WHICH inbound and how
     * many, and an operator with five inbounds needs that more than they need
     * the tidier sentence.
     *
     * Best-effort and last, exactly like the stamp above: the job has already
     * failed, and failing to record why must not replace the real error with a
     * database one.
     */
    await prisma.node
      .update({
        where: { id: nodeId },
        data: {
          lastInboundSyncError: {
            at: new Date().toISOString(),
            // Bounded because it is the core's output, not ours: an unbounded
            // field fed by another program's stderr grows a row without limit.
            message: detail.slice(0, 2000),
          },
          /**
           * E46: a push the AGENT refused still reached it. ADAPTER_FAILED is
           * the agent's answer after it applied what it could, the chain block
           * included, so the node now holds (and reports) a chain the panel
           * sent. Stamped here too, or a chain that fails to start on its very
           * first push ("no singbox binary") would never be held against the
           * node: the node status only counts a down chain the panel sent.
           * Any other failure (network, a refusal before applying) leaves the
           * stamp as it was.
           */
          ...(err instanceof NodeRequestError && err.status === 500 && err.body?.error === 'ADAPTER_FAILED'
            ? { chainSentAt: sentChain ? new Date() : null }
            : {}),
        },
      })
      .catch(() => null);
    /**
     * A-275, stand 26.10: ADAPTER_FAILED is the agent's answer AFTER it applied
     * every core it could (server.go handleApplyInbounds: applyPushOutcome runs
     * all of them, then 500 names the ones that refused). Rethrowing here kept
     * the roster from the node, so one refusing core (mieru with no user, a
     * hysteria with no ACME email) left the users of every other core on the
     * node without their new users. The roster goes out to what applied; the
     * job still fails after it, the error stays on the node card, the revision
     * is not marked applied, and BullMQ's retry pushes again.
     */
    if (err instanceof NodeRequestError && err.status === 500 && err.body?.error === 'ADAPTER_FAILED') {
      partial = err;
    } else {
      throw err;
    }
  }

  // Push all active users so protocol servers (xray, hysteria, etc.) have
  // an up-to-date client list. addUser is idempotent on the node side.
  if (inbounds.length === 0) {
    if (partial) throw partial;
    return;
  }

  // Find the AmneziaWG profile bound to this node (at most one, single
  // awg-quick interface per host). When present, every active user with
  // AWG creds needs an allocated IP inside the profile's subnet pushed
  // alongside the public key, without it the node-agent silently
  // skips the peer (AmneziaWGAllowedIP=="" → no-op AddUser). Caught
  // live cycle #6 2026-05-12: addUser ok was logged but `awg show`
  // showed zero peers because IP was empty on the wire.
  //
  // Keyed on profileId (NOT binding.id) so a user gets the same IP on
  // every node a profile is bound to, matches the subscription /
  // wgconf path which also keys on profileId.
  //
  // t07-6: one per GENERATION. The node carries a 1.x interface and a 3.1
  // one, each from its own profile and subnet, so a user has an address on
  // each (amneziawgAllowedIp and amneziawgAllowedIp3). The agent keeps the
  // last AWG inbound of a generation it is pushed, in port order; so does this.
  const is3 = (i: InboundDto) => (i.config as { awgProtocol?: number }).awgProtocol === 3;
  const awgBinding = inbounds.filter((i) => i.protocol === 'amneziawg' && !is3(i)).at(-1);
  const awg3Binding = inbounds.filter((i) => i.protocol === 'amneziawg' && is3(i)).at(-1);

  const users = await fetchActiveUsers();
  getLogger().info(
    `[worker:inbound-sync] pushing ${users.length} user(s) to ${node.name}`,
  );
  // A-022: each user on exactly the inbounds of this node their squads reach
  // (the subscription's own rule, user-reach.ts). A user who reaches none of
  // them gets an empty list, which takes them off the node: a squad that lost
  // this node's profile must not leave its members on it. An agent older than
  // the field ignores the list and serves everyone on every inbound, as before.
  // Every active user, as a filter (users holds the same set; a list of ids
  // would run past Postgres's bind-parameter cap on a large roster).
  const reach = await reachOfUsers(null, { nodeId });
  const inboundIdsOf = (userId: string): string[] => reach.get(userId)?.get(nodeId) ?? [];
  // A-164: an address only for the users who reach that AmneziaWG inbound.
  const awgIpByUser = await allocateAwgAddresses(
    awgBinding?.id,
    users.filter((u) => awgBinding && inboundIdsOf(u.id).includes(awgBinding.id)),
  );
  const awg3IpByUser = await allocateAwgAddresses(
    awg3Binding?.id,
    users.filter((u) => awg3Binding && inboundIdsOf(u.id).includes(awg3Binding.id)),
  );

  const requests: AddUserRequest[] = users.map((u) => ({
    userId: u.id,
    shortId: u.shortId,
    username: u.username,
    inboundIds: inboundIdsOf(u.id),
    credentials: {
      xrayUuid: u.xrayUuid,
      hysteriaPassword: u.hysteriaPassword,
      amneziawgPublicKey: u.amneziawgPublicKey,
      amneziawgAllowedIp: awgIpByUser.get(u.id),
      amneziawgAllowedIp3: awg3IpByUser.get(u.id),
      naivePassword: u.naivePassword,
      tuicUuid: u.xrayUuid,
      tuicPassword: deriveTuicPassword(u.xrayUuid),
      anytlsPassword: deriveAnytlsPassword(u.xrayUuid),
      shadowtlsPassword: deriveShadowtlsPassword(u.xrayUuid),
    },
  }));
  const failed = await sendRoster(transport, node.name, requests);
  getLogger().info(
    `[worker:inbound-sync] user sync to ${node.name} done (${users.length - failed}/${users.length} ok)` +
      (partial ? ', after a push some cores refused' : ''),
  );
  if (partial) throw partial;
}

/**
 * A-112: users per /addUsers request. Sized against the agent's 1 MiB body
 * cap (maxRequestBodyBytes in server.go) with room to spare; the guard test
 * builds a batch of this size from the longest values each field takes.
 */
export const ADD_USERS_BATCH = 250;

/** The old fanout, for an agent without /addUsers: 25 /addUser at a time. */
const ADD_USER_CHUNK = 25;

/**
 * The roster to one node, ADD_USERS_BATCH users per request: thirty thousand
 * users were thirty thousand requests on every push (A-112). An agent older
 * than /addUsers answers 404, and the rest goes one by one as before. Answers
 * how many users did not land; a failed request counts all of its users and
 * the rest still goes, as a failed /addUser did before.
 */
export async function sendRoster(
  transport: Pick<NodeTransport, 'addUser' | 'addUsers'>,
  nodeName: string,
  requests: AddUserRequest[],
): Promise<number> {
  let failed = 0;
  let i = 0;
  for (; i < requests.length; i += ADD_USERS_BATCH) {
    const batch = requests.slice(i, i + ADD_USERS_BATCH);
    try {
      const res = await transport.addUsers({ users: batch });
      for (const r of res.results) {
        if (r.ok) continue;
        failed++;
        getLogger().info(`[worker:inbound-sync] addUser ${r.userId} to ${nodeName} FAILED: ${r.error ?? 'refused'}`);
      }
      // An entry the agent did not answer for did not land either.
      failed += Math.max(0, batch.length - res.results.length);
    } catch (err) {
      if (err instanceof NodeRequestError && err.status === 404) break;
      failed += batch.length;
      const detail = err instanceof Error ? err.message : String(err);
      getLogger().info(`[worker:inbound-sync] addUsers (${batch.length}) to ${nodeName} FAILED: ${detail}`);
    }
  }
  if (i >= requests.length) return failed;

  getLogger().info(`[worker:inbound-sync] ${nodeName} has no /addUsers (older agent), sending users one by one`);
  for (; i < requests.length; i += ADD_USER_CHUNK) {
    const chunk = requests.slice(i, i + ADD_USER_CHUNK);
    const results = await Promise.allSettled(chunk.map((r) => transport.addUser(r)));
    for (let j = 0; j < results.length; j++) {
      const r = results[j]!;
      if (r.status === 'rejected') {
        failed++;
        const detail = r.reason instanceof Error ? r.reason.message : String(r.reason);
        getLogger().info(`[worker:inbound-sync] addUser ${chunk[j]!.username} to ${nodeName} FAILED: ${detail}`);
      }
    }
  }
  return failed;
}

/**
 * A-162: after a job, completed or out of attempts, push again when the
 * node's revision moved past the one the job read. Called from the worker's
 * events, where the finished job no longer holds the jobId (removeOnComplete
 * and removeOnFail), so this add is not dropped as a duplicate.
 *
 * "Moved past what was read", not "above what is applied": a node that is
 * down would otherwise be queued again and again after every last attempt.
 * Such a node is brought back by the poll cron instead (reconcileNodeRevisions).
 */
export async function requeueIfMoved(nodeId: string, readRevision: bigint | null | undefined): Promise<boolean> {
  if (readRevision === null || readRevision === undefined) return false;
  const now = await readDesiredRevision(nodeId);
  if (now === null || now <= readRevision) return false;
  // ⚠ The worker emits completed/failed while the finished job still holds
  // its jobId (measured on BullMQ here: getState() said "active" inside the
  // handler), so an add right away is folded into the job that is ending and
  // lost, the very bug this replaces. Wait until the old job is gone, two
  // seconds at most, then add.
  const jobId = `apply-${nodeId}`;
  for (let i = 0; i < 100; i++) {
    const old = await inboundSyncQueue.getJob(jobId);
    if (!old || (await old.getState()) !== 'active') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await inboundSyncQueue.add('applyNodeInbounds', { nodeId }, { jobId });
  return true;
}

/**
 * A-162, principle P1: a node converges by itself. Online or degraded, and
 * its applied revision behind the desired one (the last attempt failed and
 * nothing has been edited since): queue its push. Degraded counts, by the
 * same rule as the re-push on coming back (nodes.cron.ts): a node whose core
 * will not start is the one that needs the config, and a degraded node with
 * a failed push and no status change would otherwise never converge. Run
 * from the status poll; one query on a small table, and the jobId folds a
 * push already queued.
 *
 * ⚠ At most once an hour per (node, revision). A config the agent REFUSES
 * stays behind too, and that refusal restarts the node's cores on every try:
 * retried on each poll tick it would bounce a live node every half minute
 * over an error only an edit can fix. Once an hour still converges a node
 * whose last attempt died on the network, which is the case this is for.
 */
const RECONCILE_EVERY_S = 3600;

/** The drawing check (render-drift.ts) with this module's builder and push:
 *  at backend start and from the hourly cron (node-drawing-check). */
export function checkNodeDrawings(): Promise<number> {
  return checkRenderDrift((nodeId) => applyInboundsRequestForNode(nodeId), enqueueNodePush);
}

export async function reconcileNodeRevisions(): Promise<number> {
  const behind = await prisma.$queryRaw<{ id: string; desired: bigint }[]>`
    SELECT id::text AS id, desired_revision AS desired FROM nodes
    WHERE deleted_at IS NULL AND status IN ('online', 'degraded') AND applied_revision < desired_revision`;
  let queued = 0;
  for (const n of behind) {
    const first = await redis.set(`inbound-sync:reconciled:${n.id}:${n.desired}`, '1', 'EX', RECONCILE_EVERY_S, 'NX');
    if (first !== 'OK') continue;
    await inboundSyncQueue.add('applyNodeInbounds', { nodeId: n.id }, { jobId: `apply-${n.id}` });
    queued++;
  }
  return queued;
}

// ───── Worker ─────

export function startInboundSyncWorker(): Worker<ApplyNodeInboundsJobData> {
  // A-162: the revision each running job read, for its completed/failed
  // event. Kept in this process: the events of a job fire in the worker that
  // ran it.
  const readByJob = new Map<string, bigint | null>();
  const worker = new Worker<ApplyNodeInboundsJobData>(
    QUEUE_NAME,
    async (job: Job<ApplyNodeInboundsJobData>) => {
      switch (job.name) {
        case 'applyNodeInbounds': {
          const rev = await readDesiredRevision(job.data.nodeId);
          readByJob.set(job.id ?? '', rev);
          await applyInboundsForNode(job.data.nodeId, rev);
          break;
        }
        default:
          throw new Error(`Unknown job name: ${job.name}`);
      }
    },
    {
      connection: redis,
      // One node at a time per worker, applyInbounds restarts the protocol
      // server, parallel restarts on the same node would race. Different
      // nodes can still go in parallel because they're distinct job IDs.
      concurrency: 5,
    },
  );

  /**
   * Why a job died, in the log, every attempt.
   *
   * `removeOnFail: true` is deliberate (a failed job would hold its jobId and
   * deadlock every later enqueue for that node), and its price is that the
   * failure leaves no trace in Redis either. On 2026-09-22 that price came due:
   * two cascade entries failed three attempts each and vanished, and the only
   * record was a `failedReason` inside `bull:inbound-sync:events`, which is not
   * somewhere anybody looks. The same failures had been happening for a day.
   *
   * The attempt number is here because it is what tells a transient blip from a
   * standing refusal: attempt 1 of 3 on a network hiccup reads nothing like
   * attempt 3 of 3 on a broken cascade topology.
   */
  worker.on('failed', (job, err) => {
    getLogger().error(
      `[worker:inbound-sync] job ${job?.name ?? 'unknown'} FAILED ` +
        `(attempt ${job?.attemptsMade ?? '?'} of ${job?.opts?.attempts ?? '?'}) ` +
        `node=${job?.data?.nodeId ?? 'unknown'}: ${err?.message ?? String(err)}`,
    );
    // Only the LAST attempt ends the job: an earlier one retries and reads
    // the revision again at its start.
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      const rev = readByJob.get(job.id ?? '');
      readByJob.delete(job.id ?? '');
      void requeueIfMoved(job.data.nodeId, rev).catch(() => null);
    }
  });
  worker.on('completed', (job) => {
    const rev = readByJob.get(job.id ?? '');
    readByJob.delete(job.id ?? '');
    void requeueIfMoved(job.data.nodeId, rev).catch(() => null);
  });

  return worker;
}
