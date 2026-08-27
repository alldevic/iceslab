import { eventBus } from '../../lib/event-bus.js';
import { nodeUsersQueue } from '../users/users.queue.js';

/**
 * Register node-related event handlers. Mirrors users/users.events.ts.
 *
 * Today the only handler is `node.created` → enqueue a backfillNode job
 * so existing active users land on the freshly-registered node. Without
 * this, a new node stays empty until each user is mutated again, caught
 * live during the 2026-05-06 VPS test (Hysteria auth rejected pre-existing
 * user because adapter map was empty on the new node).
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
 * Doubled here means two `backfillNode` jobs for one new node: the whole active
 * user set pushed to it twice.
 */
let registered = false;

export function registerNodeEventHandlers(): void {
  if (registered) return;
  registered = true;
  eventBus.on('node.created', async ({ nodeId, nodeName }) => {
    console.log(`[event] node.created: ${nodeName} (${nodeId})`);
    await nodeUsersQueue.add('backfillNode', { nodeId });
  });
}
