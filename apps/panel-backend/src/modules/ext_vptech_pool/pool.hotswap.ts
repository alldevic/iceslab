import {
  type AnomalyEvent,
  type AnomalySeverity,
  type BurnedNode,
  type HotswapConfig,
  type HotswapDeps,
  type SpareNode,
  type SwapResult,
} from './pool.types.js';
import { pickSpare } from './pool.policy.js';

// F2 — hotswap state machine + debounce. Consumes node.anomaly events and, when
// a node is genuinely down (sustained → enough anomalies → not in cooldown),
// promotes a diverse spare, repoints users onto it, and retires the burned node.
// PURE-ish: all I/O and the clock are injected (HotswapDeps), so it is fully
// unit-testable. Off-by-default via HotswapConfig.enabled.

const SEVERITY_RANK: Record<AnomalySeverity, number> = { warning: 1, critical: 2 };

interface NodeState {
  /** Timestamps of recent anomalies (within windowMs), oldest→newest. */
  anomalies: number[];
  /** When the last swap for this node completed; gates the cooldown. */
  lastSwapAt?: number;
}

/**
 * Drives at-most-one swap per node per cooldown window. Holds per-node debounce
 * state in memory (like U7's anomaly debounce). A single instance handles all
 * nodes. `burnedLabelsFor` resolves the burned node's diversity labels (AS/
 * provider/country) for spare selection — injected because that lookup is a DB
 * read that is deferred along with the rest of the wiring.
 */
export class HotswapController {
  private readonly state = new Map<string, NodeState>();

  constructor(
    private readonly cfg: HotswapConfig,
    private readonly deps: HotswapDeps,
  ) {}

  /**
   * Process one node.anomaly event against the current cold pool. Returns what
   * happened. Acts (promote→repoint→retire) only when enabled, severity is high
   * enough, the anomaly has recurred `triggerCount` times within `windowMs`,
   * the node is not in post-swap cooldown, and a spare exists.
   */
  async onAnomaly(
    ev: AnomalyEvent,
    spares: SpareNode[],
    burned: BurnedNode,
  ): Promise<SwapResult> {
    if (!this.cfg.enabled) return { acted: false, reason: 'disabled' };
    if (SEVERITY_RANK[ev.severity] < SEVERITY_RANK[this.cfg.minSeverity]) {
      return { acted: false, reason: 'below-severity' };
    }

    const now = this.deps.now();
    const st = this.state.get(ev.nodeId) ?? { anomalies: [] };

    if (st.lastSwapAt !== undefined && now - st.lastSwapAt < this.cfg.cooldownMs) {
      return { acted: false, reason: 'cooldown' };
    }

    // Record this anomaly and drop ones outside the window.
    st.anomalies = st.anomalies.filter((t) => now - t < this.cfg.windowMs);
    st.anomalies.push(now);
    this.state.set(ev.nodeId, st);

    if (st.anomalies.length < this.cfg.triggerCount) {
      return { acted: false, reason: 'debouncing' };
    }

    const spare = pickSpare(spares, burned);
    if (!spare) {
      this.deps.log?.(`[hotswap] node ${ev.nodeId} down but no spare in cold pool`);
      return { acted: false, reason: 'no-spare' };
    }

    this.deps.log?.(
      `[hotswap] swapping burned node ${ev.nodeId} → spare ${spare.id} (${spare.name}, asn=${spare.asn})`,
    );
    await this.deps.promote(spare);
    await this.deps.repoint(ev.nodeId, spare.id);
    await this.deps.retire(ev.nodeId);

    // Reset debounce + start cooldown so a flapping node isn't swapped repeatedly.
    this.state.set(ev.nodeId, { anomalies: [], lastSwapAt: this.deps.now() });
    return { acted: true, reason: 'swapped', spareId: spare.id };
  }

  /** Called when a node recovers on its own — clear its debounce so a future
   *  outage starts counting fresh (mirrors U7's re-arm). Cooldown is preserved. */
  onRecovery(nodeId: string): void {
    const st = this.state.get(nodeId);
    if (st) st.anomalies = [];
  }

  /** Test/diagnostic helper: pending anomaly count for a node within the window. */
  pendingAnomalies(nodeId: string): number {
    return this.state.get(nodeId)?.anomalies.length ?? 0;
  }
}
