import type { User, UserTraffic } from '../../generated/prisma/client.js';
import type { ProtocolName } from '@iceslab/shared';

// Re-export so existing imports keep working (slice 16 moved the
// implementation into core-adapters/hysteria, this file now hosts only
// the format-level helpers that are not protocol-specific).
export { buildHysteriaUri, type HysteriaUriOpts } from '../../core-adapters/hysteria/index.js';
export {
  buildVlessRealityUri,
  type VlessRealityUriOpts,
  buildTrojanRealityUri,
  type TrojanRealityUriOpts,
  buildVmessUri,
  type VmessUriOpts,
} from '../../core-adapters/xray/index.js';
export {
  buildShadowsocksUri,
  type ShadowsocksUriOpts,
  type ShadowsocksMethod,
} from '../../core-adapters/shadowsocks/index.js';
export {
  buildMtprotoUri,
  buildMtprotoTmeUri,
  mtprotoSecret,
  type MtprotoUriOpts,
} from '../../core-adapters/mtproto/index.js';
export {
  buildMieruUri,
  buildMieruProfileJson,
  type MieruUriOpts,
  type MieruProfileOpts,
  type MieruProfileJson,
} from '../../core-adapters/mieru/index.js';
export { buildTuicUri, type TuicUriOpts } from '../../core-adapters/tuic/index.js';
export { buildAnytlsUri, type AnytlsUriOpts } from '../../core-adapters/anytls/index.js';

/**
 * Strip the optional `:port` suffix from a `host[:port]` string, returning the
 * host. IPv6-aware: a bare `indexOf(':')` split mangled `2001:db8::1` into
 * `2001`. Handles bracketed (`[::1]:443`) and bare (`2001:db8::1`) IPv6.
 */
export function hostFromAddress(address: string): string {
  // Bracketed IPv6: `[::1]` or `[::1]:443` → return the bracketed host.
  if (address.startsWith('[')) {
    const close = address.indexOf(']');
    return close === -1 ? address : address.slice(0, close + 1);
  }
  // Bare IPv6 (more than one colon, no brackets) has no unambiguous port
  // suffix to strip, return it untouched rather than truncating at the
  // first colon.
  if (address.indexOf(':') !== address.lastIndexOf(':')) {
    return address;
  }
  // Plain `host:port` or bare host.
  const idx = address.indexOf(':');
  return idx === -1 ? address : address.slice(0, idx);
}

/**
 * U5 - can this endpoint be expressed at all without VLESS-Encryption?
 *
 * A vless endpoint whose inbound runs `decryption` needs the client to send the
 * matching `encryption`; a format with nowhere to put that string can only
 * produce an outbound that the node refuses at handshake time. sing-box has no
 * such field on its VLESS outbound at all (option/vless.go), and neither Loon
 * nor Quantumult X expose one, so those three skip the endpoint instead of
 * shipping a config that cannot work. An empty section in a client is a bad
 * outcome; a server entry that fails every connect and says nothing is worse.
 *
 * Not applicable to the ML-DSA-65 verify key: dropping that one degrades the
 * connection to classical REALITY, it does not break it.
 */
export function cannotCarryVlessEncryption(e: SubscriptionEndpoint): boolean {
  return (
    e.protocol === 'xray' && (e.subprotocol ?? 'vless') === 'vless' && !!e.vlessEncryption
  );
}

/**
 * Should this endpoint's Vision flow be emitted?
 *
 * `xtls-rprx-vision` splices the TLS record layer, so it only works when the
 * stream IS the TLS stream: RAW and XHTTP. Over ws/grpc/httpupgrade/kcp it is
 * not a weaker configuration but an invalid one, and the core refuses it - so a
 * subscription carrying that pair is a config the client will not load.
 *
 * This is reachable by DEFAULT rather than in a corner. `flow` defaults to
 * `xtls-rprx-vision`, and the inbound schema says outright that the panel
 * "doesn't enforce this at write time, the operator must align flow + network
 * themselves" (inbounds.schemas.ts). An operator who moves an inbound to `ws`
 * and does not think about `flow` produces exactly this.
 *
 * `core-adapters/xray/uri.ts` has always applied the rule, which is why the
 * plain URI list every client gets by default was never affected and only the
 * rich formats were. Here so that the rule lives in ONE place: it was written
 * out five times, four of them checking only for TLS and forgetting the
 * transport, and the fifth (Loon) not even checking for TLS.
 */
export function emitsVisionFlow(e: SubscriptionEndpoint): boolean {
  if (e.protocol !== 'xray' || !e.flow) return false;
  if ((e.securityLayer ?? 'default') === 'none') return false;
  const network = e.network ?? 'raw';
  return network === 'raw' || network === 'xhttp';
}

/**
 * Can this format carry the endpoint's stream transport at all?
 *
 * The same trade as `cannotCarryVlessEncryption`, one layer down. A client that
 * has no XHTTP transport does not render an XHTTP endpoint badly - it has
 * nowhere to put it, so the entry it imports names a server it dials over plain
 * TCP and never reaches. That is the outcome the rule above exists to avoid, and
 * it was happening in ten places (see `formats/transport-matrix.test.ts`).
 *
 * `carried` is the set that FORMAT can express, established per client rather
 * than assumed:
 *   - sing-box: RAW/WS/gRPC/HTTPUpgrade. XHTTP is refused upstream on purpose
 *     ("no plan" from the maintainer), and mKCP is not among its V2Ray
 *     transports either.
 *   - Quantumult X: RAW and WS only - its VLESS line spells transports through
 *     `obfs=`, and the official sample.conf carries `http`, `ws`, `wss` and
 *     `over-tls` and nothing else.
 *   - Loon: RAW and WS upstream; `grpc` is kept because this builder already
 *     emitted it and removing it on no evidence would be a regression by guess.
 *   - Surge: RAW and WS, in the trojan/vmess branch that is the only place it
 *     emits xray endpoints at all.
 *
 * Mihomo is absent on purpose: it DOES implement XHTTP (since v1.19.22), so
 * `clash.ts` passing the transport through is correct and nothing is skipped.
 *
 * `raw` is always carriable - there is no transport to express.
 */
export function cannotCarryTransport(
  e: SubscriptionEndpoint,
  carried: readonly string[],
): boolean {
  if (e.protocol !== 'xray') return false;
  return !carried.includes(e.network ?? 'raw');
}

/**
 * Universal subscription body: base64 of newline-separated URIs. Works with
 * every mainstream client (NekoRay, Hiddify, v2rayN, ...).
 */
export function encodePlainList(uris: string[]): string {
  // Filter empty URIs: neither wg flavour has a URL form, so those endpoints
  // contribute nothing to the universal plain-list body. Clients that want
  // AmneziaWG or WireGuard fetch with `?format=wgconf`.
  const nonEmpty = uris.filter((u) => u.length > 0);
  return Buffer.from(nonEmpty.join('\n'), 'utf8').toString('base64');
}

interface SubscriptionEndpointBase {
  protocol: ProtocolName;
  /**
   * DISPLAY LABEL, not the node's name, whatever the field is called: it is
   * built by `subscriptionServerName` out of the flag, the host remark and the
   * node name, and a cascade entry emits several endpoints carrying different
   * labels off one node. Never join on it. `nodeId` below is the join key.
   */
  nodeName: string;
  /**
   * Node this endpoint is served from. Added 2026-07-31: the admin endpoints
   * view needed to show which of them are live, and the only other field that
   * looked like an identity was the label above, which is not one.
   */
  nodeId: string;
  /** Public host the client connects to (no port). */
  host: string;
  /** Public port the client connects to. */
  port: number;
  /** Pre-built URI for plain-list/JSON formats. Format-specific builders
   *  (Clash, Sing-box, ...) consume the structured fields below instead. */
  uri: string;

  // ───── Slice 30: per-host metadata ──────────────────────────────────
  // Each binding can fan out into N hosts. The fields below identify
  // which host produced this endpoint and carry overrides that aren't
  // baked into `uri` yet (slice 30.1 will light up emission).

  /** Host row id this endpoint was emitted from. Undefined for legacy
   *  bindings that have zero hosts (back-compat fallback). */
  hostId?: string;
  /** Admin-facing label of the originating host. Useful for debugging
   *  why a particular URL appears in the subscription. */
  hostRemark?: string;
  /** ALPN list: emitted by clash/singbox formatters when non-empty. */
  alpn?: string[];
  /** `?allowInsecure=1` flag for self-signed CDN front. */
  allowInsecure?: boolean;
  /** Forces client-side TLS layer when the host fronts the inbound through
   *  a CDN that terminates TLS. `default` keeps adapter behaviour. */
  securityLayer?: 'default' | 'tls' | 'none';
  /** Subscription formats this endpoint must NOT be emitted in. The route
   *  handler filters by this before invoking the format-specific formatter,
   *  so each formatter can stay format-agnostic. */
  disableForFormats?: string[];

  // ───── A4: route-profiles (exit x policy selection) ─────────────────
  /** When this endpoint's node is the ENTRY of an enabled balancer cascade, the
   *  route-PROFILES a user may pick there = (allowed exit) x (plain OR a granted
   *  ad-split policy). buildXrayJsonArray / expandEndpointUris expand one such
   *  endpoint into one standalone config per profile: same entry host, UUID bytes
   *  7-8 set to the profile's `tag` (xray reads them as `vlessRoute`, auth ignores
   *  them), remark = `label`. `tag` is computed by routeTag(policyOrdinal,
   *  exitIndex) so the entry node's routing rules and this UUID agree. `label` is
   *  the exit name (plain) or `exit · policy` (ad-split). Empty/undefined = a
   *  single plain config (the pre-A4 behaviour, non-balancer-entry endpoints).
   *  Only the xrayjson-array + plain formats consume this. */
  cascadeExits?: { label: string; tag: number; cascadeId?: string }[];
}

export interface HysteriaSubscriptionEndpoint extends SubscriptionEndpointBase {
  protocol: 'hysteria';
  password: string;
  /** Salamander obfuscation password: present only when the inbound has
   *  `obfsPassword` set. Critical on RU/IR/CN ISPs that DPI-throttle bare QUIC. */
  obfsPassword?: string;
  /** Brutal CC bandwidth declaration in Mbps. Forwarded into URI / singbox
   *  / clash output so the client negotiates a non-zero send window. See
   *  HysteriaUriOpts.upMbps for the gory detail. */
  upMbps?: number;
  downMbps?: number;
  /** Port-hopping range (slice 31.5). When set, URI emits `mport=`, sing-box
   *  emits `server_ports`, and Clash Meta emits `ports`. The server-side
   *  iptables redirect (configured at install-node time) must cover at
   *  least this range for the rotating ports to actually reach hysteria. */
  portHoppingStart?: number;
  portHoppingEnd?: number;
}

export interface XraySubscriptionEndpoint extends SubscriptionEndpointBase {
  protocol: 'xray';
  /** UUID: used both as VLESS userId and (slice 24c part 3) as Trojan password. */
  uuid: string;
  publicKey: string;
  shortId: string;
  sni: string;
  flow: string;
  fingerprint: string;
  network: 'raw' | 'xhttp' | 'ws' | 'grpc' | 'httpupgrade' | 'kcp';
  path?: string;
  hostHeader?: string;
  serviceName?: string;
  /**
   * XHTTP packet framing, when `network` is xhttp. Carried to the CLIENT, not
   * just configured on the node: xray's server refuses a request whose framing
   * its own `mode` does not allow (`transport/internet/splithttp/hub.go` answers
   * 400 with "packet-up mode is not allowed" and siblings), and a client left on
   * `auto` picks its framing from whether REALITY is in use
   * (`dialer.go`: REALITY -> stream-one, otherwise packet-up). So the two ends
   * disagreeing is an outage, not a wasted option - see the emitters.
   */
  xhttpMode?: 'auto' | 'packet-up' | 'stream-up' | 'stream-one';
  /** Slice 24c part 3: controls URI scheme (`vless://` vs `trojan://`)
   *  and downstream singbox/clash outbound type. */
  subprotocol?: 'vless' | 'trojan' | 'vmess';

  // ───── U5: the client halves of the post-quantum material ───────────
  // The profile stores both halves of each pair; these are the ones that only
  // ever leave the panel towards a client. Set only where they mean something:
  // `vlessEncryption` on the vless subprotocol, `realityMldsa65Verify` on the
  // reality layer.

  /** Client half of VLESS-Encryption. Formats that can carry it emit it
   *  (`encryption=` in the URI, the VLESS user's `encryption` in xray JSON,
   *  `encryption:` in Clash); formats that cannot must SKIP the endpoint
   *  rather than emit one - see `cannotCarryVlessEncryption`. */
  vlessEncryption?: string;
  /** Client half of post-quantum REALITY (ML-DSA-65 verify key). Formats that
   *  cannot carry it emit the endpoint anyway: the client then verifies the
   *  certificate the classical way and connects, which is a downgrade rather
   *  than an outage. */
  realityMldsa65Verify?: string;
}

export interface AmneziawgSubscriptionEndpoint extends SubscriptionEndpointBase {
  protocol: 'amneziawg';
  /**
   * Which of the buyer's devices this config belongs to. Two devices on one
   * node are two endpoints that differ ONLY here and in the key, so every
   * surface that used to dedupe wg by node has to dedupe by (node, device)
   * instead - otherwise the second device silently disappears from the
   * subscription while its peer sits on the node.
   */
  deviceId: string;
  /** 1-based position in the buyer's device list, stable across polls. */
  deviceIndex: number;
  /** This device's WireGuard private key. */
  privateKey: string;
  /** Preshared key for this peer, absent when the profile issues none. */
  presharedKey?: string;
  /** IP allocated to this user inside the inbound's subnet, CIDR /32 form. */
  allowedIp: string;
  /** Server's WireGuard public key (the inbound's interface PublicKey). */
  serverPublicKey: string;
  /** Junk/header obfuscation parameters: must match the server inbound. */
  jc: number;
  jmin: number;
  jmax: number;
  s1: number;
  s2: number;
  s3: number;
  s4: number;
  h1: number;
  h2: number;
  h3: number;
  h4: number;
  /** I1-I5 mimicry packets (hex, v2.0). Empty = disabled for that slot. */
  i1: string;
  i2: string;
  i3: string;
  i4: string;
  i5: string;
}

/**
 * Upstream WireGuard. Carries no obfuscation fields at all — not zeroed ones —
 * so no formatter can accidentally emit an AmneziaWG directive into a config
 * a stock WireGuard client has to parse.
 */
export interface WireguardSubscriptionEndpoint extends SubscriptionEndpointBase {
  protocol: 'wireguard';
  /** Which of the buyer's devices this is - see AmneziawgSubscriptionEndpoint. */
  deviceId: string;
  /** 1-based position in the buyer's device list, stable across polls. */
  deviceIndex: number;
  /** This device's WireGuard private key (one keypair serves both flavours). */
  privateKey: string;
  /** Preshared key for this peer, absent when the profile issues none. */
  presharedKey?: string;
  /** IP allocated to this user inside the inbound's subnet, CIDR /32 form. */
  allowedIp: string;
  /** Server's WireGuard public key (the inbound's interface PublicKey). */
  serverPublicKey: string;
}

export interface NaiveSubscriptionEndpoint extends SubscriptionEndpointBase {
  protocol: 'naive';
  username: string;
  password: string;
}

export interface ShadowsocksSubscriptionEndpoint extends SubscriptionEndpointBase {
  protocol: 'shadowsocks';
  /** SS2022 / legacy AEAD cipher. Drives the URI's method tuple and the
   *  outbound shape in sing-box / Clash formatters. */
  method:
    | '2022-blake3-aes-128-gcm'
    | '2022-blake3-aes-256-gcm'
    | '2022-blake3-chacha20-poly1305'
    | 'chacha20-ietf-poly1305'
    | 'aes-256-gcm'
    | 'aes-128-gcm';
  password: string;
}

export interface MtprotoSubscriptionEndpoint extends SubscriptionEndpointBase {
  protocol: 'mtproto';
  /** Per-user Fake-TLS secret (hex, `ee<32-bytes><domain-hex>`). */
  secret: string;
  /** The masquerade domain: useful for non-URI formats that want it
   *  surfaced separately from the embedded hex. */
  domain: string;
  /** `https://t.me/proxy?...`: clickable in any browser/messenger. */
  tmeUri: string;
}

export interface MieruSubscriptionEndpoint extends SubscriptionEndpointBase {
  protocol: 'mieru';
  username: string;
  password: string;
  mtu: number;
}

export interface TuicSubscriptionEndpoint extends SubscriptionEndpointBase {
  protocol: 'tuic';
  /** UUID (reuses user.xrayUuid) and derived password. */
  uuid: string;
  password: string;
  /** TLS SNI the node's self-signed cert is issued for. */
  serverName: string;
  /** Congestion controller: bbr | cubic | new_reno. */
  congestionControl: string;
}

export interface AnytlsSubscriptionEndpoint extends SubscriptionEndpointBase {
  protocol: 'anytls';
  /** Per-user password (derived from user.xrayUuid). */
  password: string;
  /** TLS SNI the node's self-signed cert is issued for. */
  serverName: string;
}

export interface ShadowtlsSubscriptionEndpoint extends SubscriptionEndpointBase {
  protocol: 'shadowtls';
  /** Per-user ShadowTLS v3 password (derived from user.xrayUuid). */
  shadowtlsPassword: string;
  /** Camouflage handshake host the shadowtls layer fronts (also the SNI). */
  handshake: string;
  /** Inner shadowsocks cipher + server-wide key (the ss layer under shadowtls). */
  ssMethod: string;
  ssPassword: string;
}

export type SubscriptionEndpoint =
  | HysteriaSubscriptionEndpoint
  | XraySubscriptionEndpoint
  | AmneziawgSubscriptionEndpoint
  | WireguardSubscriptionEndpoint
  | NaiveSubscriptionEndpoint
  | ShadowsocksSubscriptionEndpoint
  | MtprotoSubscriptionEndpoint
  | MieruSubscriptionEndpoint
  | TuicSubscriptionEndpoint
  | AnytlsSubscriptionEndpoint
  | ShadowtlsSubscriptionEndpoint;

export interface SubscriptionJsonResponse {
  user: {
    id: string;
    shortId: string;
    username: string;
    status: string;
    expireAt: string | null;
    trafficLimitBytes: number | null;
    trafficUsedBytes: number;
  };
  endpoints: SubscriptionEndpoint[];
}

/**
 * Structured JSON for IcePath-VPN Mini-App (Go) and Ice-Client (Rust).
 * Includes user-state metadata so clients can show quota/expiry without a
 * second request.
 */
export function buildSubscriptionJson(
  user: User & { traffic: UserTraffic | null },
  endpoints: SubscriptionEndpoint[],
): SubscriptionJsonResponse {
  return {
    user: {
      id: user.id,
      shortId: user.shortId,
      username: user.username,
      status: user.status,
      expireAt: user.expireAt ? user.expireAt.toISOString() : null,
      trafficLimitBytes:
        user.trafficLimitBytes !== null ? Number(user.trafficLimitBytes) : null,
      trafficUsedBytes: user.traffic ? Number(user.traffic.usedTrafficBytes) : 0,
    },
    endpoints,
  };
}
