import { eventBus } from '../../lib/event-bus.js';
import { prisma } from '../../prisma.js';
import { inboundSyncQueue, inboundDirtyKey } from './inbounds.queue.js';
import { redis } from '../../lib/redis.js';

/**
 * Register inbound-related event handlers.
 *
 * `node.*`, `binding.*` and `profile.*` all collapse to a single job:
 * "recompute the full inbound set for this node and push it through mTLS."
 * Idempotent, re-firing for an unchanged set is a node-side no-op, so we don't
 * try to dedupe at the producer level.
 *
 * There were three `inbound.*` handlers here too, for an Inbound CRUD that no
 * longer exists: no route, no service, prisma.inbound queried nowhere. Nothing
 * had emitted those events for months and the handlers sat subscribed, which
 * reads exactly like a live path. Removed 2026-08-27.
 *
 * The job ID is per-node so multiple back-to-back inbound mutations on the
 * same node coalesce into one push instead of triggering N restarts.
 */
/**
 * One subscription per process. The bus has `on` and no `off`, so a second call
 * adds a SECOND handler for every event here and both keep firing forever.
 *
 * Today there is exactly one call, from `index.ts`. The guard is here because
 * the plausible refactor is moving that call into `buildApp()`, which the test
 * suite invokes per case — and because the same guard already exists in
 * webhook.events.ts for exactly this reason, on one registrar out of five. A
 * decision applied to one of five places is the shape this repository keeps
 * finding; this closes the other four.
 *
 * Doubled here means two inbound pushes per edit. The job ID is per-node so the
 * queue coalesces them, which is precisely why this would go unnoticed rather
 * than show up as visible breakage.
 */
let registered = false;

export function registerInboundEventHandlers(): void {
  if (registered) return;
  registered = true;
  const enqueue = (nodeId: string, reason: string): void => {
    console.log(`[event] ${reason}: enqueue applyInbounds for node ${nodeId}`);
    // Set a dirty flag BEFORE enqueuing. If a worker is already mid-push
    // for this node, BullMQ silently rejects the duplicate jobId, the
    // worker's end-of-job check sees this flag and re-enqueues so the
    // intermediate edit doesn't disappear. See applyInboundsForNode.
    void redis.set(inboundDirtyKey(nodeId), '1').catch(() => null);
    void inboundSyncQueue.add(
      'applyNodeInbounds',
      { nodeId },
      // Coalesce: if an `applyNodeInbounds` is already queued for this node,
      // don't add another. The currently-running one will read the latest
      // state from the DB anyway. `removeOnComplete` cleans up later.
      { jobId: `apply-${nodeId}` },
    );
  };

  // When a node is registered, also push its (currently empty) inbound set,
  // sets the node-agent into a known good state (no leftover from a previous
  // re-bootstrap) and exercises the auto-push pipeline immediately.
  eventBus.on('node.created', ({ nodeId, nodeName }) => {
    enqueue(nodeId, `node.created ${nodeName}`);
  });

  // node.updated → a config-affecting node field changed (the self-steal
  // REALITY domain). Re-push so the live node config tracks Node.domain
  // instead of drifting until an unrelated edit/restart fires.
  eventBus.on('node.updated', ({ nodeId, nodeName }) => {
    enqueue(nodeId, `node.updated ${nodeName}`);
  });

  // ───── Slice 27: Profile + Binding events ─────
  //
  // binding.* is per-(profile, node), only that node needs re-push.
  // profile.* changed shared config, every bound node needs re-push.

  eventBus.on('binding.created', ({ bindingId, nodeId }) => {
    enqueue(nodeId, `binding.created ${bindingId}`);
  });
  eventBus.on('binding.updated', ({ bindingId, nodeId }) => {
    enqueue(nodeId, `binding.updated ${bindingId}`);
  });
  eventBus.on('binding.deleted', ({ bindingId, nodeId }) => {
    enqueue(nodeId, `binding.deleted ${bindingId}`);
  });

  eventBus.on('profile.updated', ({ profileId }) => {
    void prisma.profileNodeBinding
      .findMany({ where: { profileId }, select: { nodeId: true } })
      .then((rows) => {
        const seen = new Set<string>();
        for (const r of rows) {
          if (seen.has(r.nodeId)) continue;
          seen.add(r.nodeId);
          enqueue(r.nodeId, `profile.updated ${profileId}`);
        }
      })
      .catch((err: unknown) =>
        console.error(`[event] profile.updated fan-out failed:`, err),
      );
  });

  eventBus.on('profile.deleted', ({ profileId, affectedNodeIds }) => {
    for (const nodeId of affectedNodeIds) {
      enqueue(nodeId, `profile.deleted ${profileId}`);
    }
  });

  // cascade.changed → re-push every node that is now or was a hop, so the xray
  // cascade fragments get injected (create/enable) or removed (disable/delete).
  // The cascade service computes the union of old+new hop nodes.
  eventBus.on('cascade.changed', ({ nodeIds }) => {
    for (const nodeId of nodeIds) {
      enqueue(nodeId, `cascade.changed`);
    }
  });
}
