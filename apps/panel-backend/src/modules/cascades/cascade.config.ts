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
