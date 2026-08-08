import { randomBytes, randomUUID } from 'node:crypto';

/**
 * C2/C3b - cascade config generation for the native inter-hop link cells the
 * node-agent realises in C3. Pure + testable: maps an ordered hop list +
 * pre-generated inter-hop link creds into per-node xray inbound/outbound/
 * routing fragments by role (entry / transit / exit).
 *
 * Topology (proxy-chain, terminate-at-each-hop so the entry can split-route):
 *   entry:   user-inbound (already deployed via the node's profile) + a
 *            link-OUT to hop[1]; route user traffic -> link-out.
 *   transit: link-IN (from prev) + link-OUT (to next); link-in -> link-out.
 *   exit:    link-IN (from prev) + freedom; link-in -> direct.
 *
 * Native link cells realised here: vless->vless (C3) and shadowsocks/SS2022
 * (C3b). Both ride the node's xray binary (xray has native SS inbound +
 * outbound), so the node-agent stays protocol-agnostic and just merges the
 * fragments. The link is a trusted node-to-node channel (datacenter to
 * datacenter), so the cell choice is about wire shape, not DPI evasion: the
 * ENTRY does the evasion. wg / hy2 / naive link cells need cross-adapter key
 * management or a bridge process and are deferred (fall back to vless).
 */

// Inter-hop link port base. The link from hop[i] to hop[i+1] listens on the
// RECEIVING node at LINK_PORT_BASE + i. High to dodge user inbounds; the
// node-agent (C3) firewalls it to peer nodes and ensures it's free.
export const LINK_PORT_BASE = 24000;

// SS2022 cipher for shadowsocks link cells. 32-byte key -> aes-256-gcm, the
// same default the standalone SS adapter uses (apps/node/.../shadowsocks).
const SS_LINK_METHOD = '2022-blake3-aes-256-gcm';

/** Native inter-hop link protocols realised by buildCascadeConfigs. Any other
 *  hop.linkProtocol (hy2/naive/wg/...) falls back to vless until its cell or
 *  bridge ships, which is non-regressive (vless was the only realised cell). */
export type LinkProtocol = 'vless' | 'shadowsocks';

interface VlessLinkCred {
  protocol: 'vless';
  /** Port the receiving (next) hop listens on for this link. */
  port: number;
  /** VLESS user id shared by the originating outbound and the next inbound. */
  uuid: string;
}

interface Ss2022LinkCred {
  protocol: 'shadowsocks';
  port: number;
  /** SS2022 pre-shared key (base64), shared by both sides of the link. */
  psk: string;
  /** SS cipher. */
  method: string;
}

export type LinkCred = VlessLinkCred | Ss2022LinkCred;

/** Map a hop's stored linkProtocol (free string, full 7-core enum) to a
 *  realised native cell. Only 'shadowsocks' has a dedicated cell beyond vless;
 *  everything else rides the proven vless link (unchanged from C3). */
export function normalizeLinkProtocol(p: string | null | undefined): LinkProtocol {
  return p === 'shadowsocks' ? 'shadowsocks' : 'vless';
}

/** Pre-generate link creds for the N-1 inter-hop links of an N-hop cascade,
 *  one per link in order. `linkProtocols[i]` is the protocol of the link from
 *  hop[i] to hop[i+1] (the originating hop's linkProtocol). */
export function generateLinkCreds(linkProtocols: LinkProtocol[]): LinkCred[] {
  return linkProtocols.map((proto, i) => {
    const port = LINK_PORT_BASE + i;
    if (proto === 'shadowsocks') {
      return {
        protocol: 'shadowsocks',
        port,
        psk: randomBytes(32).toString('base64'),
        method: SS_LINK_METHOD,
      };
    }
    return { protocol: 'vless', port, uuid: randomUUID() };
  });
}

/** One node-to-node leg of a v4 cascade, carrying traffic for ONE direction. */
export interface TopologyLink {
  fromNodeId: string;
  toNodeId: string;
  /** Direction whose traffic this leg carries (CascadeDirection.tag). */
  directionTag: number;
  protocol: LinkProtocol;
  cred: LinkCred;
}

/**
 * Generate every link a v4 topology implies: each node on a step pairs with
 * each node on the next, once PER DIRECTION.
 *
 * Why per direction, when the old model had one cred per hop: only the ENTRY
 * can read which direction a client chose, because it rides in the UUID the
 * client authenticates with. A transit further down the path sees an internal
 * link, not a user. Giving every leg its own credentials per direction is what
 * lets a transit tell them apart and fan them back out - the shape the old
 * model could not express at all.
 *
 * The listen PORT is shared per RECEIVING step (LINK_PORT_BASE + step), not per
 * link: xray and SS2022 both accept several clients on one inbound, so N
 * directions cost N secrets but one port, and a pool does not eat ports
 * proportionally to (nodes x directions).
 *
 * `directionNodeIds` may be empty for a direction whose pool is not filled yet:
 * it simply contributes no links, and the tag stays reserved.
 */
export function generateTopologyLinks(
  positions: { nodeIds: string[]; linkProtocol?: string | null }[],
  directions: { tag: number; nodeIds: string[] }[],
): TopologyLink[] {
  const links: TopologyLink[] = [];
  const emit = (
    from: string,
    to: string,
    directionTag: number,
    protocol: LinkProtocol,
    step: number,
  ): void => {
    const port = LINK_PORT_BASE + step;
    const cred: LinkCred =
      protocol === 'shadowsocks'
        ? {
            protocol: 'shadowsocks',
            port,
            psk: randomBytes(32).toString('base64'),
            method: SS_LINK_METHOD,
          }
        : { protocol: 'vless', port, uuid: randomUUID() };
    links.push({ fromNodeId: from, toNodeId: to, directionTag, protocol, cred });
  };

  // Position -> position legs. Every direction rides every leg: a transit must
  // be able to route each direction onwards separately.
  for (let step = 0; step < positions.length - 1; step++) {
    const proto = normalizeLinkProtocol(positions[step]!.linkProtocol);
    for (const from of positions[step]!.nodeIds) {
      for (const to of positions[step + 1]!.nodeIds) {
        for (const d of directions) emit(from, to, d.tag, proto, step);
      }
    }
  }

  // Last position -> the directions themselves. This leg is where a direction
  // stops being an abstraction and becomes concrete machines.
  const last = positions[positions.length - 1];
  if (last) {
    const step = positions.length - 1;
    const proto = normalizeLinkProtocol(last.linkProtocol);
    for (const from of last.nodeIds) {
      for (const d of directions) {
        for (const to of d.nodeIds) emit(from, to, d.tag, proto, step);
      }
    }
  }
  return links;
}

/** Serialise a link cred to the plain JSON persisted in CascadeHop.linkConfig
 *  (a typed LinkCred lacks the index signature Prisma's Json input needs). */
export function serializeLinkCred(cred: LinkCred): Record<string, string | number> {
  return cred.protocol === 'shadowsocks'
    ? { protocol: 'shadowsocks', port: cred.port, psk: cred.psk, method: cred.method }
    : { protocol: 'vless', port: cred.port, uuid: cred.uuid };
}

/** Parse a persisted linkConfig back into a LinkCred, or null if malformed. A
 *  legacy linkConfig with no `protocol` field is read as vless (the only cell
 *  that existed before C3b), so cascades created earlier keep working. */
export function parseLinkCred(raw: unknown): LinkCred | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.port !== 'number') return null;
  if (o.protocol === 'shadowsocks') {
    if (typeof o.psk !== 'string' || typeof o.method !== 'string') return null;
    return { protocol: 'shadowsocks', port: o.port, psk: o.psk, method: o.method };
  }
  if (typeof o.uuid !== 'string') return null;
  return { protocol: 'vless', port: o.port, uuid: o.uuid };
}

export type HopRole = 'entry' | 'transit' | 'exit';

export interface CascadeConfigHopInput {
  nodeId: string;
  position: number;
  /** Public host the PREVIOUS hop dials to reach this node's link inbound. */
  nodeHost: string;
}

export interface HopConfig {
  nodeId: string;
  position: number;
  role: HopRole;
  inbounds: Record<string, unknown>[];
  outbounds: Record<string, unknown>[];
  routingRules: Record<string, unknown>[];
  /** Link-IN port this hop listens on (transit/exit). The node-agent firewalls
   *  it to the previous hop. Undefined on the entry hop (no link-in). */
  linkIngressPort?: number;
  /** Address(es) of the previous hop allowed to reach linkIngressPort. */
  linkAllowFrom?: string[];
  /** Balancer entry only: the top-level `observatory` (probes link-outs by RTT).
   *  Undefined on chain hops and on balancer exit hops. */
  observatory?: Record<string, unknown>;
  /** Balancer entry only: the `routing.balancers` entries. Its user rule targets
   *  one via `balancerTag`. Undefined on chain hops and on balancer exits. */
  balancers?: Record<string, unknown>[];
}

const LINK_IN_TAG = 'cascade-link-in';
const LINK_OUT_TAG = 'cascade-link-out';
const DIRECT_TAG = 'direct';

// Drop QUIC (HTTP/3 = UDP/443) at the cascade entry so clients fall back to
// TCP/HTTP-2. QUIC tunneled as UDP-over-TCP through the inter-hop vless link
// suffers head-of-line blocking under sustained video load: YouTube Shorts
// played ~5s then froze ~1min before recovering. TCP over the same link is
// smooth (measured ~70 Mbit/s), and browsers/apps race QUIC+TCP so a blocked
// UDP/443 falls back instantly. `blocked` is the node-agent's base blackhole
// outbound. Placed before the balancer/link-out catch-all so it wins for 443.
const QUIC_BLOCK_RULE: Record<string, unknown> = {
  type: 'field',
  network: 'udp',
  port: 443,
  outboundTag: 'blocked',
};

function vlessLinkInbound(cred: VlessLinkCred): Record<string, unknown> {
  return {
    tag: LINK_IN_TAG,
    port: cred.port,
    listen: '0.0.0.0',
    protocol: 'vless',
    settings: { clients: [{ id: cred.uuid }], decryption: 'none' },
    streamSettings: { network: 'raw', security: 'none' },
  };
}

/**
 * Socket tuning for the inter-hop link.
 *
 * The node's own `direct` outbound has carried BBR + TCP Fast Open since slice
 * 23.1, but the link between hops never did, so the LONGEST leg of a cascade
 * (RU to NL is ~80ms RTT) ran on plain CUBIC. That is exactly where BBR earns
 * its keep: on a long fat pipe with loss the gap is a multiple, not a few
 * percent. Reported from the field 2026-07-30 as "pages load heavily" while
 * raw throughput looked fine.
 *
 * The node's sysctl already sets `net.core.default_qdisc=fq` and BBR (see
 * install-iceslab-node.sh), so this asks for something the kernel can give.
 */
const LINK_SOCKOPT = {
  tcpCongestion: 'bbr',
  tcpFastOpen: true,
} as const;

/**
 * Multiplexing for the inter-hop link.
 *
 * Without it every stream opens its own TCP connection across the whole chain,
 * so a page that fires forty requests pays forty full round trips before any
 * of them carry data. That is felt as slow LOADING even when a single download
 * runs at full speed, which is precisely the reported symptom.
 *
 * concurrency 8 is deliberately modest: Mux funnels streams into one
 * connection, so a large sustained transfer can hold up the small requests
 * sharing it. Eight keeps page loads snappy without turning the link into a
 * single-lane road.
 */
const LINK_MUX = {
  enabled: true,
  concurrency: 8,
} as const;

function vlessLinkOutbound(host: string, cred: VlessLinkCred): Record<string, unknown> {
  return {
    tag: LINK_OUT_TAG,
    protocol: 'vless',
    settings: {
      vnext: [{ address: host, port: cred.port, users: [{ id: cred.uuid, encryption: 'none' }] }],
    },
    streamSettings: { network: 'raw', security: 'none', sockopt: LINK_SOCKOPT },
    mux: LINK_MUX,
  };
}

// SS2022 link cell (C3b). Single shared PSK point-to-point, so no per-user
// `clients` array (unlike the multi-user SS inbound the standalone adapter
// renders). No streamSettings: SS carries its own transport over plain TCP/UDP.
function ssLinkInbound(cred: Ss2022LinkCred): Record<string, unknown> {
  return {
    tag: LINK_IN_TAG,
    port: cred.port,
    listen: '0.0.0.0',
    protocol: 'shadowsocks',
    settings: { method: cred.method, password: cred.psk, network: 'tcp,udp' },
  };
}

function ssLinkOutbound(host: string, cred: Ss2022LinkCred): Record<string, unknown> {
  return {
    tag: LINK_OUT_TAG,
    protocol: 'shadowsocks',
    settings: {
      servers: [{ address: host, port: cred.port, method: cred.method, password: cred.psk }],
    },
    // SS carries its own transport, so there is no network/security to set,
    // but the socket underneath is still ours to tune. Same reasoning as the
    // vless cell: this leg is the long one.
    streamSettings: { sockopt: LINK_SOCKOPT },
    mux: LINK_MUX,
  };
}

function linkInbound(cred: LinkCred): Record<string, unknown> {
  return cred.protocol === 'shadowsocks' ? ssLinkInbound(cred) : vlessLinkInbound(cred);
}

function linkOutbound(host: string, cred: LinkCred): Record<string, unknown> {
  return cred.protocol === 'shadowsocks'
    ? ssLinkOutbound(host, cred)
    : vlessLinkOutbound(host, cred);
}

const freedomOutbound: Record<string, unknown> = { tag: DIRECT_TAG, protocol: 'freedom' };

// ───── v4 fragment builder ─────

/** One resolved leg for the v4 builder: who dials whom, for which direction. */
export interface TopologyLinkRow {
  fromNodeId: string;
  toNodeId: string;
  directionTag: number;
  cred: LinkCred;
}

export interface TopologyNodeInput {
  nodeId: string;
  /** Public host other nodes dial to reach this one (no agent port). */
  host: string;
}

export interface TopologyInput {
  /** Ordered steps; index 0 is the entry. Each holds a pool of node ids. */
  positions: { position: number; nodeIds: string[] }[];
  /** Ways out, each with its frozen tag and a (possibly empty) pool. */
  directions: { tag: number; nodeIds: string[] }[];
  links: TopologyLinkRow[];
  /** Public host per node id, for both dialling and firewall allow-lists. */
  hosts: Map<string, string>;
  policies?: CascadePolicy[];
}

/** Per-direction outbound tag. Unlike the old index-based `-0/-1` suffix this
 *  is stable: it names the DIRECTION, which no longer moves when a neighbour
 *  is deleted. */
function dirOutTag(directionTag: number, idx: number): string {
  return `${LINK_OUT_TAG}-d${directionTag}-${idx}`;
}

/** Email given to a link's inbound client. It is how a TRANSIT tells directions
 *  apart: the transit sees an internal link rather than a user, so the only
 *  thing that says "this traffic is headed for direction 7" is which credential
 *  it arrived on. Routing then matches on `user`. */
function linkClientEmail(directionTag: number, fromNodeId: string): string {
  return `lnk-d${directionTag}-${fromNodeId.slice(0, 8)}`;
}

/**
 * Build the xray fragments for ONE node of a v4 cascade.
 *
 * Shape-agnostic by design: entry, transit and direction nodes all fall out of
 * the same two questions - which links end here, and which start here. The old
 * builders needed one function per mode because `position` meant different
 * things in each; here it means one thing.
 *
 * Returns null when the node carries no links at all (not part of this cascade,
 * or a direction with an empty pool).
 */
export function buildTopologyFragmentsForNode(
  nodeId: string,
  input: TopologyInput,
): HopConfig | null {
  const incoming = input.links.filter((l) => l.toNodeId === nodeId);
  const outgoing = input.links.filter((l) => l.fromNodeId === nodeId);
  if (incoming.length === 0 && outgoing.length === 0) return null;

  const posIndex = input.positions.findIndex((p) => p.nodeIds.includes(nodeId));
  const isEntry = posIndex === 0;
  const isDirection = input.directions.some((d) => d.nodeIds.includes(nodeId));
  const role: HopRole = isEntry ? 'entry' : isDirection ? 'exit' : 'transit';

  // ── Inbound side: every leg that ends here shares ONE listener (the port is
  // per receiving step), so several credentials live on one inbound. That is
  // why the multi-client form is used even for a single link.
  const inbounds: Record<string, unknown>[] = [];
  let linkIngressPort: number | undefined;
  const allowFrom: string[] = [];
  if (incoming.length > 0) {
    linkIngressPort = incoming[0]!.cred.port;
    for (const l of incoming) {
      const host = input.hosts.get(l.fromNodeId);
      if (host) allowFrom.push(host);
    }
    inbounds.push(multiClientLinkInbound(incoming));
  }

  // ── Outbound side: one outbound per leg, grouped by direction.
  const outbounds: Record<string, unknown>[] = [];
  const byDirection = new Map<number, string[]>();
  const perDirCounter = new Map<number, number>();
  for (const l of outgoing) {
    const host = input.hosts.get(l.toNodeId);
    if (!host) continue;
    const idx = perDirCounter.get(l.directionTag) ?? 0;
    perDirCounter.set(l.directionTag, idx + 1);
    const tag = dirOutTag(l.directionTag, idx);
    outbounds.push({ ...linkOutbound(host, l.cred), tag });
    const list = byDirection.get(l.directionTag) ?? [];
    list.push(tag);
    byDirection.set(l.directionTag, list);
  }
  outbounds.push(freedomOutbound);

  const routingRules: Record<string, unknown>[] = [];
  const balancers: Record<string, unknown>[] = [];
  let needsObservatory = false;

  if (role === 'exit') {
    // A direction's node is the end of the road: everything that arrives on the
    // link egresses locally.
    routingRules.push({ type: 'field', inboundTag: [LINK_IN_TAG], outboundTag: DIRECT_TAG });
    return {
      nodeId,
      position: input.positions.length,
      role,
      inbounds,
      outbounds: [freedomOutbound],
      routingRules,
      ...(linkIngressPort !== undefined ? { linkIngressPort } : {}),
      ...(allowFrom.length > 0 ? { linkAllowFrom: [...new Set(allowFrom)] } : {}),
    };
  }

  // Entry and transit both steer by direction; they differ only in what they
  // read the direction FROM.
  if (isEntry) routingRules.push(QUIC_BLOCK_RULE);

  for (const [directionTag, tags] of [...byDirection.entries()].sort((a, b) => a[0] - b[0])) {
    // A pool on the next step means several outbounds serve one direction. Let
    // xray pick by latency rather than pinning the first, which is the whole
    // point of a pool.
    let target: Record<string, unknown>;
    if (tags.length > 1) {
      const balancerTag = `bal-d${directionTag}`;
      balancers.push({ tag: balancerTag, selector: tags, strategy: { type: 'leastPing' } });
      target = { balancerTag };
      // leastPing needs somebody to measure the pings. Without an observatory
      // xray refuses the whole config with "not all dependencies are resolved"
      // and the core never starts - caught by the config-validity test, before
      // this shape reached a node.
      needsObservatory = true;
    } else {
      target = { outboundTag: tags[0]! };
    }
    if (isEntry) {
      // The client encodes (policy, direction) in its UUID; xray surfaces it as
      // vlessRoute. Plain profile is ordinal 0.
      const routeTags = [routeTag(0, directionTag - 1)];
      for (const p of input.policies ?? []) routeTags.push(routeTag(p.ordinal, directionTag - 1));
      // ⚠ STRING, comma-separated - never an array. xray parses `vlessRoute`
      // with its port-list parser, so an array of numbers fails the whole
      // config with "invalid port", and the core then refuses to start at all.
      // Caught in the field 2026-08-08.
      routingRules.push({ type: 'field', vlessRoute: routeTags.join(','), ...target });
    } else {
      // A transit cannot read the client's choice, so it matches the credential
      // the traffic arrived on.
      const users = input.links
        .filter((l) => l.toNodeId === nodeId && l.directionTag === directionTag)
        .map((l) => linkClientEmail(l.directionTag, l.fromNodeId));
      routingRules.push({ type: 'field', user: users, ...target });
    }
  }

  return {
    nodeId,
    position: posIndex >= 0 ? posIndex : input.positions.length,
    role,
    inbounds,
    outbounds,
    routingRules,
    ...(linkIngressPort !== undefined ? { linkIngressPort } : {}),
    ...(allowFrom.length > 0 ? { linkAllowFrom: [...new Set(allowFrom)] } : {}),
    ...(balancers.length > 0 ? { balancers } : {}),
    // One observatory covers every balancer on this node: it probes all
    // link-outs by tag prefix, and each balancer selects from that pool.
    ...(needsObservatory
      ? {
          observatory: {
            subjectSelector: [LINK_OUT_TAG],
            // xray's json tag is `probeURL` (capital URL); a lowercase spelling
            // is silently ignored and the probe quietly targets xray's default.
            probeURL: OBSERVATORY_PROBE_URL,
            probeInterval: OBSERVATORY_PROBE_INTERVAL,
          },
        }
      : {}),
  };
}

/**
 * One listener holding every credential that terminates on this step.
 *
 * vless takes a clients array natively. SS2022 also supports multiple users in
 * xray, which matters here: pre-v4 the SS cell was strictly point-to-point (one
 * PSK per inbound), and that shape cannot carry several directions on one port.
 */
function multiClientLinkInbound(links: TopologyLinkRow[]): Record<string, unknown> {
  const first = links[0]!.cred;
  if (first.protocol === 'shadowsocks') {
    return {
      tag: LINK_IN_TAG,
      port: first.port,
      listen: '0.0.0.0',
      protocol: 'shadowsocks',
      settings: {
        clients: links
          .filter((l) => l.cred.protocol === 'shadowsocks')
          .map((l) => ({
            email: linkClientEmail(l.directionTag, l.fromNodeId),
            password: (l.cred as Ss2022LinkCred).psk,
            method: (l.cred as Ss2022LinkCred).method,
          })),
        network: 'tcp,udp',
      },
    };
  }
  return {
    tag: LINK_IN_TAG,
    port: first.port,
    listen: '0.0.0.0',
    protocol: 'vless',
    settings: {
      clients: links
        .filter((l) => l.cred.protocol === 'vless')
        .map((l) => ({
          id: (l.cred as VlessLinkCred).uuid,
          email: linkClientEmail(l.directionTag, l.fromNodeId),
        })),
      decryption: 'none',
    },
    streamSettings: { network: 'raw', security: 'none' },
  };
}

export function buildCascadeConfigs(
  hops: CascadeConfigHopInput[],
  linkCreds: LinkCred[],
  policies: CascadePolicy[] = [],
): HopConfig[] {
  const sorted = [...hops].sort((a, b) => a.position - b.position);
  const n = sorted.length;
  return sorted.map((hop, i) => {
    const role: HopRole = i === 0 ? 'entry' : i === n - 1 ? 'exit' : 'transit';
    const linkIn = i > 0 ? linkCreds[i - 1] : null;
    const linkOut = i < n - 1 ? linkCreds[i] : null;

    const inbounds = linkIn ? [linkInbound(linkIn)] : [];
    const outbounds: Record<string, unknown>[] = [];
    if (linkOut) outbounds.push(linkOutbound(sorted[i + 1]!.nodeHost, linkOut));
    outbounds.push(freedomOutbound);

    const routingRules: Record<string, unknown>[] = [];
    if (role === 'entry') {
      routingRules.push(QUIC_BLOCK_RULE);
      // A4 ad-split on a CHAIN. Until 2026-07-30 policies reached balancer
      // entries only, so an operator could define a policy, grant it to a
      // squad, watch the panel report success, and get no rules on the node at
      // all. The chain had exactly one exit, so nobody noticed a missing exit
      // selector; what went missing was the ad-split.
      //
      // A chain needs no rule for the PLAIN profile: with one exit there is
      // nothing to select, and an untagged client falls through to the
      // catch-all below, which is that same exit. Only the policies need rules,
      // each gated on its own vlessRoute tag and sitting ABOVE the catch-all so
      // its direct/block domains win before traffic enters the link.
      for (const p of policies) {
        const tag = String(routeTag(p.ordinal, 0));
        if (p.blockDomains.length) {
          routingRules.push({
            type: 'field',
            vlessRoute: tag,
            domain: p.blockDomains,
            outboundTag: 'blocked',
          });
        }
        if (p.directDomains.length) {
          routingRules.push({
            type: 'field',
            vlessRoute: tag,
            domain: p.directDomains,
            outboundTag: DIRECT_TAG,
          });
        }
      }
      // User traffic -> link-out. Also the fall-through for the plain profile
      // and for any client whose UUID carries no tag we recognise.
      routingRules.push({ type: 'field', network: 'tcp,udp', outboundTag: LINK_OUT_TAG });
    } else if (role === 'transit') {
      routingRules.push({ type: 'field', inboundTag: [LINK_IN_TAG], outboundTag: LINK_OUT_TAG });
    } else {
      routingRules.push({ type: 'field', inboundTag: [LINK_IN_TAG], outboundTag: DIRECT_TAG });
    }

    // The link-in (when present) is dialed by the PREVIOUS hop, so the agent
    // firewalls this hop's link port to that hop's host.
    const linkIngressPort = linkIn ? linkIn.port : undefined;
    const linkAllowFrom = linkIn ? [sorted[i - 1]!.nodeHost] : undefined;

    return {
      nodeId: hop.nodeId,
      position: hop.position,
      role,
      inbounds,
      outbounds,
      routingRules,
      linkIngressPort,
      linkAllowFrom,
    };
  });
}

// ───── C3-auto: latency-balanced cascade (the "auto" / optimal-location node) ─────
// One entry that dials EVERY exit (a link-out each), a top-level `observatory`
// that probes those link-outs by RTT, and a `leastPing` balancer that routes
// each user connection through the exit with the lowest observed RTT.
//
// Why leastPing and not leastLoad: in xray-core the top-level `observatory`
// feeds `leastPing`; `leastLoad` ignores it (it runs its own burstObservatory +
// cost weights). RTT is used deliberately as the load/capacity signal, a
// saturated / slow / distant exit probes slower and is deprioritised on its own,
// so no server-side metric loop or per-tick config re-push (which would restart
// the entry and drop its users) is needed. A dead exit fails the probe and
// drops out of the pool with zero panel involvement. Same shape as the
// subscription-side balancer.
const BALANCER_TAG = 'auto';
const OBSERVATORY_PROBE_URL = 'https://www.gstatic.com/generate_204';
const OBSERVATORY_PROBE_INTERVAL = '5m';

/** Like linkOutbound but with a caller-chosen tag, so N link-outs can share the
 *  LINK_OUT_TAG prefix (xray selectors are prefix matches) while staying
 *  distinct outbounds. */
function linkOutboundTagged(host: string, cred: LinkCred, tag: string): Record<string, unknown> {
  return { ...linkOutbound(host, cred), tag };
}

/** A4 ad-split: an extra route-policy applied at the balancer ENTRY. A client's
 *  route-profile = (exit) x (plain OR one of these). ordinal >= 1 (0 = implicit
 *  plain). directDomains/blockDomains are xray geosite/domain strings. */
export interface CascadePolicy {
  ordinal: number;
  directDomains: string[];
  blockDomains: string[];
}

/** A4 ad-split: vlessRoute tag (uint16) for a (policyOrdinal, exitIndex) profile.
 *  Ordinal 0 = implicit plain profile -> tag = exitIndex+1 (back-compat with the
 *  pre-ad-split exit tags). Shared by the node (this file) and the subscription
 *  builder so both agree on the tag for a given profile. 256-wide bands. */
export function routeTag(policyOrdinal: number, exitIndex: number): number {
  return policyOrdinal * 256 + exitIndex + 1;
}

/** Highest policy ordinal that still fits the uint16 tag: the ordinal occupies
 *  the high byte, the exit index the low one. 255 policies is far past any real
 *  use, but the bound has to exist somewhere, and this is where it comes from. */
export const MAX_DIRECTION_ORDINAL = 255;

/**
 * Build the entry + exit fragments for a BALANCER cascade (one entry, N parallel
 * exits). `linkCreds[i]` is the entry->exits[i] link cred (each exit listens on
 * its own link-in). Returns exactly 1 entry + N exit HopConfigs, no transit.
 * `policies` are extra ad-split policies (ordinal >= 1); the plain profile is
 * always emitted regardless.
 */
export function buildBalancerCascadeConfigs(
  entry: CascadeConfigHopInput,
  exits: CascadeConfigHopInput[],
  linkCreds: LinkCred[],
  policies: CascadePolicy[] = [],
): HopConfig[] {
  const configs: HopConfig[] = [];

  // Entry: one link-out per exit, all sharing the LINK_OUT_TAG prefix so the
  // observatory/balancer selector matches them; plus freedom for split-routing.
  const entryOutbounds: Record<string, unknown>[] = exits.map((ex, i) =>
    linkOutboundTagged(ex.nodeHost, linkCreds[i]!, `${LINK_OUT_TAG}-${i}`),
  );
  entryOutbounds.push(freedomOutbound);

  configs.push({
    nodeId: entry.nodeId,
    position: entry.position,
    role: 'entry',
    inbounds: [],
    outbounds: entryOutbounds,
    // A4: explicit exit selection + ad-split, layered ON TOP of the balancer. A
    // client's UUID bytes 7-8 (big-endian uint16, read by xray as vlessRoute)
    // encode a route-profile = (policy, exit) via routeTag(); auth ignores those
    // bytes so it stays the same user (verified in field 2026-07-25, documented
    // upstream). The PLAIN profile (ordinal 0, tags 1..N) just pins the exit. An
    // ad-split policy (ordinal>=1) prepends its block/direct domain rules ABOVE
    // that profile's exit-catch-all, so e.g. Google egresses direct from the
    // ENTRY while everything else rides the chosen exit. A client sending any
    // other value - including a normal unmodified UUID - matches nothing here and
    // falls through to the balancer = automatic leastPing exit.
    routingRules: [
      QUIC_BLOCK_RULE,
      // Plain profile: tag = exitIndex+1 -> that exit's link-out.
      ...exits.map((_, i) => ({
        type: 'field',
        vlessRoute: String(routeTag(0, i)),
        network: 'tcp,udp',
        outboundTag: `${LINK_OUT_TAG}-${i}`,
      })),
      // Ad-split policies: per (policy, exit), block/direct rules above the exit-
      // catch-all, all gated by that profile's tag. `blocked` is the agent's base
      // blackhole (same as QUIC_BLOCK_RULE); `direct` is the entry's freedom.
      ...policies.flatMap((p) =>
        exits.flatMap((_, i) => {
          const tag = String(routeTag(p.ordinal, i));
          return [
            ...(p.blockDomains.length
              ? [{ type: 'field', vlessRoute: tag, domain: p.blockDomains, outboundTag: 'blocked' }]
              : []),
            ...(p.directDomains.length
              ? [{ type: 'field', vlessRoute: tag, domain: p.directDomains, outboundTag: DIRECT_TAG }]
              : []),
            { type: 'field', vlessRoute: tag, network: 'tcp,udp', outboundTag: `${LINK_OUT_TAG}-${i}` },
          ];
        }),
      ),
      { type: 'field', network: 'tcp,udp', balancerTag: BALANCER_TAG },
    ],
    observatory: {
      subjectSelector: [LINK_OUT_TAG],
      // xray-core's json tag is `probeURL` (capital URL). A lowercase `probeUrl`
      // is silently ignored and the probe falls back to xray's default target.
      probeURL: OBSERVATORY_PROBE_URL,
      probeInterval: OBSERVATORY_PROBE_INTERVAL,
    },
    balancers: [{ tag: BALANCER_TAG, selector: [LINK_OUT_TAG], strategy: { type: 'leastPing' } }],
  });

  // Exits: each terminates its own link-in and egresses via freedom, firewalled
  // to the entry (the only node that dials it).
  exits.forEach((ex, i) => {
    const cred = linkCreds[i]!;
    configs.push({
      nodeId: ex.nodeId,
      position: ex.position,
      role: 'exit',
      inbounds: [linkInbound(cred)],
      outbounds: [freedomOutbound],
      routingRules: [{ type: 'field', inboundTag: [LINK_IN_TAG], outboundTag: DIRECT_TAG }],
      linkIngressPort: cred.port,
      linkAllowFrom: [entry.nodeHost],
    });
  });

  return configs;
}
