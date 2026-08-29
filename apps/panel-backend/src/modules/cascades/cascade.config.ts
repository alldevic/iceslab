import { randomBytes, randomUUID } from 'node:crypto';
import { generateRealityKeyPair } from '../../lib/credentials.js';
import {
  compileEntryGeoRules,
  directionTargetKey,
  entryDomainStrategy,
  type EgressPolicy,
  type TargetRouting,
} from './cascade.geo.js';


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
  /**
   * REALITY + VISION wrapping for the leg (2026-08).
   *
   * Until now an inter-hop link was plain VLESS over raw TCP on a public port.
   * That is fine between two datacenters nobody inspects, and wrong for the
   * shape our operator runs: their entry sits in Russia, so this leg crosses a
   * border looking exactly like the thing being searched for. Their own hops
   * use REALITY+VISION, and ours should not be the weak link in a chain built
   * for censorship resistance.
   *
   * Absent on links generated before this landed; those keep working as plain
   * VLESS, so a cascade does not break on deploy. New links get it.
   */
  reality?: {
    /** Held by the RECEIVING side (its inbound decrypts with this). */
    privateKey: string;
    /** Held by the DIALLING side (its outbound presents this). */
    publicKey: string;
    shortId: string;
    /** Site the handshake is camouflaged as, and dialled through. Both sides
     *  must agree, hence storing it with the credentials rather than deriving
     *  it per node. */
    serverName: string;
    dest: string;
  };
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

/**
 * A leg's identity across a save: its two ends and the direction it carries.
 *
 * Everything else about a leg is derived - the listen port from the receiving
 * step - so this is what decides whether a stored credential still belongs to
 * anything. Direction tags themselves already survive a save (writeTopologyV4
 * matches an incoming direction to a stored one by its pool), which is the same
 * reasoning one level up: an identity a live client is authenticating with
 * cannot be re-minted because an unrelated field was edited.
 */
export function linkLegKey(fromNodeId: string, toNodeId: string, directionTag: number): string {
  return `${fromNodeId}|${toNodeId}|${directionTag}`;
}

/** A leg as the cascade currently has it stored, for carrying across a save. */
export interface StoredLink {
  fromNodeId: string;
  toNodeId: string;
  directionTag: number;
  cred: LinkCred;
}

function byLeg(previous: StoredLink[] | undefined): Map<string, LinkCred> {
  return new Map(
    (previous ?? []).map((l) => [linkLegKey(l.fromNodeId, l.toNodeId, l.directionTag), l.cred]),
  );
}

/**
 * Reuse a stored credential for a leg that still exists, at whatever port the
 * new topology puts it on.
 *
 * Returns null when there is nothing to carry, or when the leg changed
 * protocol - a vless cred and an SS2022 cred share no material, so that leg is
 * genuinely new.
 *
 * The port travels with the topology rather than with the secret: inserting a
 * position ahead of a leg moves which step it listens on, and that is a config
 * change both ends get in the same push, not an identity change.
 */
function carryLinkCred(
  prev: LinkCred | undefined,
  protocol: LinkProtocol,
  port: number,
): LinkCred | null {
  if (!prev || prev.protocol !== protocol) return null;
  return prev.protocol === 'shadowsocks'
    ? { protocol: 'shadowsocks', port, psk: prev.psk, method: prev.method }
    : { protocol: 'vless', port, uuid: prev.uuid, reality: prev.reality };
}

/** Pre-generate link creds for the N-1 inter-hop links of an N-hop cascade,
 *  one per link in order. `linkProtocols[i]` is the protocol of the link from
 *  hop[i] to hop[i+1] (the originating hop's linkProtocol).
 *
 *  `previous` carries the credential of a leg that still exists, keyed by
 *  linkLegKey; `legs[i]` names the two ends of link i. Both absent = mint
 *  everything, which is what create does. */
export function generateLinkCreds(
  linkProtocols: LinkProtocol[],
  legs?: { fromNodeId: string; toNodeId: string }[],
  previous?: StoredLink[],
): LinkCred[] {
  const stored = byLeg(previous);
  return linkProtocols.map((proto, i) => {
    const port = LINK_PORT_BASE + i;
    const leg = legs?.[i];
    const kept = leg
      ? carryLinkCred(stored.get(linkLegKey(leg.fromNodeId, leg.toNodeId, 0)), proto, port)
      : null;
    if (kept) return kept;
    if (proto === 'shadowsocks') {
      return {
        protocol: 'shadowsocks',
        port,
        psk: randomBytes(32).toString('base64'),
        method: SS_LINK_METHOD,
      };
    }
    return { protocol: 'vless', port, uuid: randomUUID(), reality: newLinkReality() };
  });
}

/**
 * REALITY material for one inter-hop leg.
 *
 * A fresh keypair per link, not one shared across the cascade: the two ends of
 * a leg are the only parties that need it, and reuse would let a compromised
 * node impersonate every other hop.
 *
 * The camouflage target is a large, always-up site that a datacenter connecting
 * to it looks unremarkable doing. It is fixed rather than configurable for now
 * because a bad choice here is invisible until traffic gets blocked, and the
 * operator has no way to evaluate it.
 */
/**
 * A REALITY identity for one RECEIVING node, plus a fresh shortId per link.
 *
 * The split is forced by xray: several links land on ONE inbound (the port is
 * shared per receiving step, so N directions cost N secrets and one port), and
 * an inbound carries exactly one `privateKey`. A keypair minted per LINK cannot
 * be served - the inbound would decrypt for one dialler and reject its
 * siblings. `shortIds` IS a list, so the per-link secret lives there.
 *
 * Keyed on the receiving node rather than shared fleet-wide: a compromised node
 * then impersonates only itself, which is the property the per-link version was
 * reaching for and could not have.
 */
function realityForReceiver(
  cache: Map<string, { privateKey: string; publicKey: string }>,
  toNodeId: string,
): NonNullable<VlessLinkCred['reality']> {
  let pair = cache.get(toNodeId);
  if (!pair) {
    pair = generateRealityKeyPair();
    cache.set(toNodeId, pair);
  }
  return realityWith(pair);
}

/**
 * A standalone REALITY identity, for the v3 chain/balancer shapes.
 *
 * Safe there for a reason worth stating rather than assuming: those topologies
 * give every receiving hop exactly ONE incoming link (a chain links hop i to
 * hop i+1, a balancer links the entry to each exit), so one keypair per link
 * and one per inbound are the same thing. Only the v4 topology puts several
 * links on one inbound, and that path goes through realityForReceiver.
 */
function newLinkReality(): NonNullable<VlessLinkCred['reality']> {
  return realityWith(generateRealityKeyPair());
}

function realityWith(pair: {
  privateKey: string;
  publicKey: string;
}): NonNullable<VlessLinkCred['reality']> {
  return {
    ...pair,
    // shortId is a hex string of even length, up to 16 bytes; 8 is what the
    // panel already uses for user-facing inbounds.
    shortId: randomBytes(8).toString('hex'),
    serverName: LINK_CAMOUFLAGE_SNI,
    dest: `${LINK_CAMOUFLAGE_SNI}:443`,
  };
}

/**
 * The site an inter-hop handshake is camouflaged as, and dialled through.
 *
 * NOT www.microsoft.com, which is what this was. Measured on xray 26.3.27: its
 * REALITY server authenticates the client, then runs out of relayed handshake
 * before the target's 8273-byte certificate chain is through, and logs
 * `handshake did not complete successfully`. Deterministic - three failures out
 * of three, interleaved with two successes out of two on cloudflare.
 *
 * `www.cloudflare.com` completes, as do dl.google.com, addons.mozilla.org,
 * www.apple.com and www.lovelive-anime.jp. Fixed rather than configurable for
 * now because a bad choice here is invisible until traffic gets blocked, and
 * the operator has no way to evaluate one.
 */
const LINK_CAMOUFLAGE_SNI = 'www.cloudflare.com';

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
  previous?: StoredLink[],
): TopologyLink[] {
  const links: TopologyLink[] = [];
  const stored = byLeg(previous);
  // One REALITY identity per receiving node, reused by every link into it -
  // see realityForReceiver. Lives here so it spans both loops below: a node can
  // only receive at one step, but the two loops are what produce those links.
  const receiverIdentity = new Map<string, { privateKey: string; publicKey: string }>();
  // Seed it from what the cascade already had, or a save that adds ONE leg into
  // a node would mint that node a second identity and break the invariant the
  // per-receiver cache exists for: one inbound, one keypair.
  for (const l of previous ?? []) {
    if (l.cred.protocol !== 'vless' || !l.cred.reality) continue;
    if (receiverIdentity.has(l.toNodeId)) continue;
    receiverIdentity.set(l.toNodeId, {
      privateKey: l.cred.reality.privateKey,
      publicKey: l.cred.reality.publicKey,
    });
  }
  const emit = (
    from: string,
    to: string,
    directionTag: number,
    protocol: LinkProtocol,
    step: number,
  ): void => {
    const port = LINK_PORT_BASE + step;
    const cred: LinkCred =
      carryLinkCred(stored.get(linkLegKey(from, to, directionTag)), protocol, port) ??
      (protocol === 'shadowsocks'
        ? {
            protocol: 'shadowsocks',
            port,
            psk: randomBytes(32).toString('base64'),
            method: SS_LINK_METHOD,
          }
        : {
            protocol: 'vless',
            port,
            uuid: randomUUID(),
            reality: realityForReceiver(receiverIdentity, to),
          });
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
export function serializeLinkCred(
  cred: LinkCred,
): Record<string, string | number | Record<string, string>> {
  if (cred.protocol === 'shadowsocks') {
    return { protocol: 'shadowsocks', port: cred.port, psk: cred.psk, method: cred.method };
  }
  // The reality block travels. It used to be dropped here, which made the whole
  // camouflage dead code: generated, commented at length, and gone by the time
  // anything read it back - `parseLinkCred` has always accepted it and never
  // once received one.
  return {
    protocol: 'vless',
    port: cred.port,
    uuid: cred.uuid,
    ...(cred.reality ? { reality: { ...cred.reality } } : {}),
  };
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
  const cred: VlessLinkCred = { protocol: 'vless', port: o.port, uuid: o.uuid };
  // REALITY block is optional: links generated before it existed carry none
  // and keep working as plain VLESS. Accepted only whole - a partial block
  // would render a config one side can't complete a handshake against.
  const r = o.reality as Record<string, unknown> | undefined;
  if (
    r &&
    typeof r.privateKey === 'string' &&
    typeof r.publicKey === 'string' &&
    typeof r.shortId === 'string' &&
    typeof r.serverName === 'string' &&
    typeof r.dest === 'string'
  ) {
    cred.reality = {
      privateKey: r.privateKey,
      publicKey: r.publicKey,
      shortId: r.shortId,
      serverName: r.serverName,
      dest: r.dest,
    };
  }
  return cred;
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
  /** Entry only: override the node's global routing.domainStrategy (e.g.
   *  'IPOnDemand' so an ip/geoip egress rule resolves ahead of the catch-all).
   *  Undefined on non-entry hops and on entries whose policy needs no IP
   *  resolution (keeps the node default, byte-identical to a non-geo cascade). */
  domainStrategy?: string;
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
    settings: {
      // VISION on the receiving side too: the flow is negotiated per user, so
      // both ends have to name it or the client is rejected.
      clients: [{ id: cred.uuid, ...(cred.reality ? { flow: 'xtls-rprx-vision' } : {}) }],
      decryption: 'none',
    },
    streamSettings: cred.reality
      ? {
          network: 'raw',
          security: 'reality',
          realitySettings: {
            // dest/serverNames make the leg indistinguishable from traffic to
            // a real site; without them REALITY has nothing to hide behind.
            dest: cred.reality.dest,
            serverNames: [cred.reality.serverName],
            privateKey: cred.reality.privateKey,
            shortIds: [cred.reality.shortId],
          },
        }
      : { network: 'raw', security: 'none' },
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
      vnext: [
        {
          address: host,
          port: cred.port,
          users: [
            {
              id: cred.uuid,
              encryption: 'none',
              ...(cred.reality ? { flow: 'xtls-rprx-vision' } : {}),
            },
          ],
        },
      ],
    },
    streamSettings: cred.reality
      ? {
          network: 'raw',
          security: 'reality',
          realitySettings: {
            serverName: cred.reality.serverName,
            publicKey: cred.reality.publicKey,
            shortId: cred.reality.shortId,
            // Browser fingerprint: without one the TLS ClientHello is a
            // recognisable non-browser, which defeats the point of hiding the
            // handshake behind a real site.
            fingerprint: 'firefox',
          },
          sockopt: LINK_SOCKOPT,
        }
      : { network: 'raw', security: 'none', sockopt: LINK_SOCKOPT },
    // Mux and VISION are mutually exclusive in xray: VISION splices the
    // connection, which is exactly what mux's multiplexing breaks.
    ...(cred.reality ? {} : { mux: LINK_MUX }),
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
  /** E - per-NODE geo split, keyed by node id. A member without an entry renders
   *  exactly as before. */
  egressPolicies?: Map<string, EgressPolicy>;
  /** Emit the AUTO profile: one extra rule at the entry that hands the exit
   *  choice to a latency balancer spanning every direction. Off unless the
   *  operator turned it on for this cascade. */
  auto?: boolean;
}

/** Per-direction outbound tag. Unlike the old index-based `-0/-1` suffix this
 *  is stable: it names the DIRECTION, which no longer moves when a neighbour
 *  is deleted. */
export function dirOutTag(directionTag: number, idx: number): string {
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
/**
 * How a node recognises "traffic heading for direction <tag>". An entry reads
 * the client's own choice out of its UUID (surfaced by xray as vlessRoute); a
 * transit cannot see that and matches the credential the leg arrived on.
 */
function directionCondition(
  directionTag: number,
  nodeId: string,
  input: TopologyInput,
  isEntry: boolean,
): Record<string, unknown> {
  if (isEntry) {
    return entryDirectionCondition(
      directionTag,
      (input.policies ?? []).map((p) => p.ordinal),
    );
  }
  return transitDirectionCondition(
    directionTag,
    input.links
      .filter((l) => l.toNodeId === nodeId && l.directionTag === directionTag)
      .map((l) => l.fromNodeId),
  );
}

/** The entry half of directionCondition, over the route-policy ordinals alone.
 *  Split out so the geo PREVIEW can produce the same condition from a draft,
 *  where there is no TopologyInput to read. */
export function entryDirectionCondition(
  directionTag: number,
  policyOrdinals: number[],
): Record<string, unknown> {
  const routeTags = [routeTag(0, directionTag - 1)];
  for (const ordinal of policyOrdinals) routeTags.push(routeTag(ordinal, directionTag - 1));
  // ⚠ STRING, comma-separated - never an array. xray parses `vlessRoute` with
  // its port-list parser, so an array of numbers fails the whole config with
  // "invalid port", and the core then refuses to start at all.
  return { vlessRoute: routeTags.join(',') };
}

/** The transit half of directionCondition, over the ids of the nodes on the
 *  PREVIOUS position (every one of them links here, once per direction). Split
 *  out for the same reason as its entry counterpart. */
export function transitDirectionCondition(
  directionTag: number,
  fromNodeIds: string[],
): Record<string, unknown> {
  return { user: fromNodeIds.map((from) => linkClientEmail(directionTag, from)) };
}

/** Where one direction's traffic actually leaves, given the outbounds that serve
 *  it: a balancer when the next step is a pool, a plain outbound otherwise.
 *  `balancers` collects the balancer definitions the caller must also emit. */
export function directionTargetFor(
  directionTag: number,
  outboundTags: string[],
  balancers: Record<string, unknown>[],
): Record<string, unknown> {
  // A pool on the next step means several outbounds serve one direction. Let
  // xray pick by latency rather than pinning the first, which is the whole
  // point of a pool.
  if (outboundTags.length > 1) {
    const balancerTag = `bal-d${directionTag}`;
    balancers.push({ tag: balancerTag, selector: outboundTags, strategy: { type: 'leastPing' } });
    return { balancerTag };
  }
  return { outboundTag: outboundTags[0]! };
}

/**
 * Pass 2 of a node's routing: its geo split, compiled into the rules that go
 * AHEAD of the plain direction rules so a geo match wins over "wherever the
 * client pointed".
 *
 * Two shapes, because a v4 way out is not one outbound:
 *   * direct / block / direction  - independent of what the client chose, so
 *     one rule each, matched on the geo condition alone.
 *   * link-out - means "the way out this client already chose", which here is
 *     a different target per direction. It cannot be one prepended rule, so it
 *     is emitted once PER DIRECTION, carrying that direction's own condition
 *     (vlessRoute at an entry, the arrival credential at a transit). Emitting
 *     it as a single rule would silently pin every client to one direction.
 *
 * Pulled out of buildTopologyFragmentsForNode so the panel's PREVIEW can show
 * the operator the very rules the node will get, rather than a second
 * implementation that agrees with this one until it stops agreeing.
 */
export function compileNodeGeoRules(
  policy: EgressPolicy,
  /** Where each direction egresses, from pass 1. */
  dirTargets: Map<number, Record<string, unknown>>,
  /** How this node recognises traffic bound for a direction. */
  conditionFor: (directionTag: number) => Record<string, unknown>,
): Record<string, unknown>[] {
  const targets: TargetRouting = {
    direct: { outboundTag: DIRECT_TAG },
    // `blocked` is the node-agent's base blackhole, always present.
    block: { outboundTag: 'blocked' },
  };
  for (const [tag, t] of dirTargets) targets[directionTargetKey(tag)] = t;

  const rules: Record<string, unknown>[] = [];
  const independent = policy.filter((r) => r.target !== 'link-out');
  rules.push(...compileEntryGeoRules(independent, targets).rules);

  const followsClient = policy.filter((r) => r.target === 'link-out');
  if (followsClient.length > 0) {
    for (const [directionTag, target] of dirTargets) {
      const compiled = compileEntryGeoRules(followsClient, { 'link-out': target });
      const condition = conditionFor(directionTag);
      for (const rule of compiled.rules) rules.push({ ...rule, ...condition });
    }
  }
  return rules;
}

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

  // ── Pass 1: resolve where each direction egresses. Done BEFORE any rule is
  // laid down so a geo policy can steer into a direction the client did not ask
  // for (target 'direction'), which needs every direction's target up front.
  const sortedDirections = [...byDirection.entries()].sort((a, b) => a[0] - b[0]);
  const dirTargets = new Map<number, Record<string, unknown>>();
  for (const [directionTag, tags] of sortedDirections) {
    const target = directionTargetFor(directionTag, tags, balancers);
    // leastPing needs somebody to measure the pings. Without an observatory
    // xray refuses the whole config with "not all dependencies are resolved"
    // and the core never starts - caught by the config-validity test, before
    // this shape reached a node.
    if ('balancerTag' in target) needsObservatory = true;
    dirTargets.set(directionTag, target);
  }

  // ── Pass 2: this NODE's geo split, ahead of the direction rules so a match
  // wins over the plain "wherever the client pointed" routing. See
  // compileNodeGeoRules for why link-out is not one rule.
  const nodePolicy = input.egressPolicies?.get(nodeId);
  if (nodePolicy && nodePolicy.length > 0) {
    routingRules.push(
      ...compileNodeGeoRules(nodePolicy, dirTargets, (directionTag) =>
        directionCondition(directionTag, nodeId, input, isEntry),
      ),
    );
  }

  // ── Pass 2b: the ad-split policies, ABOVE the direction rules.
  //
  // A policy band is offered to the subscriber as a second line per exit
  // ("DE · Без рекламы", tag = routeTag(ordinal, exit)), and the direction rule
  // below already carries that band so the line reaches the right exit. What
  // was missing is the policy DOING anything: without these rules the entry
  // routes the tagged client to its exit and applies no block or direct list at
  // all.
  //
  // Measured on a three-node stand 2026-08-28: through the plain line and
  // through "· Без рекламы" from the same subscription, `doubleclick.net`
  // answered 301 both times, and `category-ads-all` appeared ZERO times in the
  // entry's config. The subscriber picks an ad-blocking profile, gets a working
  // tunnel to the right country, and no ad blocking.
  //
  // buildCascadeConfigs (the legacy hop builder) has carried these rules since
  // 2026-07-30, and its comment there records this exact failure being fixed
  // once already - "an operator could define a policy, grant it to a squad,
  // watch the panel report success, and get no rules on the node at all". The
  // v4 builder that actually feeds nodes never got them.
  //
  // Per (policy, direction), not per policy: a v4 cascade can have several
  // exits, and the band's tag differs per exit. Ordering matters twice - above
  // the direction rules so the block wins before traffic enters the link, and
  // block before direct so an operator who lists a domain in both gets the
  // safer half.
  if (isEntry) {
    for (const p of input.policies ?? []) {
      const bandTags = [...dirTargets.keys()]
        .sort((a, b) => a - b)
        .map((directionTag) => routeTag(p.ordinal, directionTag - 1))
        .join(',');
      if (!bandTags) continue;
      if (p.blockDomains.length) {
        routingRules.push({
          type: 'field',
          vlessRoute: bandTags,
          domain: p.blockDomains,
          outboundTag: 'blocked',
        });
      }
      if (p.directDomains.length) {
        routingRules.push({
          type: 'field',
          vlessRoute: bandTags,
          domain: p.directDomains,
          outboundTag: DIRECT_TAG,
        });
      }
    }
  }

  // ── Pass 3: the direction rules themselves.
  for (const [directionTag, target] of dirTargets) {
    routingRules.push({
      type: 'field',
      ...directionCondition(directionTag, nodeId, input, isEntry),
      ...target,
    });
  }

  /**
   * AUTO: one more profile at the entry that names no direction at all and lets
   * the balancer pick the fastest way out.
   *
   * It must be an explicit rule, which is why this could not simply be drawn in
   * the client's list. There is no catch-all at a v4 entry: a tag with no rule
   * falls through to `freedom` and the user egresses from the ENTRY country
   * while their client says they chose otherwise. Wrong quietly is worse than
   * broken loudly, so a phantom Auto row was removed on 2026-08-15 and comes
   * back only now that the entry knows the tag.
   *
   * The selector is the link-out PREFIX, so it spans directions and any pools
   * inside them: the choice is "fastest hop out of here", not "fastest inside
   * the direction you already picked", which is what `bal-d<tag>` above does.
   *
   * Only worth it from two directions up. With one, auto resolves to the same
   * single destination, and the subscription would show a second line that does
   * exactly what the first one does.
   */
  if (isEntry && input.auto && byDirection.size > 1) {
    balancers.push({
      tag: AUTO_BALANCER_TAG,
      selector: [LINK_OUT_TAG],
      strategy: { type: 'leastPing' },
      // Where the Auto line goes when the balancer has NOTHING alive. Without
      // it, that connection lands on the default outbound - `direct` - and the
      // subscriber who picked "fastest exit" silently leaves from the ENTRY's
      // country, which is the one thing a cascade exists to prevent. Every
      // NAMED direction already refused in that state, because its rule pins
      // one outbound and a dead outbound is a failed connection; Auto was the
      // only line that failed open. Measured on a two-VM chain 2026-08-28.
      //
      // It has to be `fallbackTag` and not a rule behind this one: a
      // `balancerTag` rule that resolves to nothing does NOT fall through to
      // the next rule. Measured, after trying exactly that and watching it do
      // nothing - with `{vlessRoute: 65535, outboundTag: blocked}` sitting
      // directly after the balancer rule, the entry still logged
      // `[vless-in-… >> direct]` and the client still got 200. With
      // fallbackTag: `-> blocked`, and the client gets nothing. Decided
      // 2026-08-28: refuse, and tell the operator (cascade.events.ts).
      //
      // It costs NO startup window, which was the open worry when this landed:
      // the observatory has measured nothing for the first probeInterval after
      // a core restart, and the fear was that Auto would refuse for that whole
      // minute. Measured against xray 26.3.27 on 2026-08-29, three balancers
      // with this exact shape, first request ~2 s after start:
      //
      //   both members live        204
      //   one live, one dead       204
      //   both dead                000   (refused, and NOT leaked to direct)
      //
      // and the same three answers again past the first probe interval. So
      // leastPing treats an unmeasured member as selectable rather than dead:
      // Auto serves from the first request, and `fallbackTag` fires only when
      // the balancer genuinely resolves to nothing.
      fallbackTag: 'blocked',
    });
    needsObservatory = true;
    const autoTags = [autoRouteTag(0)];
    for (const p of input.policies ?? []) autoTags.push(autoRouteTag(p.ordinal));
    // Same STRING form as the per-direction rule above: an array here fails the
    // whole config and the core refuses to start.
    routingRules.push({
      type: 'field',
      vlessRoute: autoTags.join(','),
      network: 'tcp,udp',
      balancerTag: AUTO_BALANCER_TAG,
    });
  }

  // IPOnDemand only when THIS node's policy carries an ip/geoip matcher: under
  // the default IPIfNonMatch xray resolves a sniffed domain to an IP only if no
  // rule matched the first pass, so a geoip rule would never see that pass and
  // would be dead. Absent otherwise, so a node without a split renders
  // byte-identically to a plain cascade member.
  const domainStrategy = entryDomainStrategy(nodePolicy);

  return {
    nodeId,
    position: posIndex >= 0 ? posIndex : input.positions.length,
    role,
    ...(domainStrategy ? { domainStrategy } : {}),
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
  const vless = links.filter((l) => l.cred.protocol === 'vless');
  // The receiving half of the camouflage. Rendered from the FIRST cred's
  // identity because every link into one node shares it by construction (see
  // realityForReceiver) - the port is shared per receiving step and an inbound
  // carries exactly one privateKey.
  //
  // `shortIds` is the list that keeps the links distinguishable: xray accepts
  // several, and each dialler presents its own.
  //
  // This used to be hardcoded to `security: 'none'` with no flow, while
  // vlessLinkOutbound rendered REALITY+Vision from the same cred. Both ends
  // agreed only because the reality block never survived persistence; the
  // moment it did, the receiver would have answered TLS bytes as a plain VLESS
  // header - `proxy/vless/encoding: invalid request version`, measured.
  const reality = (first as VlessLinkCred).reality;
  const shortIds = [
    ...new Set(
      vless
        .map((l) => (l.cred as VlessLinkCred).reality?.shortId)
        .filter((id): id is string => !!id),
    ),
  ];
  return {
    tag: LINK_IN_TAG,
    port: first.port,
    listen: '0.0.0.0',
    protocol: 'vless',
    settings: {
      clients: vless.map((l) => ({
        id: (l.cred as VlessLinkCred).uuid,
        email: linkClientEmail(l.directionTag, l.fromNodeId),
        // Vision is negotiated per USER: a client that sends a flow the account
        // does not name is rejected, and so is one that sends none when it
        // does. Both halves come from the same condition for that reason.
        ...(reality ? { flow: 'xtls-rprx-vision' } : {}),
      })),
      decryption: 'none',
    },
    streamSettings: reality
      ? {
          network: 'raw',
          security: 'reality',
          realitySettings: {
            dest: reality.dest,
            serverNames: [reality.serverName],
            privateKey: reality.privateKey,
            shortIds,
          },
        }
      : { network: 'raw', security: 'none' },
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
/**
 * How often the entry re-measures its exits, and therefore how long it can keep
 * sending traffic into a dead one.
 *
 * `leastPing` reads the LAST measurement and skips exits marked not alive, so
 * this interval IS the failure-detection window: nothing else tells the entry an
 * exit died. It was 5m, inherited from the pre-v4 balancer cascade where nobody
 * had thought about failure. Caught in the field on 2026-08-15: with the Dutch
 * exit stopped, one entry had already moved to Sweden while the other kept
 * dialling the dead one, and would have for minutes.
 *
 * A minute is also xray's own default for its burst health-pinger. The cost is
 * one request per exit per entry per minute, which is noise next to user traffic.
 * Below ~30s the measurement starts reporting network jitter rather than the
 * state of the exit.
 *
 * That leastPing picks between two LIVE exits by this measurement — as opposed
 * to merely skipping a dead one, which is all any earlier run had shown — was
 * measured on 2026-08-29 on three real VMs: one entry, and a direction whose
 * pool held both exits, so `bal-d1` carried two members. 150 ms of netem was
 * put on one exit's interface, a real client drove ten requests through the
 * entry, and the exits' own `cascade-link-in` byte counters were read:
 *
 *   exit B slowed   exit A +123 803 bytes   exit B      +0 bytes
 *   exit A slowed   exit A       +0 bytes   exit B +121 953 bytes
 *
 * The second row is the control: without it "A always wins" would also fit an
 * entry that simply takes the first member of the selector.
 */
const OBSERVATORY_PROBE_INTERVAL = '1m';

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
 *  the high byte, the exit index the low one. 254 policies is far past any real
 *  use, but the bound has to exist somewhere, and this is where it comes from.
 *
 *  254 rather than 255 because the top band belongs to the Auto tags below.
 *  With 255 allowed, the two spaces met at exactly one value - policy 255 on
 *  direction 255 IS plain Auto - and a collision there is not a wrong label, it
 *  is a user leaving through an exit they did not choose. */
export const MAX_DIRECTION_ORDINAL = 254;

/**
 * Tag of the AUTO profile: "let the entry pick the exit by latency".
 *
 * Taken from the top of the uint16 space downwards, so it cannot collide with
 * `routeTag`, which grows from the bottom: a collision would need 255 policies
 * and 255 directions at once. Reserving the natural-looking value instead
 * (`policyOrdinal * 256`, i.e. exit index -1) would have put the plain profile
 * on tag 0, and xray reads `vlessRoute` with its port-list parser, where 0 is
 * not a value we want to lean on.
 *
 * Both sides use this: the node routes it to the auto balancer, the
 * subscription writes it into the UUID of the "Auto" line.
 */
export function autoRouteTag(policyOrdinal: number): number {
  return 0xffff - policyOrdinal;
}

/** Whether a tag names an Auto profile rather than a direction. The Auto band
 *  is the top `MAX_DIRECTION_ORDINAL + 1` values; everything below belongs to
 *  `routeTag`. Used by the subscription, which has to recognise an Auto line
 *  without carrying a second flag alongside every tag. */
export function isAutoRouteTag(tag: number): boolean {
  return tag >= autoRouteTag(MAX_DIRECTION_ORDINAL);
}

/** Balancer that spans every direction of one entry, as opposed to `bal-d<tag>`
 *  which spans the pool INSIDE one direction. */
const AUTO_BALANCER_TAG = 'bal-auto';

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
      /**
       * AUTO with an ad-split policy. The plain Auto tag needs no rule here,
       * the catch-all below already means "let the balancer choose", but a
       * policy variant does: its domain rules are keyed on the tag, so without
       * these lines an "Auto · no ads" profile would fall through and quietly
       * serve ads while the client's list said otherwise.
       */
      ...policies.flatMap((p) => {
        const tag = String(autoRouteTag(p.ordinal));
        return [
          ...(p.blockDomains.length
            ? [{ type: 'field', vlessRoute: tag, domain: p.blockDomains, outboundTag: 'blocked' }]
            : []),
          ...(p.directDomains.length
            ? [{ type: 'field', vlessRoute: tag, domain: p.directDomains, outboundTag: DIRECT_TAG }]
            : []),
        ];
      }),
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
