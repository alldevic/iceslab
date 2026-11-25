import { eventBus } from '../../lib/infra/event-bus.js';
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
 * Today there is one call, from `index.ts`; the guard is for the day that call
 * moves somewhere that runs per case (buildApp() in tests).
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
