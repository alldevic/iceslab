import { isIP } from 'node:net';
import { Queue, Worker, type Job } from 'bullmq';
import type { ApplyInboundsRequest, InboundDto, ProtocolName } from '@iceslab/shared';
import { coerceEgressPolicy, compileEgressPolicy } from '../egress/egress.policy.js';
import { zapret2SocksPortFor } from '../egress/egress.zapret2.js';
import { hostFromAddress } from '../subscription/subscription.formats.js';
import { redis, queueRedis } from '../../lib/redis.js';
import { prisma } from '../../prisma.js';
import { mtprotoSecret } from '../../core-adapters/mtproto/index.js';
import { NodeTransport, NodeRequestError } from '../nodes/nodes.transport.js';
import { inboundSyncJobs } from '../../lib/metrics.js';
import { allocatePeer, preallocatePeers } from '../amneziawg/amneziawg.service.js';
import { ensureDevicesForUsers, resolveWgDeviceCount } from '../wg-devices/wg-devices.service.js';
import { getCascadeFragmentsForNode } from '../cascades/cascade.service.js';
import { deriveTuicPassword, deriveAnytlsPassword, deriveShadowtlsPassword } from '../../lib/credentials.js';
import { applyEgressForNode } from '../egress/egress.push.js';
import { getLogger } from '../../lib/logger.js';
import { resolveBindingConfig } from '../profiles/profiles.service.js';

/**
 * The FQDN to publish in a node's hysteria `acme.domains`, or null to leave the
 * node on the hostname it was installed with.
 *
 * Taken from the node's own address because that is both what a hysteria client
 * dials and what it sends as its SNI, which makes it the only name whose
 * certificate can validate. Anything a public CA cannot issue for returns null,
 * since asking hysteria to re-issue on a doomed name would cost it the working
 * certificate it already holds:
 *   - an IP literal, which Let's Encrypt does not serve
 *   - a single-label name, which cannot be publicly resolvable
 */
export function acmeHostnameFor(address: string | null | undefined): string | null {
  if (!address) return null;
  const host = hostFromAddress(address.trim()).toLowerCase();
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (!bare || isIP(bare) !== 0 || !bare.includes('.')) return null;
  return bare;
}

// ───── Job data shapes ─────

export interface ApplyNodeInboundsJobData {
  /** Which node's inbound set to recompute and push. */
  nodeId: string;
}

// ───── Queue ─────

const QUEUE_NAME = 'inbound-sync';

/**
 * Redis key for the "dirty" flag used by the dirty-flag coalescing pattern.
 *
 * Race the flag fixes: BullMQ's per-jobId dedupe rejects new enqueues for
 * jobs that are currently `active` (mid-push), so an admin edit landing
 * during the 5-30 s mTLS push window was silently dropped, the running
 * worker never saw the change, and no new push got scheduled. Next push
 * had to wait for an unrelated event.
 *
 * Sequence with the flag:
 *   enqueue → SET dirty
 *   worker start → DEL dirty (consume current intent)
 *   worker do-work (any concurrent enqueue re-SETs the flag here)
 *   worker end → GET dirty; if set, re-enqueue (new job, succeeds since
 *               the active one just completed)
 */
export function inboundDirtyKey(nodeId: string): string {
  return `inbound-sync:dirty:${nodeId}`;
}

export const inboundSyncQueue = new Queue<ApplyNodeInboundsJobData>(QUEUE_NAME, {
  connection: queueRedis,
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
}

async function fetchNode(nodeId: string): Promise<NodeRow | null> {
  return prisma.node.findFirst({
    where: { id: nodeId, deletedAt: null, status: { not: 'disabled' } },
    select: { id: true, name: true, address: true },
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
  /** Device policy, read here for the same reason the subscription reads it:
   *  both provision devices and must provision the same number. */
  hwidDeviceLimit: number | null;
  groupMembers: { group: { hwidDeviceLimit: number | null } }[];
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
      // Slice 51: the push provisions the SAME number of devices the
      // subscription hands out, so both need the same inputs. When they
      // disagreed, the extra devices existed in the database with an address
      // and never reached the node.
      hwidDeviceLimit: true,
      groupMembers: { select: { group: { select: { hwidDeviceLimit: true } } } },
    },
  });
}

export async function fetchEnabledInbounds(nodeId: string): Promise<InboundDto[]> {
  // Slice 27: walks ProfileNodeBinding rows joined to Profile, and resolves
  // the deployable config for each. Replaces the old per-node `inbounds`
  // table read while keeping the wire format identical (the node-agent
  // doesn't know about profile/binding split, it just gets a flat list).
  const bindings = await prisma.profileNodeBinding.findMany({
    where: {
      nodeId,
      enabled: true,
      profile: { enabled: true },
    },
    include: {
      profile: {
        select: { id: true, name: true, protocol: true, engine: true, config: true },
      },
    },
    orderBy: { port: 'asc' },
  });

  const inbounds = bindings.map((b) => {
    // Shallow merge: per-binding overrides win over profile.config. Used for
    // ACME domain, AmneziaWG private key, Shadowsocks server PSK, etc.
    //
    // Through resolveBindingConfig rather than a third hand-rolled spread: its
    // doc comment has always claimed this queue as a caller, and it was not one
    // - the merge lived here and in subscription.service as separate copies.
    // assertNoNewConfigViolations gates writes by parsing what THIS function
    // returns, so a copy that drifts from it turns the gate into a check on a
    // config nothing deploys.
    let config = resolveBindingConfig(
      b.profile.config,
      b.overrides,
      b.profile.protocol,
    ) as InboundDto['config'];

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

    // AmneziaWG / WireGuard: inject the binding-level port into the protocol
    // config so the agent binds the wg-quick interface to the port the admin
    // set (typical 443 for stealth) instead of WireGuard's default 51820.
    // Without this, the wgconf subscription advertises Endpoint=:443 but
    // the server actually listens on 51820, handshake never completes.
    // Caught live awg-VPS cycle #6 2026-05-12.
    if (b.profile.protocol === 'amneziawg' || b.profile.protocol === 'wireguard') {
      config = {
        ...(config as Record<string, unknown>),
        listenPort: b.port,
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

  // The three per-NODE features below (cascade, WARP, egress policy) all render
  // as xray routing rules and outbounds, and all three ride on an xray inbound's
  // config. Which xray inbound may carry them is one question, so it is asked
  // once, here.
  //
  // `engine !== 'singbox'` is the whole point of the predicate. The sing-box
  // renderer emits one outbound - `direct` - and no routing section at all, so
  // an inbound served by it is not a place any of the three can land. Handing
  // it one is either loud (the agent refuses cascade and routingFragments, and
  // the push fails for every OTHER inbound on the node too) or silent (WARP had
  // no guard on either side, so the panel showed a node egressing through
  // Cloudflare while every flow left its own IP - measured 2026-08-30). Skipping
  // it instead falls through to the "nowhere to render" branch, which says so.
  const canRenderRouting = (i: InboundDto) => i.protocol === 'xray' && i.engine !== 'singbox';

  // C3 - if this node is a hop in an enabled cascade, attach its chaining
  // fragments (link-in inbound, link-out outbound, routing rules) to the node's
  // xray inbound. The node-agent merges them into the xray config and forwards
  // entry->exit. Non-cascade nodes: getCascadeFragmentsForNode returns null and
  // this is a no-op, so the wire stays byte-identical to before.
  const cascade = await getCascadeFragmentsForNode(nodeId);
  if (cascade) {
    // A node runs a single xray config.json, so the first xray inbound is the
    // one (and only one) that carries the cascade.
    const xrayInbound = inbounds.find(canRenderRouting);
    if (xrayInbound) {
      xrayInbound.config = {
        ...(xrayInbound.config as Record<string, unknown>),
        cascade,
      } as InboundDto['config'];
    } else {
      getLogger().info(
        `[inbound-sync] node ${nodeId} is in an enabled cascade but has no xray inbound the xray engine serves; cascade not applied`,
      );
    }
  }

  // WARP egress (feat/warp-native) - if this node has WARP enabled, attach the
  // registered creds to its xray inbound's config. The node renders a wireguard
  // outbound to Cloudflare WARP + a routing rule (per-node egress v1). Like
  // cascade, a node runs one xray config so the first xray inbound carries it.
  // Only the node-relevant subset is sent (NOT the panel-only token/clientId/
  // deviceId/license). Non-WARP nodes: no-op, wire stays byte-identical.
  const warpXrayInbound = inbounds.find(canRenderRouting);
  if (warpXrayInbound) {
    const nodeWarp = await prisma.node.findUnique({
      where: { id: nodeId },
      select: { warpEnabled: true, warpAccount: true, hardening: true },
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

    // B1 - compile this node's egress policy (which flows leave by which way
    // out) against the ways out it actually has, and attach the result to the
    // same xray inbound. Compiled here rather than stored on the profile
    // because a rule's target is a capability of THIS machine: a rule naming a
    // channel the node lacks is dropped, since an unknown outboundTag is a
    // config xray refuses to start on. No policy = nothing attached = the node
    // renders byte-identically to before.
    const warpUsable = Boolean(
      nodeWarp?.warpEnabled &&
        (nodeWarp.warpAccount as { secretKey?: string; address?: string[] } | null)?.secretKey,
    );
    const hardening = nodeWarp?.hardening as
      | { egressPolicy?: unknown; zapret2?: unknown }
      | null;
    const compiled = compileEgressPolicy(coerceEgressPolicy(hardening?.egressPolicy), {
      warp: warpUsable,
      zapret2SocksPort: zapret2SocksPortFor(hardening?.zapret2),
    });
    for (const drop of compiled.dropped) {
      getLogger().info(
        `[inbound-sync] node ${nodeId} egress policy rule #${drop.index} targets "${drop.target}" but ${drop.reason}; rule dropped`,
      );
    }
    if (compiled.fragments) {
      warpXrayInbound.config = {
        ...(warpXrayInbound.config as Record<string, unknown>),
        routingFragments: compiled.fragments,
      } as InboundDto['config'];
    }
  } else {
    // A policy on a node with no xray inbound has nowhere to render: the other
    // cores emit no routing section. Say so rather than let the operator read
    // the split in the panel and believe it.
    const nodeRouting = await prisma.node.findUnique({
      where: { id: nodeId },
      select: { hardening: true, warpEnabled: true },
    });
    // WARP is read from the same row and reported the same way. It used to be
    // the one of the two that said nothing at all, which is how a node could
    // show warpEnabled in the panel while its rendered config held a single
    // `direct` outbound.
    if (nodeRouting?.warpEnabled) {
      getLogger().info(
        `[inbound-sync] node ${nodeId} has WARP egress enabled but no xray inbound the xray engine serves; WARP not applied (traffic leaves the node's own address)`,
      );
    }
    if (coerceEgressPolicy((nodeRouting?.hardening as { egressPolicy?: unknown } | null)?.egressPolicy)) {
      getLogger().info(
        `[inbound-sync] node ${nodeId} has an egress policy but no xray inbound the xray engine serves; policy not applied`,
      );
    }
  }

  return inbounds;
}

/**
 * Compute the current set of enabled inbounds for `nodeId` and push it to
 * that node-agent over mTLS. Idempotent (the node-side endpoint diffs).
 *
 * Slice 24: replaces the manual `/etc/iceslab-node/env` editing dance
 * caught during the 2026-05-06 VPS test.
 */
export async function applyInboundsForNode(nodeId: string): Promise<void> {
  // Consume the dirty-flag at the start. Any enqueue that comes in WHILE
  // we're working will re-SET this key; we check it again at the end and
  // re-enqueue if it's set. See inboundDirtyKey() for the full rationale.
  await redis.del(inboundDirtyKey(nodeId)).catch(() => null);

  const node = await fetchNode(nodeId);
  if (!node) {
    getLogger().info(`[worker:inbound-sync] applyInbounds ${nodeId}: node not active, skipping`);
    return;
  }

  const inbounds = await fetchEnabledInbounds(nodeId);
  const req: ApplyInboundsRequest = { inbounds };

  getLogger().info(
    `[worker:inbound-sync] applyInbounds ${node.name}: pushing ${inbounds.length} inbound(s)`,
  );

  const transport = new NodeTransport(node);

  try {
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
      .update({ where: { id: nodeId }, data: { lastInboundSyncAt: new Date() } })
      .catch(() => null);
  } catch (err) {
    const detail =
      err instanceof NodeRequestError
        ? `${err.status} ${err.message}`
        : err instanceof Error
        ? err.message
        : String(err);
    getLogger().info(`[worker:inbound-sync] applyInbounds ${node.name} FAILED: ${detail}`);
    inboundSyncJobs.inc({ result: 'fail' });
    throw err;
  }

  // B2a - re-apply this node's zapret2 channel config on every sync (node.updated
  // fires when hardening.zapret2 changes; agent-restart resync re-pushes it).
  // Best-effort and self-contained: applyEgressForNode swallows its own errors,
  // so a zapret2 push never blocks the user fan-out below. No-op on a node that
  // does not run the channel.
  await applyEgressForNode(node);

  // Push all active users so protocol servers (xray, hysteria, etc.) have
  // an up-to-date client list. addUser is idempotent on the node side.
  if (inbounds.length === 0) return;

  // Find the wg-family profiles bound to this node (at most one per flavour,
  // one interface each per host). When present, every active user with WG
  // creds needs an allocated IP inside that profile's subnet pushed alongside
  // the public key, without it the node-agent silently skips the peer
  // (AllowedIP=="" → no-op AddUser). Caught live cycle #6 2026-05-12: addUser
  // ok was logged but `awg show` showed zero peers because IP was empty on
  // the wire.
  //
  // The two flavours are resolved SEPARATELY because they carry separate
  // subnets: a node bound to both hands the same user two different addresses,
  // and crossing them puts a peer on an interface whose subnet doesn't
  // contain it.
  //
  // Keyed on profileId (NOT binding.id) so a user gets the same IP on
  // every node a profile is bound to, matches the subscription /
  // wgconf path which also keys on profileId.
  async function resolveWgProfile(
    protocol: 'amneziawg' | 'wireguard',
  ): Promise<{ profileId: string; subnet: string; presharedKey: boolean } | null> {
    const bound = inbounds.find((i) => i.protocol === protocol);
    if (!bound) return null;
    const binding = await prisma.profileNodeBinding.findUnique({
      where: { id: bound.id },
      select: { profileId: true, profile: { select: { config: true } } },
    });
    if (!binding) return null;
    const pcfg = (binding.profile.config ?? {}) as {
      subnet?: string;
      presharedKey?: boolean;
    };
    return {
      profileId: binding.profileId,
      subnet: pcfg.subnet ?? '10.66.66.0/24',
      // Per profile, and read here rather than passed down, because the node
      // takes the key per PEER: the flag decides whether the value travels at
      // all, and a profile with it off must push nothing, not an empty string.
      presharedKey: pcfg.presharedKey === true,
    };
  }

  const awgProfile = await resolveWgProfile('amneziawg');
  const wgProfile = await resolveWgProfile('wireguard');

  const users = await fetchActiveUsers();
  getLogger().info(
    `[worker:inbound-sync] pushing ${users.length} user(s) to ${node.name}`,
  );

  // Wave-14 #13: pre-allocate AWG IPs serially (allocatePeer is racy under
  // concurrency, IP slots aren't unique-indexed). Then fan out addUser in
  // bounded-parallel chunks. Pre-wave a 1000-user install did 1000 serial
  // mTLS round-trips (~50ms each) = ~50s of worker time blocked per node
  // push, which compounds when multiple nodes need re-push at once.
  // Slice 51: one peer per DEVICE, and the device is what the node keys it on.
  //
  // `AddUser` fans out to every adapter, but each one returns nil unless ITS
  // credential is present (xray on XrayUUID, hysteria on HysteriaPassword,
  // sing-box on uuid+password, and so on - checked in all eight). So a record
  // carrying ONLY wg fields lands in the wireguard/amneziawg adapters and
  // nowhere else. That is what lets a device be its own entry on the wire with
  // no change to the agent: the user's non-wg record stays keyed on the user,
  // each device gets a record keyed on the device.
  //
  // The split also makes revocation mean one thing. `RemoveUser(id)` reaches
  // every adapter, so revoking a device that shared the user's id would take
  // that user's xray and hysteria access down with it.
  const devicesByUser = await ensureDevicesForUsers(
    users.map((u) => ({
      userId: u.id,
      count: resolveWgDeviceCount(
        u.hwidDeviceLimit,
        u.groupMembers.map((m) => m.group.hwidDeviceLimit),
      ),
    })),
  );
  const wgPeers: {
    deviceId: string;
    userId: string;
    publicKey: string;
    presharedKey: string | null;
  }[] = [];
  for (const u of users) {
    for (const d of devicesByUser.get(u.id) ?? []) {
      wgPeers.push({
        deviceId: d.id,
        userId: u.id,
        publicKey: d.publicKey,
        presharedKey: d.presharedKey,
      });
    }
  }

  async function allocateIps(
    profile: { profileId: string; subnet: string } | null,
  ): Promise<Map<string, string>> {
    const ipByDevice = new Map<string, string>();
    if (!profile) return ipByDevice;
    const { profileId, subnet } = profile;
    // B7 - one bulk allocation for the whole set instead of N serial
    // allocatePeer round-trips. Stragglers (race loss / contention) fall back
    // to the robust per-device allocator below.
    const bulk = await preallocatePeers(profileId, wgPeers, subnet).catch((err) => {
      const detail = err instanceof Error ? err.message : String(err);
      getLogger().info(
        `[worker:inbound-sync] bulk preallocatePeers on profile ${profileId} FAILED, per-device fallback: ${detail}`,
      );
      return new Map<string, string>();
    });
    for (const peer of wgPeers) {
      let ip = bulk.get(peer.deviceId);
      if (!ip) {
        try {
          ip = (await allocatePeer(profileId, peer.deviceId, peer.userId, subnet)).ip;
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          getLogger().info(
            `[worker:inbound-sync] allocatePeer device ${peer.deviceId} on profile ${profileId} FAILED: ${detail}`,
          );
          // Fall through: this device gets no tunnel, the user's other
          // protocols and other devices are unaffected.
          continue;
        }
      }
      ipByDevice.set(peer.deviceId, ip);
    }
    return ipByDevice;
  }

  const awgIpByDevice = await allocateIps(awgProfile);
  const wgIpByDevice = await allocateIps(wgProfile);

  // Chunked parallel fanout. 25 is a balance between throughput and not
  // hammering the node-agent's HTTP server (default Node http.Agent
  // maxSockets = Infinity but the node-agent runs single-process Go,
  // 25 concurrent in-flight is comfortably below typical default ulimits).
  const ADD_USER_CHUNK = 25;
  let chunkFailed = 0;

  // Two kinds of record, one endpoint. The user's carries everything EXCEPT wg;
  // each device's carries ONLY wg. Every adapter gates on its own credential,
  // so each record reaches exactly the cores it is meant for - see the note
  // above wgPeers.
  type PushItem = { label: string; req: Parameters<typeof transport.addUser>[0] };
  const items: PushItem[] = users.map((u) => ({
    label: u.username,
    req: {
      userId: u.id,
      shortId: u.shortId,
      username: u.username,
      credentials: {
        xrayUuid: u.xrayUuid,
        hysteriaPassword: u.hysteriaPassword,
        naivePassword: u.naivePassword,
        tuicUuid: u.xrayUuid,
        tuicPassword: deriveTuicPassword(u.xrayUuid),
        anytlsPassword: deriveAnytlsPassword(u.xrayUuid),
        shadowtlsPassword: deriveShadowtlsPassword(u.xrayUuid),
      },
    },
  }));
  const usernameById = new Map(users.map((u) => [u.id, u.username]));
  for (const peer of wgPeers) {
    const awgIp = awgIpByDevice.get(peer.deviceId);
    const wgIp = wgIpByDevice.get(peer.deviceId);
    // Nothing allocated on either profile means this node serves no wg at all,
    // or the allocator failed for this device. Either way the record would be
    // a no-op on arrival, so don't spend a round-trip on it.
    if (!awgIp && !wgIp) continue;
    items.push({
      label: `${usernameById.get(peer.userId) ?? peer.userId}/device`,
      req: {
        userId: peer.deviceId,
        // shortId and username belong to the person, not the credential; the
        // wg adapters read neither. Kept non-empty because `mieru` gates on a
        // blank username and an empty string there would read as a bug.
        shortId: '',
        username: usernameById.get(peer.userId) ?? '',
        credentials: {
          amneziawgPublicKey: peer.publicKey,
          amneziawgAllowedIp: awgIp,
          // One device key, its own subnet's address per flavour (see
          // resolveWgProfile above).
          wireguardPublicKey: peer.publicKey,
          wireguardAllowedIp: wgIp,
          // Sent only where the profile turned preshared keys on, and only
          // if the device actually has one. `undefined` is the meaningful
          // value: the node writes no PresharedKey line, and the client
          // config built from the same two conditions writes none either.
          // The two MUST agree - a peer whose key differs from its client's
          // cannot complete a handshake, and nothing in either log says why.
          amneziawgPresharedKey:
            awgProfile?.presharedKey && peer.presharedKey ? peer.presharedKey : undefined,
          wireguardPresharedKey:
            wgProfile?.presharedKey && peer.presharedKey ? peer.presharedKey : undefined,
        },
      },
    });
  }

  for (let i = 0; i < items.length; i += ADD_USER_CHUNK) {
    const chunk = items.slice(i, i + ADD_USER_CHUNK);
    const results = await Promise.allSettled(chunk.map((it) => transport.addUser(it.req)));
    for (let j = 0; j < results.length; j++) {
      const r = results[j]!;
      if (r.status === 'rejected') {
        chunkFailed++;
        const detail = r.reason instanceof Error ? r.reason.message : String(r.reason);
        getLogger().info(
          `[worker:inbound-sync] addUser ${chunk[j]!.label} to ${node.name} FAILED: ${detail}`,
        );
      }
    }
  }
  getLogger().info(
    `[worker:inbound-sync] user sync to ${node.name} done (${items.length - chunkFailed}/${items.length} ok, ${users.length} user(s) + ${items.length - users.length} device record(s))`,
  );

  // End-of-job dirty check: if an admin edit landed during the push window,
  // the event handler re-SET the flag we cleared above. Re-enqueue so the
  // intermediate edit doesn't get silently lost behind BullMQ's per-jobId
  // active-job dedupe.
  const stillDirty = await redis.getdel(inboundDirtyKey(nodeId)).catch(() => null);
  if (stillDirty) {
    void inboundSyncQueue.add(
      'applyNodeInbounds',
      { nodeId },
      { jobId: `apply-${nodeId}` },
    );
  }
}

// ───── Worker ─────

export function startInboundSyncWorker(): Worker<ApplyNodeInboundsJobData> {
  return new Worker<ApplyNodeInboundsJobData>(
    QUEUE_NAME,
    async (job: Job<ApplyNodeInboundsJobData>) => {
      switch (job.name) {
        case 'applyNodeInbounds': {
          await applyInboundsForNode(job.data.nodeId);
          break;
        }
        default:
          throw new Error(`Unknown job name: ${job.name}`);
      }
    },
    {
      connection: queueRedis,
      // One node at a time per worker, applyInbounds restarts the protocol
      // server, parallel restarts on the same node would race. Different
      // nodes can still go in parallel because they're distinct job IDs.
      concurrency: 5,
    },
  );
}
