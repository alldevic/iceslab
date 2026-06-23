// F2 — cold-pool + hotswap policy (fork-only, isolated in ext_vptech_pool).
//
// This module is the PURE policy core: pick a diverse spare and drive the swap
// state machine. The real I/O (querying the cold-pool from the DB, redeeming a
// bootstrap token, running the U6 ansible promote, flipping node status,
// repointing F1 diversity) is injected via HotswapDeps and is DEFERRED — it
// needs U6/ansible + a real node. Off-by-default: nothing here runs until a
// HotswapController is constructed with enabled=true and wired to node.anomaly.

/**
 * A candidate replacement node from the cold pool. A cold node is a DB row in
 * status:'disabled' with no redeemed bootstrap token (so no agent runs and its
 * IP is not yet exposed). `asn`/`provider` are diversity labels; storage for
 * them is deferred (will live on the node, migration-free), so the pure core
 * just takes them as input.
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
  /** Cost weight from Node.consumptionMultiplier (lower = cheaper). */
  consumptionMultiplier: number;
  /** Optional current load hint (0..1 or active-user count); lower = better. */
  load?: number;
}

/** What we know about the burned (anomalous) node we're replacing. */
export interface BurnedNode {
  id: string;
  asn: string | null;
  provider: string | null;
  countryCode: string | null;
}

export type AnomalySeverity = 'warning' | 'critical';

/** The node.anomaly domain event shape (see lib/event-bus.ts). */
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
  /** Minimum severity that may trigger a swap. */
  minSeverity: AnomalySeverity;
  /** How many anomaly events for a node within `windowMs` before acting.
   *  ≥2 protects against a single transient blip (the node.anomaly event
   *  re-arms per outage, so a genuinely flapping/blocked node re-fires). */
  triggerCount: number;
  /** Sliding window for counting anomalies toward triggerCount. */
  windowMs: number;
  /** After a swap, ignore further anomalies for that node for this long. */
  cooldownMs: number;
}

export const DEFAULT_HOTSWAP_CONFIG: HotswapConfig = {
  enabled: false,
  minSeverity: 'critical',
  triggerCount: 2,
  windowMs: 15 * 60 * 1000,
  cooldownMs: 60 * 60 * 1000,
};

/** Injected side-effects. Real impls are deferred (need U6/ansible/VPS). */
export interface HotswapDeps {
  /** Promote a cold spare to active: redeem token → U6 ansible → flip status. */
  promote: (spare: SpareNode) => Promise<void>;
  /** Repoint users off the burned node onto the spare (F1 diversity stops
   *  including burned, starts including spare). */
  repoint: (burnedId: string, spareId: string) => Promise<void>;
  /** Retire the burned node: status disabled + mark IP burned. */
  retire: (burnedId: string) => Promise<void>;
  /** Injectable clock (ms). Tests pass a fake; prod passes () => Date.now(). */
  now: () => number;
  /** Optional structured logger. */
  log?: (msg: string) => void;
}

/** Outcome of feeding one anomaly event to the controller. */
export interface SwapResult {
  acted: boolean;
  /** Why nothing happened (when acted=false), or 'swapped' when it did. */
  reason:
    | 'disabled'
    | 'below-severity'
    | 'cooldown'
    | 'debouncing'
    | 'no-spare'
    | 'swapped';
  /** The chosen spare's id when acted=true. */
  spareId?: string;
}
