import {
  cascadeAutoProfileLabel,
  directionLineLabel,
  normaliseLineLabel,
} from '../../lib/country-flag.js';

export interface CascadeHopDto {
  id: string;
  nodeId: string;
  nodeName: string;
  position: number;
  entryProtocol: string | null;
  linkProtocol: string | null;
}

/** One step of the path, holding a POOL of interchangeable nodes. */
export interface CascadePositionDto {
  /** 0 = entry, then transits in order. */
  position: number;
  nodeIds: string[];
  entryProtocol: string | null;
  linkProtocol: string | null;
  /** E - per-node geo split, keyed by node id. Only nodes that HAVE a split
   *  appear, so an untouched pool reports an empty object. */
  egressPolicies: Record<string, unknown>;
}

/**
 * A way out of the cascade.
 *
 * ⚠ `id` matters on save: send it back for a direction that already exists and
 * it keeps its `tag`. A direction saved without its id is treated as new and
 * draws a fresh tag, which changes the link every client holding that direction
 * uses - i.e. it silently moves people to a different country. The pool is used
 * as a fallback match, but it stops working the moment the pool itself changes.
 */
export interface CascadeDirectionDto {
  id: string;
  /** Frozen identity of this direction; travels in the client's UUID. Never
   *  accepted as input, only reported. */
  tag: number;
  countryCode: string | null;
  /** The name the operator pinned for this line, or null when it is derived
   *  from the cascade name and the exit country. See the column: a derived name
   *  moves whenever the cascade is renamed, and a client that identifies a
   *  server by name answers a rename by keeping BOTH. */
  label: string | null;
  /** What a subscriber's client actually shows for this line, pinned or
   *  derived. Reported so the panel can show the operator the string their
   *  buyers see, without deriving it a second time and getting it slightly
   *  different. */
  lineLabel: string;
  /** May be empty: a direction can exist with its tag reserved and no node
   *  behind it yet. Such a direction is simply not served. */
  nodeIds: string[];
}

export interface CascadeDto {
  id: string;
  name: string;
  enabled: boolean;
  /** 'chain' (sequential) or 'balancer' (one entry, N latency-balanced exits). */
  mode: string;
  /** Hide the cascade's non-entry nodes from the raw subscription (default). */
  hideHopsFromSub: boolean;
  /** Offer the Auto line in the subscription: one profile that names no
   *  direction and lets the entry pick the fastest exit by measured RTT. */
  autoProfile: boolean;
  /** The name pinned for the Auto line, or null when it is derived from the
   *  cascade name. Same field, same reason as a direction's `label`. */
  autoLabel: string | null;
  /** What a subscriber's client shows for the Auto line, pinned or derived.
   *  Reported even when `autoProfile` is off, so the form can show what
   *  turning it on would hand out. */
  autoLineLabel: string;
  hops: CascadeHopDto[];
  /** v4 shape. Always present (possibly empty): empty means the cascade was
   *  written before the topology tables existed and still describes itself
   *  through `hops`. */
  positions: CascadePositionDto[];
  directions: CascadeDirectionDto[];
  /** Tag the NEXT new direction will receive. Reported because the panel shows
   *  it before saving and cannot derive it: tags are never reused, so after a
   *  delete `max(tag) + 1` guesses wrong (delete 5, add one, the server issues
   *  6 while the form promises 5). */
  nextDirectionTag: number;
  /**
   * Lines this save renamed, present only on the response to a save that
   * renamed one.
   *
   * Reported rather than refused: renaming is sometimes exactly what the
   * operator means. But it is never free, and it is not a thing the operator
   * can find out afterwards from anywhere else — a client that identifies a
   * server by its name answers a rename by ADDING the new line and keeping the
   * old, which no longer routes. Subscribers have to delete it by hand.
   */
  lineRenames?: CascadeLineRename[];
  /** Entry nodes whose non-xray bridge this save has just switched off, by
   *  making the cascade multi-direction. Present only on a save that caused it;
   *  empty array means the save was checked and changed nothing. */
  bridgesDisabled?: CascadeBridgeDisabled[];
  createdAt: string;
  updatedAt: string;
}

/** One entry node that asked for a bridge and no longer gets one. `directions`
 *  is the count that made it impossible: a bridge needs exactly one, because
 *  bridged traffic carries no tag to choose an exit with. */
export interface CascadeBridgeDisabled {
  nodeId: string;
  nodeName: string;
  directions: number;
}

/** One renamed line: the tag that identifies the direction, and the two names
 *  a subscriber's client will now hold side by side. */
export interface CascadeLineRename {
  tag: number;
  before: string;
  after: string;
}

interface CascadeRow {
  id: string;
  name: string;
  enabled: boolean;
  mode: string;
  hideHopsFromSub: boolean;
  /** Optional so a caller selecting a narrow row shape still type-checks; a
   *  missing value reads as off, which is the default. */
  autoProfile?: boolean;
  autoLabel?: string | null;
  nextDirectionTag?: number;
  createdAt: Date;
  updatedAt: Date;
  hops: {
    id: string;
    nodeId: string;
    position: number;
    entryProtocol: string | null;
    linkProtocol: string | null;
    node: { id: string; name: string } | null;
  }[];
  positions?: {
    position: number;
    entryProtocol: string | null;
    linkProtocol: string | null;
    nodes: { nodeId: string; egressPolicy?: unknown }[];
  }[];
  directions?: {
    id: string;
    tag: number;
    countryCode: string | null;
    label?: string | null;
    /** Present where the caller included the node rows; `lineLabel` falls back
     *  to the exit country alone without them. */
    nodes: { nodeId: string; node?: { name: string; countryCode: string | null } }[];
  }[];
}

export function mapCascade(c: CascadeRow): CascadeDto {
  return {
    id: c.id,
    name: c.name,
    enabled: c.enabled,
    mode: c.mode,
    hideHopsFromSub: c.hideHopsFromSub,
    autoProfile: c.autoProfile ?? false,
    autoLabel: c.autoLabel ?? null,
    autoLineLabel: normaliseLineLabel(c.autoLabel) ?? cascadeAutoProfileLabel(c.name),
    hops: c.hops.map((h) => ({
      id: h.id,
      nodeId: h.nodeId,
      nodeName: h.node?.name ?? '',
      position: h.position,
      entryProtocol: h.entryProtocol,
      linkProtocol: h.linkProtocol,
    })),
    positions: (c.positions ?? [])
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((p) => ({
        position: p.position,
        nodeIds: p.nodes.map((n) => n.nodeId),
        entryProtocol: p.entryProtocol,
        linkProtocol: p.linkProtocol,
        egressPolicies: Object.fromEntries(
          p.nodes.filter((n) => n.egressPolicy != null).map((n) => [n.nodeId, n.egressPolicy]),
        ),
      })),
    directions: (c.directions ?? [])
      .slice()
      .sort((a, b) => a.tag - b.tag)
      .map((d) => ({
        id: d.id,
        tag: d.tag,
        countryCode: d.countryCode,
        label: d.label ?? null,
        lineLabel: directionLineLabel(c.name, {
          label: d.label,
          countryCode: d.countryCode,
          nodes: d.nodes.flatMap((n) => (n.node ? [{ node: n.node }] : [])),
        }),
        nodeIds: d.nodes.map((n) => n.nodeId),
      })),
    nextDirectionTag: c.nextDirectionTag ?? 1,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}
