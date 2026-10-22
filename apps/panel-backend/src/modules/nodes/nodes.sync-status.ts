import { prisma } from '../../prisma.js';

/**
 * "Saved, but not applied yet" for one node.
 *
 * Saving anything that feeds a node's inbound set (a binding, the profile
 * behind it, one of its hosts, a cascade it is a hop of) queues an async push.
 * Until 2026-09-11 only cascades could tell a landed push from one in flight,
 * because only getCascadeStatus did the comparison; a node card had nothing to
 * draw the state from, so a save looked identical whether it had reached the
 * machine or not.
 */

/**
 * The time rule, still used by the cascade status: a node acknowledged a
 * cascade save when its last acknowledged push was BUILT after the save.
 *
 * Strictly greater, not >=: an acknowledgement stamped in the same millisecond
 * as the save is the PREVIOUS push. Since A-162 the stamp is the moment the
 * request was built, not when the agent answered, so an edit saved during a
 * push is later than the stamp of that push.
 */
export function isConfigApplied(
  lastInboundSyncAt: Date | null | undefined,
  savedAt: Date,
): boolean {
  return !!lastInboundSyncAt && lastInboundSyncAt > savedAt;
}

export interface NodeSyncStatusDto {
  /** Last acknowledged push (when it was built), ISO. null = this node has
   *  never taken a config. */
  lastInboundSyncAt: string | null;
  /** When the config this node should be running was last asked for, ISO. */
  configChangedAt: string;
  /** The node acknowledged the revision it is meant to run. */
  applied: boolean;
  /** An unapplied config on an offline node is waiting, not stuck: the poll
   *  cron re-pushes when it comes back. The card says different things about
   *  the two, so the answer travels with the flag. */
  online: boolean;
}

/**
 * Whether this node runs the config it should, as a REVISION (A-162).
 *
 * Every event that asks for a push grows desiredRevision; the push writes the
 * revision it read before building the request into appliedRevision once the
 * agent answered ok. So applied is appliedRevision >= desiredRevision, with no
 * clock involved.
 *
 * It replaced a comparison of lastInboundSyncAt with the max updatedAt of the
 * node's bindings, profiles, hosts and cascades. That one called an edit saved
 * during a push "applied" (the stamp was the agent's answer, later than the
 * edit), read every host edit as a pending push although hosts are not pushed,
 * and flipped on two writes landing in one millisecond (CI, 22.10).
 */
export async function getNodeSyncStatus(nodeId: string): Promise<NodeSyncStatusDto | null> {
  const node = await prisma.node.findFirst({
    where: { id: nodeId, deletedAt: null },
    select: {
      createdAt: true,
      lastInboundSyncAt: true,
      status: true,
      desiredRevision: true,
      appliedRevision: true,
      configChangedAt: true,
    },
  });
  if (!node) return null;

  return {
    lastInboundSyncAt: node.lastInboundSyncAt?.toISOString() ?? null,
    configChangedAt: (node.configChangedAt ?? node.createdAt).toISOString(),
    applied: node.lastInboundSyncAt !== null && node.appliedRevision >= node.desiredRevision,
    online: node.status === 'online',
  };
}
