import { adapterRefusal, type AdapterRefusal } from '@/lib/domain/adapterSlot';

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
  /** The first failure that is not about an adapter, if any. */
  other: unknown;
}

export function deployOutcome(
  toCreate: readonly string[],
  creates: readonly PromiseSettledResult<unknown>[],
  deletes: readonly PromiseSettledResult<unknown>[],
): DeployOutcome {
  const refused = new Map<string, AdapterRefusal>();
  let other: unknown = null;
  let created = 0;
  creates.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      created += 1;
      return;
    }
    const a = adapterRefusal(r.reason);
    const nodeId = toCreate[i];
    if (a && nodeId !== undefined) refused.set(nodeId, a);
    else if (other === null) other = r.reason;
  });
  let deleted = 0;
  for (const r of deletes) {
    if (r.status === 'fulfilled') deleted += 1;
    else if (other === null) other = r.reason;
  }
  return { created, deleted, refused, other };
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
