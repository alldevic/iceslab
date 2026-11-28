import { readIpv6Mode, type NodeCores } from '@iceslab/shared';
import { getLogger } from '../../lib/infra/logger.js';
import { nodeExitsViaIpv6 } from '../nodes/node-core-gate.js';
import { getEntryNodeIdsByExitNode } from './cascade.service.js';

/**
 * 19.15: an exit's IPv6 answer reaches its entries at once.
 *
 * An entry reads its exits' facts whenever its push is built (`chainCarriesIpv6`:
 * the tunnel's IPv6 address and the TPROXY6 steering), but nothing asked it to
 * build one when an exit's facts moved. The exit's own push was queued by a mode
 * edit (`node.updated`), the entries' were not, and a changed `cores.ipv6` queued
 * none at all; the entry caught up at its next push for another reason, 432 s
 * later on the 18.12 stand.
 *
 * What is compared is the answer the entries are drawn by (`nodeExitsViaIpv6`),
 * not the facts: a `cores.ipv6` write that leaves it as it was, or a mode edit
 * that does (`on` over an exit that already left by IPv6), pushes nobody.
 */
export interface ExitIpv6State {
  cores: NodeCores | null | undefined;
  /** The stored `ipv6Mode` column, or a value about to be written. */
  ipv6Mode: unknown;
}

export function exitIpv6Moved(before: ExitIpv6State, after: ExitIpv6State): boolean {
  return (
    nodeExitsViaIpv6(before.cores, readIpv6Mode(before.ipv6Mode)) !==
    nodeExitsViaIpv6(after.cores, readIpv6Mode(after.ipv6Mode))
  );
}

/**
 * Queue a push for every entry of an enabled, live cascade the node exits.
 * Returns the entries queued. Never throws: the caller's own write is done and
 * a failed enqueue is only the old, slower catch-up.
 */
export async function pushEntriesOfExit(exitNodeId: string): Promise<string[]> {
  try {
    const entries = [...(await getEntryNodeIdsByExitNode([exitNodeId]))].filter((id) => id !== exitNodeId);
    if (entries.length === 0) return [];
    // Imported where used: the queue module reaches the cascade renderers, which
    // reach this module's callers.
    const { enqueueNodePush } = await import('../inbounds/inbounds.queue.js');
    for (const id of entries) await enqueueNodePush(id);
    return entries;
  } catch (err) {
    getLogger().warn({ err, nodeId: exitNodeId }, '[cascade] pushing the entries of an exit whose IPv6 moved failed');
    return [];
  }
}

/** Both steps: push the entries when the answer moved. */
export async function pushEntriesIfExitIpv6Moved(
  exitNodeId: string,
  before: ExitIpv6State,
  after: ExitIpv6State,
): Promise<string[]> {
  return exitIpv6Moved(before, after) ? pushEntriesOfExit(exitNodeId) : [];
}
