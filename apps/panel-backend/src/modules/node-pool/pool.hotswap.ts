import type { AnomalyEvent, AnomalySeverity, HotswapConfig, HotswapDeps, SwapResult } from './pool.types.js';
import { pickSpare } from './pool.policy.js';

// The hotswap state machine. node.anomaly opens an incident for a node;
// node.anomaly-cleared closes it. An incident still open `confirmMs` later is
// confirmed, and then a diverse spare is promoted, the burned node's inbounds
// carried onto it and the burned node retired. All I/O and the clock are
// injected (HotswapDeps), so it is unit-testable as it stands.

const SEVERITY_RANK: Record<AnomalySeverity, number> = { warning: 1, critical: 2 };

interface NodeState {
  /** The open incident, by the time it opened; undefined when none. */
  openedAt?: number;
  /** When the last swap for this node completed; gates the cooldown. */
  lastSwapAt?: number;
}

/**
 * At most one swap per node per cooldown, and one swap at a time across the
 * fleet: two nodes burned in the same minute must not both pick the same spare.
 */
export class HotswapController {
  private readonly state = new Map<string, NodeState>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly cfg: HotswapConfig,
    private readonly deps: HotswapDeps,
  ) {}

  /** Open an incident and schedule its confirmation. */
  onAnomaly(ev: AnomalyEvent): 'disabled' | 'below-severity' | 'cooldown' | 'pending' {
    if (!this.cfg.enabled) return 'disabled';
    if (SEVERITY_RANK[ev.severity] < SEVERITY_RANK[this.cfg.minSeverity]) return 'below-severity';
    const now = this.deps.now();
    const st = this.state.get(ev.nodeId) ?? {};
    if (st.lastSwapAt !== undefined && now - st.lastSwapAt < this.cfg.cooldownMs) return 'cooldown';
    if (st.openedAt === undefined) {
      st.openedAt = now;
      this.state.set(ev.nodeId, st);
      const openedAt = now;
      this.deps.schedule(() => {
        void this.confirm(ev.nodeId, openedAt);
      }, this.cfg.confirmMs);
    }
    return 'pending';
  }

  /** The node carries traffic again: its incident is over, nothing to confirm. */
  onCleared(nodeId: string): void {
    const st = this.state.get(nodeId);
    if (st) st.openedAt = undefined;
  }

  /**
   * The scheduled check. Swaps only when the SAME incident is still open: one
   * that cleared and reopened in between has its own confirmation coming.
   */
  confirm(nodeId: string, openedAt: number): Promise<SwapResult> {
    const run = this.queue.then(() => this.confirmNow(nodeId, openedAt));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async confirmNow(nodeId: string, openedAt: number): Promise<SwapResult> {
    const st = this.state.get(nodeId);
    if (!st || st.openedAt !== openedAt) return { acted: false, reason: 'cleared' };
    st.openedAt = undefined;

    const { spares, burned } = await this.deps.loadPool(nodeId);
    if (!burned) return { acted: false, reason: 'no-burned' };
    const spare = pickSpare(spares, burned);
    if (!spare) {
      this.deps.log?.(`node ${nodeId} confirmed down, but the cold pool is empty`);
      this.deps.notify({ kind: 'no-spare', burnedId: nodeId });
      return { acted: false, reason: 'no-spare' };
    }

    this.deps.log?.(`swapping ${nodeId} for spare ${spare.id} (${spare.name}, asn=${spare.asn ?? '?'})`);
    let stage: 'promote' | 'repoint' | 'retire' = 'promote';
    try {
      await this.deps.promote(spare, nodeId);
      stage = 'repoint';
      const report = await this.deps.repoint(nodeId, spare.id);
      stage = 'retire';
      await this.deps.retire(nodeId);
      st.lastSwapAt = this.deps.now();
      this.deps.notify({ kind: 'swapped', burnedId: nodeId, spareId: spare.id, report });
      return { acted: true, reason: 'swapped', spareId: spare.id };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.deps.log?.(`swap ${nodeId} → ${spare.id} failed at ${stage}: ${error}`);
      this.deps.notify({ kind: 'failed', burnedId: nodeId, spareId: spare.id, stage, error });
      return { acted: false, reason: 'failed', spareId: spare.id };
    }
  }

  /** Diagnostics: whether a node has an incident waiting for confirmation. */
  pending(nodeId: string): boolean {
    return this.state.get(nodeId)?.openedAt !== undefined;
  }
}
