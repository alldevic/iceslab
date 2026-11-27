import { eventBus } from '../../lib/infra/event-bus.js';
import { prisma } from '../../prisma.js';
import { recomputeAfterChange } from './routing-presets.nodes.js';

/**
 * 19.11: the DNS rules a node carries (nodes.preset_dns_rules) follow what the
 * presets reach, and what they reach moves with squads and bindings. An
 * assignment is recomputed by its own request (and refused there); these are the
 * changes that have already happened, so nothing is refused: the node keeps the
 * rules of the preset that came first, the clashing rule is left out and written
 * on the node (preset_dns_conflicts) for the screen of 19.12.
 *
 * Every event ends in one recompute of the nodes it can touch, which only writes
 * and pushes the nodes whose carried rules changed: an event that changes
 * nothing is silent, and the same event twice does the work once.
 */

let registered = false;

/** One at a time inside the process; across processes the recompute holds an advisory lock. */
let chain: Promise<unknown> = Promise.resolve();

/** For tests: resolves when every recompute the events so far started has ended. */
export async function routingPresetEventsIdle(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  let seen: Promise<unknown>;
  do {
    seen = chain;
    await seen;
  } while (seen !== chain);
}

export function registerRoutingPresetEventHandlers(): void {
  if (registered) return;
  registered = true;

  const run = (reason: string, scope: { nodeIds?: readonly string[] } | (() => Promise<{ nodeIds?: readonly string[] } | null>)): void => {
    chain = chain
      .then(async () => {
        const resolved = typeof scope === 'function' ? await scope() : scope;
        if (resolved === null) return;
        if (resolved.nodeIds?.length === 0) return;
        const pushed = await recomputeAfterChange(resolved);
        if (pushed.length > 0) console.log(`[event] ${reason}: carried DNS rules changed on ${pushed.length} node(s)`);
      })
      .catch((err: unknown) => console.error(`[event] ${reason}: recompute of the carried DNS rules failed`, err));
  };

  // A new node takes the panel-wide rules and those of the presets that reach it.
  eventBus.on('node.created', ({ nodeId }) => run('node.created', { nodeIds: [nodeId] }));
  // Squad: its profiles (and with them its nodes) or its members' reach moved.
  eventBus.on('squad.changed', () => run('squad.changed', {}));
  for (const ev of ['binding.created', 'binding.updated', 'binding.deleted'] as const) {
    eventBus.on(ev, ({ nodeId }) => run(ev, { nodeIds: [nodeId] }));
  }
  eventBus.on('profile.updated', ({ profileId }) =>
    run('profile.updated', async () => ({
      nodeIds: (await prisma.profileNodeBinding.findMany({ where: { profileId }, select: { nodeId: true } })).map((b) => b.nodeId),
    })),
  );
  eventBus.on('profile.deleted', ({ affectedNodeIds }) => run('profile.deleted', { nodeIds: affectedNodeIds }));
  // A user with an own preset changed squads (the preset's nodes follow), or was deleted (it no longer reaches any).
  eventBus.on('user.updated', ({ userId, changes }) => {
    if (!changes.includes('groupIds')) return;
    run('user.updated', async () => {
      const u = await prisma.user.findUnique({ where: { id: userId }, select: { customRoutingPresetId: true } });
      return u?.customRoutingPresetId ? {} : null;
    });
  });
  eventBus.on('user.deleted', ({ userId }) =>
    run('user.deleted', async () => {
      const u = await prisma.user.findUnique({ where: { id: userId }, select: { customRoutingPresetId: true } });
      return u?.customRoutingPresetId ? {} : null;
    }),
  );
}
