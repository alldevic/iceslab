import type { NodeCore } from '@/lib/domain/nodes';
import { coreLabel } from '@/contours/nodes/lib/policyReach';

/**
 * Which cores of a node execute the node's DNS setting.
 *
 * Same shape and same rules as `policyReach.ts`, for `rendersDns`: executing a
 * resolver setting is the CORE's work, and today only xray does it. On a node
 * with hysteria beside xray the setting reaches the xray clients and nobody
 * else, so the answer is a list of cores and not one word about the node.
 *
 *   executes       at least one busy core executes it.
 *   not-executes   every busy core answered, and none executes it.
 *   unknown        nobody to ask, or somebody has not answered.
 *
 * Unknown is not a soft «no». An agent older than the field sends no
 * `rendersDns`, and saying «the rule does not apply here» about a core that
 * applies it is worse than silence; a partial answer can say yes, never no.
 *
 * Input is the node's core list and nothing else, so the preset screen
 * (milestone 19.12) can call it with the cores of any node it holds.
 */
export type DnsExecution = 'executes' | 'not-executes' | 'unknown';

export interface DnsReach {
  state: DnsExecution;
  /** Busy cores that execute the setting. */
  executing: string[];
  /** Busy cores that answered «no»: the real gap in coverage. */
  notExecuting: string[];
  /** Busy cores that did not answer. Neither «yes» nor «no». */
  unknown: string[];
}

export function dnsReach(cores: NodeCore[] | null | undefined): DnsReach {
  // An idle core serves nobody, so it cannot be a core the setting misses.
  // `!== false`: a missing field is an agent older than it, not «idle».
  const busy = (cores ?? []).filter((c) => c.provisioned !== false);
  // A core that can render but is not on the machine executes nothing.
  const executes = (c: NodeCore) => c.rendersDns === true && c.installed !== false;
  const executing = busy.filter(executes);
  const notExecuting = busy.filter((c) => !executes(c) && c.rendersDns !== undefined);
  const unknown = busy.filter((c) => c.rendersDns === undefined);

  const state: DnsExecution =
    executing.length > 0 ? 'executes' : notExecuting.length > 0 && unknown.length === 0 ? 'not-executes' : 'unknown';

  return {
    state,
    executing: executing.map(coreLabel),
    notExecuting: notExecuting.map(coreLabel),
    unknown: unknown.map(coreLabel),
  };
}
