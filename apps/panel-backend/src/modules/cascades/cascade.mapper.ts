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
  createdAt: string;
  updatedAt: string;
}

interface CascadeRow {
  id: string;
  name: string;
  enabled: boolean;
  mode: string;
  hideHopsFromSub: boolean;
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
    nodes: { nodeId: string }[];
  }[];
  directions?: {
    id: string;
    tag: number;
    countryCode: string | null;
    nodes: { nodeId: string }[];
  }[];
}

export function mapCascade(c: CascadeRow): CascadeDto {
  return {
    id: c.id,
    name: c.name,
    enabled: c.enabled,
    mode: c.mode,
    hideHopsFromSub: c.hideHopsFromSub,
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
      })),
    directions: (c.directions ?? [])
      .slice()
      .sort((a, b) => a.tag - b.tag)
      .map((d) => ({
        id: d.id,
        tag: d.tag,
        countryCode: d.countryCode,
        nodeIds: d.nodes.map((n) => n.nodeId),
      })),
    nextDirectionTag: c.nextDirectionTag ?? 1,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}
