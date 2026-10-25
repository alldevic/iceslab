import type { Prisma } from '../../generated/prisma/client.js';

/**
 * The bindings a push sends to a node: enabled, of an enabled profile. One
 * filter for the push (inbounds.queue.ts) and for every report about what the
 * node runs (A-204, nodeUserScopeGaps), so the two cannot drift: a report that
 * counted a disabled profile's binding named a gap the node does not have (a
 * disabled mtproto as a shared secret, a lone mieru as shared users because
 * of a second one in a disabled profile).
 */
export function pushedBindingsWhere(nodeId: string): Prisma.ProfileNodeBindingWhereInput {
  return { nodeId, enabled: true, profile: { enabled: true } };
}
