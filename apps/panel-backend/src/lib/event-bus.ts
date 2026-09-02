import { EventEmitter } from 'node:events';
import { getLogger } from './logger.js';

/**
 * All domain events in the panel.
 *
 * Naming convention: '<entity>.<action>' (past tense).
 * When adding a new event, add it here with its payload type.
 */
export interface DomainEventMap {
  'user.created':         { userId: string; username: string };
  'user.updated':         { userId: string; changes: string[] };
  'user.status-changed':  { userId: string; from: string; to: string };
  'user.deleted':         { userId: string };
  'user.traffic-reset':   { userId: string; previousUsedBytes: bigint };
  // wg-devices.changed → a WireGuard/AmneziaWG device was minted or revoked,
  // so the peer set on every wg-bearing node is stale. Its own event rather
  // than a user.* one because it fires on a path where the user did not
  // change at all: a subscription fetch that tops the buyer back up to their
  // device count mints a keypair, hands out the config, and until this event
  // existed told no node about it. See wg-devices.service.ts.
  'wg-devices.changed':   { userId: string; reason: string };
  // node.created → backfill all active users to this node. Required because
  // an empty new node otherwise stays empty until each existing user is
  // mutated again. Caught live during slice-23 VPS test 2026-05-06.
  'node.created':         { nodeId: string; nodeName: string };
  // node.updated → a node field that changes the pushed config (currently the
  // self-steal REALITY domain) was edited; re-push the inbound set so the live
  // node config matches. Without this a Node.domain edit only self-heals on an
  // unrelated binding/profile edit or an agent restart. Caught in review 2026-06-17.
  'node.updated':         { nodeId: string; nodeName: string };
  // node.changed → ANY node field was written. Deliberately separate from
  // node.updated: that one re-pushes the inbound set, which restarts the
  // protocol server and drops live connections, so it must stay reserved for
  // edits the agent actually needs. Renaming a node is no reason to disconnect
  // its users. This one only invalidates read caches, so it is safe to fire on
  // every edit, including the ones that merely change what a subscription
  // renders (address, region, name).
  'node.changed':         { nodeId: string };
  // node.deleted → the node and its bindings are gone; drop it from the
  // subscription read caches at once rather than serving a dead endpoint for
  // the rest of the cache TTL.
  'node.deleted':         { nodeId: string };
  // node.status-changed → the liveness poller saw a node go up or down. Kept
  // separate from node.changed on purpose: this fires on a machine's own
  // behaviour rather than on an operator edit, and it must NOT re-push config
  // (a node flapping would otherwise restart cores across the fleet). Its only
  // job is to drop read caches, because once liveness filters the subscription
  // a stale cache keeps handing out a node that is already down.
  'node.status-changed':  { nodeId: string; from: string; to: string };
  // host.changed → a Host row (the per-binding public endpoint override:
  // address, port, priority, enabled, disableForFormats) was created, edited,
  // deleted or reordered. Affects subscription OUTPUT only, never the config
  // pushed to a node, so read-cache invalidation is the whole job. No payload:
  // a reorder moves many rows at once and naming one of them would mislead.
  'host.changed':         Record<string, never>;
  // squad.changed → a squad's ACL moved: which profiles it grants, which of
  // their hosts it hands out, which policies it grants. Subscription OUTPUT
  // only, never a node config, so like host.changed this exists purely to bust
  // read caches. The binding cache is keyed by squad-set, but its CONTENTS
  // depend on what those squads reach, so a squad edit can make a cached entry
  // wrong without changing its key. Caught 2026-07-31 by the first test that
  // narrowed a squad and got a stale, empty result.
  'squad.changed':        { squadId: string };
  // `inbound.{created,updated,deleted}` used to live here (slice 24: push the
  // affected node's inbound set over mTLS). Removed 2026-08-27: the Inbound
  // CRUD they announced is gone — there is no /api/inbounds route, no service,
  // and prisma.inbound is never queried — so nothing had emitted them for
  // months while three handlers stayed subscribed, waiting. The push pipeline
  // itself is very much alive; it is driven by binding.* and profile.* below,
  // and `applyNodeInbounds` reads profileNodeBinding. Only the name is legacy.
  // Slice 27: Profiles + ProfileNodeBinding model. profile.* events fire
  // on profile-template mutations (no immediate node restart, config of
  // shared profile changed, all bound nodes need re-push). binding.* events
  // are scoped to a single node (only that node gets re-pushed).
  'profile.created':      { profileId: string };
  'profile.updated':      { profileId: string };
  'profile.deleted':      { profileId: string; affectedNodeIds: string[] };
  'binding.created':      { bindingId: string; profileId: string; nodeId: string };
  'binding.updated':      { bindingId: string; profileId: string; nodeId: string };
  'binding.deleted':      { bindingId: string; profileId: string; nodeId: string };
  // cascade.changed → a cascade's hops/enabled state changed, or it was
  // deleted. Every node that IS now or WAS a hop needs its inbound set
  // re-pushed so the xray cascade fragments (link-in/out + routing rules) get
  // injected or removed. Without this, enabling a cascade only landed in the
  // DB and never reached the nodes until an unrelated profile/binding edit
  // fired a re-push. Caught live during the first cascade field test 2026-06-17.
  'cascade.changed':      { nodeIds: string[] };
  // U7 — node traffic-anomaly sensor. A correlated drop in transferred bytes
  // AND active users on a node, sustained across polls, signals the node went
  // dark (censor-blocked or down). Generic monitoring signal; webhooks and the
  // hotswap policy subscribe. Emitted at most once per outage (re-arms after
  // recovery). severity 'critical' = near-total drop.
  'node.anomaly':         { nodeId: string; severity: 'warning' | 'critical'; bytesThisPoll: number; expectedBaseline: number; activeUsers: number; droppedUsers: number };
  // A cascade has (or no longer has) at least one exit that can carry traffic.
  // `live: 0` is the state where the entry has nowhere to send a subscriber:
  // named direction lines refuse, and since 2026-08-28 the Auto line refuses
  // too instead of quietly egressing at the entry. The panel used to say
  // nothing at all about that, which is what made the silent version possible
  // to miss. Edge-triggered off node liveness, so it fires on the flip, not
  // every poll.
  'cascade.exits-changed': { cascadeId: string; cascadeName: string; live: number; total: number };
}

type EventHandler<K extends keyof DomainEventMap> = (
  payload: DomainEventMap[K],
) => void | Promise<void>;

/**
 * Type-safe wrapper around node:events EventEmitter.
 * - `emit` and `on` are constrained to keys of DomainEventMap.
 * - Handler errors are caught and logged so they never crash the emitter.
 */
class DomainEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Allow many handlers without warnings
    this.emitter.setMaxListeners(50);
  }

  emit<K extends keyof DomainEventMap>(event: K, payload: DomainEventMap[K]): void {
    this.emitter.emit(event, payload);
  }

  /**
   * How many handlers are subscribed to one event.
   *
   * There is no `off` on this bus and there is deliberately none: every
   * subscription here lasts for the life of the process. That makes "subscribed
   * twice" a state with no way out and no symptom — both copies fire, both
   * deliveries are genuine, and `setMaxListeners(50)` above means node will not
   * even warn until the fiftieth. This is the only way to ask about it without
   * emitting an event and watching the side effects, which for these handlers
   * means writing rows and enqueuing jobs.
   */
  listenerCount<K extends keyof DomainEventMap>(event: K): number {
    return this.emitter.listenerCount(String(event));
  }

  on<K extends keyof DomainEventMap>(event: K, handler: EventHandler<K>): void {
    this.emitter.on(event, (payload: DomainEventMap[K]) => {
      void Promise.resolve()
        .then(() => handler(payload))
        .catch((err: unknown) => {
          getLogger().error({ err }, `[event-bus] handler for "${String(event)}" threw`);
        });
    });
  }
}

export const eventBus = new DomainEventBus();
