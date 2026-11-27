import { dnsReach, type DnsExecution } from '@/lib/domain/dnsReach';
import type { PresetNode, PresetNodes } from '@/lib/domain/routePolicies';

/**
 * 19.12: what the preset screen says about the nodes that get the DNS rules of
 * a preset. Pure: the answer of GET /api/routing-presets/:id/nodes in, counts
 * and a mark per node out.
 *
 * «Executes» is the node's cores, as on the DNS page (`dnsReach`): a node that
 * has not reported its cores is «unknown», never folded into «does not
 * execute». A node where some cores execute and others do not is `partial`.
 */
export type NodeDnsMark = DnsExecution | 'partial';

export function nodeDnsMark(node: Pick<PresetNode, 'cores'>): NodeDnsMark {
  const reach = dnsReach(node.cores);
  return reach.state === 'executes' && reach.notExecuting.length > 0 ? 'partial' : reach.state;
}

export interface PresetNodesSummary {
  /** Nodes the preset reaches (all nodes for a built-in preset). */
  nodes: number;
  /** Of them, nodes that carry at least one of its rules. */
  receiving: number;
  sent: number;
  waiting: number;
  /** No core executes the DNS setting / only some do / the node did not say. */
  notExecuting: number;
  partial: number;
  unknown: number;
  /** Nodes where a rule is covered by the node's own DNS. */
  overridden: number;
  /** Nodes where a rule was left out for a conflict or the 16-server limit (a change of squads or nodes, 19.11). */
  leftOut: number;
  /** Nodes where a rule is not carried because the core has no such server kind (DoT). */
  serverKind: number;
}

export function summarizePresetNodes(list: Pick<PresetNodes, 'nodes'>): PresetNodesSummary {
  const out: PresetNodesSummary = { nodes: list.nodes.length, receiving: 0, sent: 0, waiting: 0, notExecuting: 0, partial: 0, unknown: 0, overridden: 0, leftOut: 0, serverKind: 0 };
  for (const n of list.nodes) {
    if (n.carried > 0) out.receiving += 1;
    if (n.state === 'sent') out.sent += 1;
    if (n.state === 'waiting') out.waiting += 1;
    // A node that carries nothing of this preset has no DNS rule to miss.
    if (n.carried > 0) {
      const mark = nodeDnsMark(n);
      if (mark === 'not-executes') out.notExecuting += 1;
      else if (mark === 'partial') out.partial += 1;
      else if (mark === 'unknown') out.unknown += 1;
    }
    if (n.skipped.some((s) => s.kind === 'manual')) out.overridden += 1;
    if (n.skipped.some((s) => s.kind === 'conflict' || s.kind === 'limit')) out.leftOut += 1;
    if (n.skipped.some((s) => s.kind === 'server-kind')) out.serverKind += 1;
  }
  return out;
}
