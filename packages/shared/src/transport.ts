/**
 * DTOs for the panel→node REST+mTLS API.
 *
 * These types are the wire-format contract. The Go node-agent reimplements
 * matching structs with json tags; the panel-backend imports them directly.
 *
 * Byte counts are typed as `number` for ergonomics, values comfortably fit
 * in a JS double for any realistic single-period traffic. Lifetime totals
 * may eventually need string encoding; revisit when quotas exceed ~8 PB.
 */

export type ProtocolName =
  | 'hysteria'
  | 'xray'
  | 'amneziawg'
  | 'wireguard'
  | 'naive'
  | 'shadowsocks'
  | 'mtproto'
  | 'mieru'
  | 'tuic'
  | 'anytls'
  | 'shadowtls';

/** Which proxy core renders an inbound. Most protocols have a single native
 *  core; the shared protocols (vless/vmess/trojan + ss on xray-core, hy2 on
 *  hysteria) can alternatively be served by the sing-box engine. tuic/anytls
 *  are singbox-only. Omit `engine` on an inbound to use the native core. */
export type EngineName = 'xray' | 'hysteria' | 'singbox';

export interface ProtocolCredentials {
  hysteriaPassword?: string;
  xrayUuid?: string;
  naivePassword?: string;
  amneziawgPublicKey?: string;
  /**
   * IP allocated to this user inside the AmneziaWG inbound's subnet
   * (e.g. "10.0.0.42"). Panel-backend assigns it via the IP allocator
   * service before issuing the addUser request; node-agent writes it
   * straight into the [Peer] AllowedIPs field as `<ip>/32`.
   */
  amneziawgAllowedIp?: string;
  /** Upstream WireGuard: the same per-user keypair as AmneziaWG (one WG
   *  identity per user), sent under its own name so a node serving one
   *  flavour infers nothing about the other. */
  wireguardPublicKey?: string;
  /** IP allocated inside the *WireGuard* inbound's subnet. A node bound to
   *  both flavours gets two addresses for one user; they differ, and crossing
   *  them puts a peer on an interface whose subnet doesn't contain it. */
  wireguardAllowedIp?: string;
  /**
   * Optional preshared keys, one per flavour, because the panel enables them
   * per PROFILE: a node may serve plain WireGuard with them and AmneziaWG
   * without. Absent means the node writes no `PresharedKey` line, which is
   * what every config issued before this field expects — and a peer whose key
   * disagrees with its client's cannot complete a handshake at all, so this is
   * one of the few fields where "send it sometimes" has to be exact.
   */
  amneziawgPresharedKey?: string;
  wireguardPresharedKey?: string;
  /** TUIC v5 (sing-box engine): per-user UUID + password. */
  tuicUuid?: string;
  tuicPassword?: string;
  /** AnyTLS (sing-box engine): per-user password (password-only auth). */
  anytlsPassword?: string;
  /** ShadowTLS v3 (sing-box engine): per-user password for the shadowtls
   *  users[] (the inner shadowsocks key is server-wide, in the inbound config). */
  shadowtlsPassword?: string;
  /**
   * MTProto, `mtprotoproxy` engine ONLY: the user's own 32-hex-char secret.
   *
   * The `mtproto` (mtg) engine has no use for it and never will — mtg is
   * single-secret by design and derives its one secret from the INBOUND, which
   * is why MTProto on that engine cannot be counted or revoked per user. This
   * field is what makes the other engine possible: the node writes it into
   * USERS, and metrics come back labelled with the user it belongs to.
   *
   * Absent for users on an mtg inbound. The mtprotoproxy adapter REFUSES a user
   * that arrives without it rather than generating one: a secret the panel did
   * not issue does not match the link the buyer already holds, and the result
   * is a user who exists on the node and cannot connect.
   */
  mtprotoSecret?: string;
}

// ───── POST /addUser ─────

export interface AddUserRequest {
  userId: string;
  shortId: string;
  username: string;
  credentials: ProtocolCredentials;
}

export interface AddUserResponse {
  ok: true;
}

// ───── POST /applyInbounds ─────
//
// Panel pushes the FULL set of inbounds bound to this node every time any
// inbound is created/updated/deleted (or the node itself is registered).
// Node-agent diffs against current state and regenerates the protocol's
// config file accordingly. Idempotent: re-sending the same set is a no-op.
//
// Replaces the manual `/etc/iceslab-node/env` editing that admins had to
// do before slice 24. The XRAY_REALITY_*  / HY_DOMAIN env vars stay
// supported as a fallback for nodes that haven't received their first
// applyInbounds yet (or for air-gapped setups).

/** Per-protocol inbound config, discriminated by `protocol`. The shape
 *  mirrors `apps/panel-backend/src/modules/inbounds/inbounds.schemas.ts`
 *  but flattened (no Zod refinements). Panel sends, node decodes. */
export interface InboundDto {
  /** Stable UUID, node-agent uses it as the protocol-side `tag`. */
  id: string;
  /** Human-friendly name (becomes Xray inbound `tag`, Hysteria masquerade
   *  hint, etc, purely informational on the node side). */
  name: string;
  protocol: ProtocolName;
  /** Proxy core that renders this inbound. Omit -> the protocol's native core
   *  (xray for vless/vmess/trojan/ss, hysteria for hy2, singbox for
   *  tuic/anytls). Set to 'singbox' to serve a shared protocol via sing-box. */
  engine?: EngineName;
  /** Listen port (UDP for hysteria/awg, TCP for xray/naive). */
  port: number;
  /** Per-protocol settings. The discriminant is `protocol` above. */
  config:
    | XrayInboundCfg
    | HysteriaInboundCfg
    | AmneziawgInboundCfg
    | NaiveInboundCfg
    | ShadowsocksInboundCfg
    | MtprotoInboundCfg
    | MieruInboundCfg
    | TuicInboundCfg
    | AnytlsInboundCfg
    | ShadowtlsInboundCfg;
}

export interface XrayInboundCfg {
  /**
   * Identity of THIS inbound, so the agent can hold several at once.
   *
   * Rides inside the config rather than as an argument because `ApplyInbound`
   * is shared by all seven core adapters: widening its signature to carry an id
   * would touch every one of them for the benefit of a single core.
   *
   * The agent keys its stored inbounds on this. It must stay stable for the
   * life of the inbound: traffic counters are tagged with it, so a changed id
   * reads as a brand-new inbound and zeroes the accounting on that node.
   *
   * Optional for now: an agent from before multi-inbound ignores it, and a
   * panel that omits it keeps the old single-inbound behaviour.
   */
  inboundId?: string;
  /** Stream security. 'reality' (default), 'none' (plain transport, for
   *  ws/httpupgrade behind a CDN that terminates TLS, or local testing), or
   *  'tls' (node-terminated TLS with an operator-supplied certificate). The
   *  reality* fields are required only for 'reality'; the tls* fields only for
   *  'tls'. */
  security?: 'reality' | 'none' | 'tls';
  /** TLS (security='tls'): SNI / cert common name the node serves. */
  tlsServerName?: string;
  /** TLS cert chain (PEM). Operator-supplied; embedded inline in the xray
   *  config's tlsSettings.certificates (no ACME on the node). */
  tlsCert?: string;
  /** TLS private key (PEM), paired with tlsCert. */
  tlsKey?: string;
  /** Reject TLS handshakes whose SNI matches no served server name. */
  tlsRejectUnknownSni?: boolean;
  realityDest: string;            // e.g. "www.cloudflare.com:443"
  realityServerNames: string[];   // SNI candidates
  realityShortIds: string[];      // hex strings, 0..16 chars even-length
  realityPrivateKey: string;      // base64url (REALITY-style, NOT WireGuard base64)
  realityPublicKey: string;
  /** REALITY protocol version mirrored to the upstream dest (0|1|2). */
  realityXver?: number;
  /** Max client/node clock skew (ms) REALITY tolerates; 0 = xray default. */
  realityMaxTimeDiff?: number;
  /** U5 post-quantum: server ML-DSA-65 seed (`xray mldsa65`) adding an extra PQ
   *  signature to the REALITY cert. Absent → off (byte-identical to pre-U5).
   *  Enabling it requires the target cert to be >3500 bytes. Mirrors the Go
   *  json tag exactly (wire-sync). */
  realityMldsa65Seed?: string;
  /** U5 post-quantum: server-side VLESS-Encryption string
   *  (`mlkem768x25519plus.native.…`, from `xray vlessenc`) — ML-KEM-768 native
   *  VLESS encryption with PFS. Absent → VLESS decryption is "none"
   *  (byte-identical to pre-U5). Only the vless subprotocol uses it. */
  vlessDecryption?: string;
  /** G - throttle unverified REALITY fallback (probe) connections, bytes/sec; 0 = off. */
  realityLimitFallbackUploadBytesPerSec?: number;
  realityLimitFallbackDownloadBytesPerSec?: number;
  /** K9-B - how REALITY borrows a TLS identity:
   *   - 'steal-others' (default/empty): dest = an external camouflage site;
   *     works outside RU but SNI-IP-mismatches under RU-DPI.
   *   - 'self-steal': the node-agent runs a local TLS fallback and REALITY's
   *     dest points at it (127.0.0.1:8443), with serverNames = the node's own
   *     domain so SNI and IP stay consistent. Set serverNames to a domain that
   *     resolves to the node IP; the node ignores realityDest in this mode. */
  realityMode?: 'steal-others' | 'self-steal';
  /** G1 - real site the self-steal local TLS fallback reverse-proxies probe
   *  requests to (so a prober sees genuine content). Empty = static landing.
   *  Only used when realityMode is 'self-steal'. */
  realityFallbackUpstream?: string;
  flow: 'xtls-rprx-vision' | 'none';
  fingerprint: string;            // chrome / firefox / safari / etc
  network: 'raw' | 'xhttp' | 'ws' | 'grpc' | 'httpupgrade' | 'kcp';
  path?: string;                  // ws/xhttp/httpupgrade
  host?: string;                  // ws/xhttp/httpupgrade Host header override
  serviceName?: string;           // grpc
  /** XHTTP packet mode; 'auto' (default) lets xray pick the framing. */
  xhttpMode?: 'auto' | 'packet-up' | 'stream-up' | 'stream-one';
  /** XHTTP request-padding byte range (e.g. "100-1000"); empty disables. */
  xhttpPaddingBytes?: string;
  /** gRPC multiMode: multiplex several streams per connection. */
  grpcMultiMode?: boolean;
  /** Subprotocol carried by the xray inbound. `vless` (default) → per-user
   *  UUID with optional Vision flow; `trojan` → per-user password (we reuse
   *  user.xrayUuid); `vmess` → per-user UUID, AEAD (no flow). VMess pairs with
   *  security 'none'/'tls' only (its share link cannot carry REALITY). */
  subprotocol?: 'vless' | 'trojan' | 'vmess';
  /** C3 cascade chaining fragments for THIS node's hop. Generated panel-side
   *  by buildCascadeConfigs and merged into the node's xray config:
   *  link-in inbound (transit/exit nodes), link-out outbound (entry/transit
   *  nodes), and the per-role routing rules. Absent for plain (non-cascade)
   *  nodes, in which case the node renders exactly as before. */
  cascade?: XrayCascadeFragments;
  /** Cloudflare WARP egress (per-node v1). When present, the node renders a
   *  wireguard outbound to WARP and routes this inbound's user traffic through
   *  it. Registered + provisioned panel-side. Absent = direct egress (default).
   *  See docs/studies/STUDY-warp-native.md. */
  warp?: WarpCfg;
  /** U4 configurable anti-abuse: which built-in BLOCK rules this node renders.
   *  See AbusePolicyCfg. */
  abusePolicy?: AbusePolicyCfg;
  /** B1 the node's compiled egress policy. Injected by the panel at push time
   *  from the node's own policy (NOT stored on the profile: the rules name
   *  outbounds only some nodes have). Absent = default routing, byte-identical
   *  to pre-B1. Mirrors the Go RoutingFragments json tags exactly (wire-sync). */
  routingFragments?: RoutingFragmentsCfg;
}

/**
 * B1 compiled egress policy: where matching traffic leaves this node. Rendered
 * into xray routing.rules after the anti-abuse block rules and before the
 * cascade / WARP catch-alls, so the policy decides for what it matches and
 * everything else falls through to the node's default egress.
 *
 * The panel compiles this against the capabilities the node actually has, so
 * `outboundTag` always names an outbound the rendered config carries: an
 * unknown tag is a config xray refuses, which would take the node down.
 */
export interface RoutingFragmentsCfg {
  rules: Array<{
    /** e.g. ["geosite:youtube", "example.com"]. */
    domain?: string[];
    /** e.g. ["geoip:ru", "10.0.0.0/8"]. */
    ip?: string[];
    /** Single port, range "1000-2000", or comma list "80,443". */
    port?: string;
    network?: 'tcp' | 'udp' | 'tcp,udp';
    outboundTag: string;
  }>;
  /** Custom xray outbound objects the rules name (panel-owned shape). */
  outbounds?: unknown[];
  /** routing.domainStrategy override. The panel sets 'IPOnDemand' when the
   *  policy has an ip/geoip matcher, without which such a rule never fires on a
   *  node whose later rules include a catch-all. Omitted = node default. */
  domainStrategy?: 'AsIs' | 'IPIfNonMatch' | 'IPOnDemand';
}

/**
 * U4 configurable anti-abuse, carried by every protocol whose core renders the
 * built-in BLOCK rules (xray and shadowsocks). Absent means the node enables
 * all three (byte-identical to the historical hardcoded behaviour); present
 * means each rule renders only when its flag is true, so an operator can
 * selectively relax a node's AUP enforcement. The three flags must mirror the
 * core.AbusePolicy json tags exactly (wire-sync).
 */
export interface AbusePolicyCfg {
  blockTorrent: boolean;
  blockSmtp: boolean;
  blockDnsHijack: boolean;
}

/**
 * Cloudflare WARP egress credentials the panel pushes to the node, which renders
 * them as an xray `wireguard` outbound. publicKey/endpoint/mtu fall back to
 * Cloudflare well-known defaults on the node when empty. reserved is the account
 * client_id as a 3-byte array (empty or exactly 3).
 */
export interface WarpCfg {
  /** WireGuard private key (base64). */
  secretKey: string;
  /** Assigned interface addresses, e.g. ["172.16.0.2/32", "<v6>/128"]. */
  address: string[];
  /** Cloudflare peer public key; node default if omitted. */
  publicKey?: string;
  /** Peer endpoint "host:port"; node default (162.159.192.1:2408) if omitted. */
  endpoint?: string;
  /** client_id first 3 bytes (xray/sing-box `reserved`); empty or exactly 3. */
  reserved?: number[];
  /** WireGuard MTU; node default 1280 if omitted. */
  mtu?: number;
}

/**
 * C3 cascade fragments: raw xray config objects the panel hands to a node so it
 * can chain entry→exit. The panel owns the exact xray shape (the node-agent
 * stays protocol-agnostic and just merges these into inbounds/outbounds/
 * routing.rules). Each element is a fully-formed xray config object.
 */
export interface XrayCascadeFragments {
  /** Link-IN inbounds (the previous hop dials these). Present on transit/exit
   *  nodes. */
  inbounds: unknown[];
  /** Link-OUT outbounds (this hop dials the next). Present on entry/transit
   *  nodes. */
  outbounds: unknown[];
  /** Per-role routing rules: entry routes user traffic → link-out; transit
   *  routes link-in → link-out; exit routes link-in → direct. Appended after
   *  the node's base block/DNS rules on the node side. */
  routingRules: unknown[];
  /** Inter-hop link-IN port this node listens on (the previous hop dials it).
   *  The node-agent opens UFW for it, restricted to linkAllowFrom, since this
   *  high port is not a top-level inbound and install-time rules miss it.
   *  Absent on the entry hop (no link-in). */
  linkIngressPort?: number;
  /** Source IP/CIDR/host allowed to reach linkIngressPort (the previous hop's
   *  address). Hostnames are resolved agent-side; empty → port opens to anyone
   *  (still UUID/PSK-gated). */
  linkAllowFrom?: string[];
  /** Latency-balanced ("auto") entry only: the top-level `observatory` block
   *  that probes the link-out outbounds by RTT. Present on the entry of a
   *  mode='balancer' cascade; absent otherwise. */
  observatory?: unknown;
  /** Latency-balanced entry only: `routing.balancers` entries. The entry's user
   *  routing rule targets one via `balancerTag`, so xray picks the lowest-ping
   *  exit per connection. Absent otherwise. */
  balancers?: unknown[];
  /** G4 - geo databases this node must fetch+install (source mirror + composed
   *  ext: custom .dat) so its geosite:/ext: routing rules resolve. The node
   *  verifies each sha256 (computed panel-side), atomically installs it, and
   *  points xray at the dir via XRAY_LOCATION_ASSET. Absent → the node uses its
   *  bundled databases (byte-identical to a non-geo cascade). */
  geoAssets?: GeoAssetSpec[];
  /** E - override the node's global `routing.domainStrategy` for this entry.
   *  Set to `IPOnDemand` only on a geo-split entry whose egressPolicy has an
   *  ip/geoip matcher: under the default `IPIfNonMatch`, xray only resolves a
   *  sniffed domain to an IP for a second rule pass IF no rule matched the
   *  first, but the entry's always-true catch-all matches first, so an ip/geoip
   *  rule never fires. `IPOnDemand` resolves on demand as a rule needs an IP, so
   *  the ip/geoip rules (which sit before the catch-all) take effect. Absent →
   *  the node keeps its default (byte-identical to a non-geo cascade). */
  domainStrategy?: string;
}

/** One panel-managed geo file for a node to install (see XrayCascadeFragments). */
export interface GeoAssetSpec {
  /** Bare filename in the asset dir, e.g. "geo-custom.dat". */
  name: string;
  url: string;
  /** Lowercase hex sha256 the panel computed at build time. */
  sha256: string;
}

export interface HysteriaInboundCfg {
  obfsPassword?: string;          // Salamander; empty = no obfuscation
  masqueradeUrl?: string;
  brutalUpMbps?: number;
  brutalDownMbps?: number;
}

export interface AmneziawgInboundCfg {
  /** Server WG private key (base64-standard, like `wg genkey`). */
  privateKey: string;
  /** Subnet in CIDR notation (e.g. "10.0.0.0/24"). Server takes .1, peers
   *  .2..N. Panel-side `amneziawg.service` does the per-user allocation. */
  subnet: string;
  /** AmneziaWG obfuscation params, see reference_amneziawg.md for ranges. */
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
  postUp?: string;                // optional iptables / sysctl tweaks
  postDown?: string;
}

export interface NaiveInboundCfg {
  hostname: string;               // public FQDN; Caddy ACME uses this
  tlsEmail: string;               // LE account
  masqueradeRoot?: string;        // dir served when probed (default: /var/www/empty)
}

/**
 * Shadowsocks 2022 inbound config (slice 24d). Method = AEAD/SS2022 cipher.
 * Per-user passwords are derived from `user.xrayUuid` on both sides, we
 * don't grow the credential surface for a fifth protocol.
 *
 * `serverPsk` (Server PSK) is auto-generated at inbound create on the
 * panel side and pushed over the wire. xray-core requires it at the
 * `settings.password` level for SS2022 multi-user; clients connect with
 * `base64url(method:ServerPSK:UserPSK)` joined.
 */
export interface ShadowsocksInboundCfg {
  method:
    | '2022-blake3-aes-128-gcm'
    | '2022-blake3-aes-256-gcm'
    | '2022-blake3-chacha20-poly1305'
    | 'chacha20-ietf-poly1305'
    | 'aes-256-gcm'
    | 'aes-128-gcm';
  serverPsk?: string;
  /** U4 configurable anti-abuse. The shadowsocks core renders the same BLOCK
   *  rules as the xray core, so it takes the same policy. See AbusePolicyCfg. */
  abusePolicy?: AbusePolicyCfg;
}

/**
 * MTProto inbound config (slice 41). 9seconds/mtg upstream is single-
 * secret by design, so we model the inbound (not the user) as the unit
 * carrying the secret. The panel derives `secret` deterministically
 * from (inboundId, domain) and pushes it on the wire; the agent could
 * re-derive but trusts the panel's value to keep both sides in lock-step
 * even if the derivation logic ever changes.
 */
export interface MtprotoInboundCfg {
  domain: string;
  /** `ee<32-hex-bytes><hex-encoded-domain>`: Fake-TLS format. */
  secret: string;
}

/**
 * Mieru inbound config (slice 40). MTU caps the inner-payload size; per-
 * user creds derive from `user.xrayUuid`.
 */
export interface MieruInboundCfg {
  mtu: number;
}

/**
 * TUIC v5 inbound config (sing-box engine, slice singbox-S2). `serverName` is
 * the TLS SNI the node's cert is issued for; `congestionControl` tunes the QUIC
 * sender. TLS is the node's self-signed pair for the alpha (client connects
 * with allow-insecure + this SNI). Per-user uuid+password live in credentials.
 */
export interface TuicInboundCfg {
  serverName?: string;
  congestionControl?: 'bbr' | 'cubic' | 'new_reno';
}

/**
 * AnyTLS inbound config (sing-box engine). TCP+TLS, password-only auth (the
 * per-user password lives in credentials). `serverName` is the TLS SNI the
 * node's self-signed cert is issued for (client uses allow-insecure in alpha).
 */
export interface AnytlsInboundCfg {
  serverName?: string;
}

/**
 * ShadowTLS v3 inbound config (sing-box engine). TLS-camouflage wrapper: the
 * node fronts a real handshake to `handshake` (a whitelisted site) and detours
 * to an inner single-key shadowsocks. `ssMethod` is the inner cipher; `ssPassword`
 * is the inner ss server key (auto-generated panel-side, valid base64). Per-user
 * auth is the shadowtls password (credentials). No share-link (sing-box/clash).
 */
export interface ShadowtlsInboundCfg {
  handshake?: string;
  ssMethod?: string;
  ssPassword?: string;
}

export interface ApplyInboundsRequest {
  inbounds: InboundDto[];
}

export interface ApplyInboundsResponse {
  ok: true;
  /** Number of inbounds actually applied (after the node-side diff). */
  applied: number;
  /** Number of inbounds that were already in this state (no-op). */
  skipped: number;
}

// ───── POST /applyEgress ─────

/**
 * B2a - push the node's zapret2 desync channel config. `config` is the fully
 * resolved zapret2 `config` file body (preset + structured overrides applied
 * panel-side; the node stays dumb and just writes it). `enabled=false` tears
 * the service down. Off-by-default: a node that does not run the channel never
 * receives this call, so its behaviour is byte-identical to pre-B2a.
 */
export interface ApplyEgressRequest {
  enabled: boolean;
  /** zapret2 config file body (KEY=VALUE). Ignored by the node when enabled=false. */
  config: string;
  /** B2b - a TLS bypass strategy the panel picked for this node, typically one
   *  a sibling on the same AS found for itself. A SEED: the node's own scan,
   *  when it has one, always wins, because that one was measured there. */
  strategy?: string;
}

export interface ApplyEgressResponse {
  ok: true;
  /** True when the node (re)applied the policy; false when it was a no-op
   *  (unchanged) or the node has no egress support provisioned. */
  applied: boolean;
}

// ───── POST /generateKeys ─────

/**
 * U5 - mint key material with the core binary that will use it, so an operator
 * does not have to find a machine with the right build, run it by hand and
 * paste the result.
 *
 * `kind` is the core's own keygen subcommand, and the node returns that
 * command's stdout VERBATIM: what the panel wants out of it moves with the core
 * version, and a parser on the node would have to be shipped to every node to
 * keep up.
 */
export interface GenerateKeysRequest {
  /** 'mldsa65' (post-quantum REALITY) or 'vlessenc' (VLESS-Encryption). */
  kind: string;
}

export interface GenerateKeysResponse {
  ok: true;
  kind: string;
  /** The subcommand's stdout, untouched. */
  raw: string;
}

// ───── POST /removeUser ─────

export interface RemoveUserRequest {
  userId: string;
}

export interface RemoveUserResponse {
  ok: true;
}

// ───── GET /stats ─────

export interface UserStats {
  userId: string;
  bytesIn: number;
  bytesOut: number;
  /**
   * True when THIS user's counters are cumulative-since-core-start (the
   * producing adapter does a non-destructive read: xray / sing-box); false or
   * omitted means they are already per-poll deltas (awg / hysteria / ss /
   * mtproto). Set per-user by the node so a node running BOTH a cumulative and
   * a delta core is billed correctly. Absent on legacy agents, in which case
   * the panel falls back to the response-level `cumulative` flag.
   */
  cumulative?: boolean;
}

export interface GetStatsResponse {
  /**
   * Per-user counters. Cumulative since core start when `cumulative` is true
   * (the panel computes deltas against a stored snapshot); otherwise deltas
   * since the last poll (legacy agents).
   */
  users: UserStats[];
  /** Node uptime in seconds. */
  uptime: number;
  totalBytesIn: number;
  totalBytesOut: number;
  /**
   * #5 - true when `users[]` are cumulative-since-core-start (xray
   * non-destructive read). Absent/false = legacy already-deltas semantics.
   */
  cumulative?: boolean;
  /**
   * True when at least one core on this node could NOT read its counters this
   * poll, so `users[]` is INCOMPLETE - some cumulative rows are missing rather
   * than zero.
   *
   * The panel sums a user's cumulative rows across cores before comparing them
   * to its snapshot, so a missing core reads exactly like a counter reset: the
   * sum drops, the snapshot is re-baselined to the lower value, and the next
   * successful poll bills the difference - the absent core's ENTIRE
   * since-core-start counter - as one poll's traffic.
   *
   * Measured live on a node running xray and sing-box for one user: sing-box's
   * stats endpoint blocked for a single poll and restored with no traffic in
   * between moved the user from 1 156 229 to 1 672 312 bytes, +516 083, exactly
   * sing-box's cumulative. On a node up for a week that is the week, re-billed,
   * up to the panel's 1 TiB per-poll clamp.
   *
   * Neither core could prevent it alone. xray already emits NO rows on a failed
   * query rather than zero rows, precisely to avoid looking like a reset - and
   * it does not help, because "this core said nothing" and "this core says
   * zero" are the same thing once the panel has summed the cores together.
   * Only the node knows the difference, so the node says it.
   *
   * Absent on agents older than 2026-08-30.
   */
  statsDegraded?: boolean;
}

// ───── GET /healthz ─────

/**
 * Per-core restart tally (2026-08-04). Reported only by cores that supervise a
 * real subprocess, and only by agents from 2026-08 onward.
 *
 * ⚠ Absent means "not reported", NOT "zero restarts". The panel must keep its
 * stored value when this is missing, the same way it does for `version`.
 *
 * Why it exists: the agent restarts a core once its memory crosses a ceiling,
 * before the kernel OOM-kills it. A restart drops live connections, so without
 * a visible counter the panel would show a healthy green node while users
 * complain about drops.
 */
export type CoreRestartReason = 'crash' | 'memory';

export interface CoreRestarts {
  /** Which core these numbers belong to ("xray", ...). Present so a reader
   *  never infers it from the node's protocol: today only xray arms the
   *  watchdog, but the mechanism is core-agnostic. */
  core: string;
  /** crash + memory, sent explicitly rather than derived: a future third cause
   *  would keep this right while crash+memory quietly stopped adding up. */
  total: number;
  /** Died on its own. A rising number here is a bug, not maintenance. */
  crash: number;
  /** Watchdog acted before an OOM. Rising here means the ceiling is doing its
   *  job (or is set too low). */
  memory: number;
  /** RFC3339. Absent until something has restarted. */
  lastAt?: string;
  lastReason?: CoreRestartReason;
  /** RFC3339 instant the agent started counting. Counters live in the agent's
   *  memory and reset when it restarts, so without this "3 restarts" cannot be
   *  dated: it could be this morning or six months ago. */
  sinceAt?: string;
  /** Armed ceiling in bytes; absent = watchdog off. Never sent as 0. */
  memoryLimitBytes?: number;
  /** Latest resident-size sample in bytes; absent = not sampled (or the
   *  platform can't read it). Shown next to the ceiling so an operator sees
   *  how close a core runs, not just how often it crossed. Never sent as 0. */
  rssBytes?: number;
}

/**
 * What the PANEL stores and serves on the node DTO: the agent's tally plus the
 * panel's own freshness stamp. Single definition on purpose - panel-backend's
 * mapper and panel-frontend's api client both import this one, so the contract
 * can't drift between three copies.
 */
export interface NodeCoreRestarts extends CoreRestarts {
  /**
   * RFC3339 instant of the poll these numbers came from.
   *
   * ⚠ Refreshed at most every few minutes, not on every 30s poll: the panel
   * only writes the row when something moved (or on a periodic heartbeat), so
   * a quiet node would otherwise churn a database write per tick. Treat it as
   * "data is no older than this, give or take the heartbeat interval". A stamp
   * far past that interval means the node stopped being polled, not that it is
   * healthy and quiet.
   */
  observedAt: string;
}

export interface CoreStatus {
  name: ProtocolName;
  /** The core that actually renders this protocol ON THIS NODE, which is not
   *  derivable from `name`: the sing-box engine registers an adapter per
   *  protocol, so one node can report `xray` served by sing-box beside `xray`
   *  served by xray-core. The agent has always dispatched inbounds on the PAIR
   *  (name, engine) and sent only the first half, which left the panel to
   *  assume the protocol's native core — and therefore to compare sing-box's
   *  version against xray's pin on every node with sing-box installed.
   *  Absent = an agent older than the field. */
  engine?: string;
  running: boolean;
  /** See CoreRestarts. Absent = this core/agent doesn't report it. */
  restarts?: CoreRestarts;
  /** T7: underlying core binary version (e.g. "26.3.27" from `xray version`),
   *  absent when the adapter can't report one (config-only mode, non-versioned
   *  core, or a pre-T7 agent). The panel persists it per node to gate features
   *  needing a minimum core version (cascade exit selection needs xray
   *  >= 25.9.5). */
  version?: string;
  /** Whether this core is CONFIGURED, i.e. has an inbound and is expected to
   *  run. The installer registers an adapter for every protocol the operator
   *  might switch on later, and an unconfigured one sits idle by design.
   *
   *  Absent = the agent predates the field, which is NOT the same as false:
   *  read it as configured, the behaviour that came before. Without the
   *  distinction a healthy node reported `degraded` forever (every node of the
   *  field fleet did), so the status stopped changing when something broke. */
  provisioned?: boolean;
  /** The last line this core printed, sent only when it is NOT running - that
   *  line is its reason for being down. Absent when the core is up, when it
   *  printed nothing, or when the agent predates the field; all three mean the
   *  same thing to a reader, which is that there is no reason to show. */
  lastError?: string;
}

export interface HealthcheckResponse {
  status: 'ok' | 'degraded';
  cores: CoreStatus[];
  /** F3: the DPI-bypass strategy this node found for itself and is running.
   *  Absent on a node that never scanned, whose scan found nothing, or that
   *  runs a pre-F3 agent. */
  egressTune?: EgressTune;
  /** The Hysteria 2 port-hopping range this node actually REDIRECTS, read by
   *  the agent out of its own nat table. Chosen at install time, so the panel
   *  had no way to know it and accepted any range on a profile - including one
   *  the node does not catch, which is a client honestly rotating its
   *  destination port across ports nobody is listening on. Absent = no rule, no
   *  iptables, or an agent older than the field, and the panel gates on none of
   *  the three. Mirrors the Go PortHopDto json tags exactly (wire-sync). */
  portHopping?: PortHopping;
}

/** An inclusive UDP port range, as a node reports what it redirects. */
export interface PortHopping {
  start: number;
  end: number;
}

/**
 * F3 - a self-tuned egress strategy, as the node reports it and the panel
 * stores it (nodes.egress_tune).
 *
 * The node picks and applies it: a strategy that works is a property of THIS
 * node's uplink, and the node is where the config gets written. The panel keeps
 * the answer so an operator can see which strategy a node settled on, compare
 * nodes on the same uplink, and promote a winner into a vendored preset.
 */
export interface EgressTune {
  /** Domain the scan proved the strategy against. */
  domain: string;
  /** blockcheckw's protocol label, e.g. "HTTPS/TLS1.3". */
  protocol: string;
  /** The nfqws2 strategy verbatim, as spliced into the node's NFQWS2_OPT. */
  args: string;
  /** blockcheckw's own score, when it reports one. */
  coverage?: number;
  /** Strategies tried, and how many got through. Both zero with no strategy
   *  means nothing was blocked, which is not the same as "found nothing that
   *  works" - the difference decides whether an operator should worry. */
  total: number;
  working: number;
}

/** What the panel stores per node: the reported tune plus when it was seen. */
export interface NodeEgressTune extends EgressTune {
  observedAt: string;
}

// ───── GET /metrics ─────
//
// Host-level CPU / memory / disk for the VPS the node-agent runs on. Polled
// by the panel every 15s and cached in Redis with TTL 60s, so the dashboard
// can show per-node load without paying mTLS round-trip on every page open.

export interface CPUMetricsDto {
  /** Sampled CPU%, 0..100. Zero on the very first agent poll (no prior snapshot). */
  usagePercent: number;
  loadAvg1: number;
  loadAvg5: number;
  loadAvg15: number;
  cores: number;
}

export interface MemoryMetricsDto {
  totalBytes: number;
  availableBytes: number;
  usedBytes: number;
  usedPercent: number;
}

export interface DiskMetricsDto {
  path: string;
  totalBytes: number;
  usedBytes: number;
  usedPercent: number;
}

export interface HostMetricsResponse {
  cpu: CPUMetricsDto;
  memory: MemoryMetricsDto;
  disk: DiskMetricsDto;
  /** Node-agent process uptime, seconds. */
  uptimeSeconds: number;
  /** ISO 8601 with nanos. Useful for "stale sample" heuristics on the panel. */
  collectedAt: string;
}

// ───── GET /ufwPorts ─────
//
// G4 probe-exposure: the node-agent reports its ufw-allowed inbound ports; the
// panel compares them to the expected set (bindings + SSH + mTLS) and warns the
// operator about anything unexpected left open.

export interface UfwPortDto {
  port: number;
  proto: 'tcp' | 'udp';
}

export interface UfwPortsResponse {
  /** false = ufw not installed on the node; the panel skips the exposure check. */
  managed: boolean;
  ports: UfwPortDto[];
}

// ───── Common error shape ─────

export interface NodeErrorResponse {
  error: string;
  message: string;
}
