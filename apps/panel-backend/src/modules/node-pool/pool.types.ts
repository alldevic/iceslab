// Cold pool + hotswap: when a node that still answers stops carrying traffic
// (node.anomaly), promote a diverse spare, carry the burned node's inbounds
// onto it and retire the burned one, absorbing a lost IP by rotation.
//
// This file and pool.policy.ts / pool.hotswap.ts are the pure core: pick a
// spare and drive the swap. The I/O (the pool query, the bootstrap token, the
// ansible run, the status flips, the carried bindings) is injected through
// HotswapDeps and lives in pool.service.ts. Off by default: nothing runs unless
// NODE_POOL_HOTSWAP_ENABLED.

import type { AnomalySeverity } from '../stats/stats.anomaly.js';

export type { AnomalySeverity };

/**
 * A candidate replacement from the cold pool: a node in status `disabled` that
 * has never redeemed a bootstrap token (no agent ever ran, so its IP has not
 * been exposed) and is not burned. `asn`/`provider` are diversity labels from
 * `hardening.pool`.
 */
export interface SpareNode {
  id: string;
  name: string;
  /** Autonomous system, e.g. "AS24940". null = unknown. */
  asn: string | null;
  /** Hosting provider slug, e.g. "hetzner". null = unknown. */
  provider: string | null;
  /** ISO country code, e.g. "DE". null = unknown. */
  countryCode: string | null;
  /** Cost weight, the node's consumption multiplier (lower = cheaper). */
  consumptionMultiplier: number;
  /** Optional current load hint; lower = better. */
  load?: number;
}

/** What we know about the burned node we are replacing. */
export interface BurnedNode {
  id: string;
  asn: string | null;
  provider: string | null;
  countryCode: string | null;
}

/** The node.anomaly payload (lib/infra/event-bus.ts). */
export interface AnomalyEvent {
  nodeId: string;
  severity: AnomalySeverity;
  bytesThisPoll: number;
  expectedBaseline: number;
  activeUsers: number;
  droppedUsers: number;
}

export interface HotswapConfig {
  /** Master switch. false (default) → the controller never acts. */
  enabled: boolean;
  /** Minimum severity that may start a swap. */
  minSeverity: AnomalySeverity;
  /**
   * How long an incident has to last, uncleared, before the node is swapped.
   * The sensor raises node.anomaly once per incident and node.anomaly-cleared
   * when it ends, so "still not cleared after this long" is the confirmation.
   * Counting events instead would never confirm a node blocked for good: it
   * raises exactly one.
   */
  confirmMs: number;
  /** After a swap, ignore further anomalies for that node for this long. */
  cooldownMs: number;
}

export const DEFAULT_HOTSWAP_CONFIG: HotswapConfig = {
  enabled: false,
  minSeverity: 'critical',
  confirmMs: 5 * 60 * 1000,
  cooldownMs: 60 * 60 * 1000,
};

/** What a swap carried onto the spare, for the operator's alert. */
export interface CarryReport {
  carried: number;
  total: number;
  /** One line per thing that did not carry, in words. */
  notes: string[];
}

/** Injected side effects. */
export interface HotswapDeps {
  /** Make the spare a node: its cores, a token, the install, out of `disabled`. */
  promote: (spare: SpareNode, burnedId: string) => Promise<void>;
  /** Carry what the burned node served onto the spare. */
  repoint: (burnedId: string, spareId: string) => Promise<CarryReport>;
  /** Retire the burned node: status disabled + its IP marked burned. */
  retire: (burnedId: string) => Promise<void>;
  /** The current cold pool and the burned node's labels. */
  loadPool: (burnedId: string) => Promise<{ spares: SpareNode[]; burned: BurnedNode | null }>;
  /** Run `fn` after `ms`. Production: an unref'd setTimeout. */
  schedule: (fn: () => void, ms: number) => void;
  /** Injectable clock (ms). */
  now: () => number;
  /** Tell the operator (lib/notify). */
  notify: (event: SwapNotice) => void;
  log?: (msg: string) => void;
}

export type SwapNotice =
  | { kind: 'swapped'; burnedId: string; spareId: string; report: CarryReport }
  | { kind: 'no-spare'; burnedId: string }
  | { kind: 'failed'; burnedId: string; spareId: string; stage: 'promote' | 'repoint' | 'retire'; error: string };

/** Outcome of one confirmation. */
export interface SwapResult {
  acted: boolean;
  reason: 'disabled' | 'cleared' | 'cooldown' | 'no-burned' | 'no-spare' | 'failed' | 'swapped';
  spareId?: string;
}
