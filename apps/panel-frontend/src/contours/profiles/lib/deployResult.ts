import { adapterRefusal, type AdapterRefusal } from '@/lib/domain/adapterSlot';
import { profileNotOnNode, type ProfileNotOnNode } from '@/lib/domain/hosts';

/**
 * What a deploy over several nodes came to, binding by binding.
 *
 * The bindings go out at once, and the 409s about a node's adapter
 * (ADAPTER_SLOT_TAKEN, MIERU_MTU_MISMATCH) do not name the node on POST
 * /api/bindings. So each refusal is matched to the node it was SENT for, and
 * said under that node; the rest of the deploy stands (A-055 tail). Any other
 * failure is handed back as `other` for the window's usual reading.
 */
export interface DeployOutcome {
  created: number;
  deleted: number;
  /** nodeId -> the refusal its binding met. */
  refused: Map<string, AdapterRefusal>;
  /** nodeId -> PROFILE_DOES_NOT_RUN_ON_NODE its binding met (A-246), said under that node. */
  notOnNode: Map<string, ProfileNotOnNode>;
  /** The first failure that is neither of the above, if any. */
  other: unknown;
}

export function deployOutcome(
  toCreate: readonly string[],
  creates: readonly PromiseSettledResult<unknown>[],
  deletes: readonly PromiseSettledResult<unknown>[],
): DeployOutcome {
  const refused = new Map<string, AdapterRefusal>();
  const notOnNode = new Map<string, ProfileNotOnNode>();
  let other: unknown = null;
  let created = 0;
  creates.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      created += 1;
      return;
    }
    const nodeId = toCreate[i];
    const a = adapterRefusal(r.reason);
    const n = a ? null : profileNotOnNode(r.reason);
    if (a && nodeId !== undefined) refused.set(nodeId, a);
    else if (n && nodeId !== undefined) notOnNode.set(nodeId, n);
    else if (other === null) other = r.reason;
  });
  let deleted = 0;
  for (const r of deletes) {
    if (r.status === 'fulfilled') deleted += 1;
    else if (other === null) other = r.reason;
  }
  return { created, deleted, refused, notOnNode, other };
}

/** Whether any binding was refused or anything else failed: then the window stays open and says it. */
export function deployFailed(o: DeployOutcome): boolean {
  return o.refused.size > 0 || o.notOnNode.size > 0 || o.other !== null;
}

/** Thrown by the deploy when anything failed, so the window reads it in onError. */
export class DeployIncomplete extends Error {
  readonly outcome: DeployOutcome;
  constructor(outcome: DeployOutcome) {
    super('deploy incomplete');
    this.name = 'DeployIncomplete';
    this.outcome = outcome;
  }
}
