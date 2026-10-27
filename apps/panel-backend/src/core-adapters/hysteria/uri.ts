/**
 * Hysteria 2 URI builder. The wire format is consumed directly by Hiddify,
 * NekoRay, v2rayN, the upstream `hysteria` client, and IcePath-VPN.
 *
 * Slice 16: minimal builder (host:port + password + name fragment).
 * Slice 17 (inbounds CRUD) will extend with SNI / obfs / insecure / pinSHA256
 * once inbounds carry per-instance config.
 */

export interface HysteriaUriOpts {
  password: string;
  /** Host portion only, port is supplied separately so callers can split
   *  the control-plane port (panel↔node mTLS) from the client-facing UDP. */
  host: string;
  /** Public Hysteria2 UDP port the client connects to. */
  port: number;
  /** URL fragment shown in clients (typically the node name). */
  name: string;
  /** Salamander obfuscation password. When set, emitted as `obfs=salamander`
   *  + `obfs-password=...` query params. Critical on RU/IR/CN ISPs where
   *  bare QUIC is throttled or dropped by DPI mid-session. */
  obfsPassword?: string;
  /** The client's own bandwidth claim in Mbps, from the CLIENT's side: up is
   *  what it sends. Built by {@link clientBandwidthClaim}; absent means no
   *  claim, and the client runs BBR. */
  upMbps?: number;
  downMbps?: number;
  /** Port-hopping range (slice 31.5). When set, emits `mport=START-END` so
   *  clients rotate destination UDP port within the range. Server-side
   *  must have iptables UDP REDIRECT in place over the same range pointing
   *  at the actual listen port, install-iceslab-node.sh handles that. Defeats
   *  fixed-port UDP throttle on RU TSPU / IR / CN ISPs. */
  portHoppingStart?: number;
  portHoppingEnd?: number;
  /**
   * E30a: the sha256 of the self-signed certificate native hysteria serves on
   * a node addressed by IP, lowercase hex. Emitted as `pinSHA256=` together
   * with `insecure=1`, and the pair is not a contradiction: the hysteria
   * client runs Go's chain check first and its pin check in
   * VerifyPeerCertificate after, so a self-signed certificate fails the chain
   * check before the pin is ever read unless `insecure` switches that one off.
   * The pin still refuses any other certificate: VerifyPeerCertificate runs
   * with InsecureSkipVerify too (apernet/hysteria app/cmd/client.go, read
   * 2026-09-25; docs: "pinSHA256 ... openssl x509 -fingerprint -sha256").
   */
  pinSha256?: string;
}

/**
 * Does the core serving this inbound speak Salamander obfuscation?
 *
 * The native hysteria2 daemon does, and so does sing-box. Xray's hysteria2 does
 * NOT: its transport carries auth, udpIdleTimeout and masquerade, and nothing
 * else (checked against Xray-core v26.3.27, transport/internet/hysteria/
 * config.proto, 2026-09-12).
 *
 * This is why a share link cannot be built from the protocol name alone. Hand a
 * client an `obfs=salamander` link for an xray-served inbound and it obfuscates
 * into a server that does not deobfuscate: no error, no handshake, nothing to
 * see. On the operator's screen that reads as "the node is down", and under
 * RU DPI it also loses the one property hysteria2 is kept for.
 */
export function engineSpeaksHysteriaObfs(engine: string | undefined): boolean {
  // Unknown engine means an endpoint built by hand (a test, a preview). The
  // pre-engine behaviour is to emit obfs, and the only core that must not is
  // xray, so name that one rather than guessing about the rest.
  return engine !== 'xray';
}

/**
 * The bandwidth a client claims, from the profile's Brutal bandwidth (A-154).
 *
 * The profile's pair is the server's: the node writes it as hysteria's
 * `bandwidth.up` / `bandwidth.down` and sing-box's `up_mbps` / `down_mbps`.
 * The server's upload is the client's download and the other way round, and
 * for each direction the lower of the two claims wins (v2.hysteria.network,
 * Full Server Config, "Bandwidth", read 2026-10-22). So the client claims the
 * profile's pair turned over: a profile at 500 up / 200 down gives the client
 * 200 up / 500 down, and the client gets the profile's speed rather than a
 * claim of its own capping it.
 *
 * A profile without a bandwidth runs `ignoreClientBandwidth` (BBR) on the
 * node, where a claim plays no part, so none is sent. A side the profile
 * leaves open is not claimed either: the client runs BBR that way.
 */
export function clientBandwidthClaim(
  cfg: { brutalUpMbps?: number; brutalDownMbps?: number } | null | undefined,
): { upMbps?: number; downMbps?: number } {
  const claim: { upMbps?: number; downMbps?: number } = {};
  if (cfg?.brutalDownMbps) claim.upMbps = cfg.brutalDownMbps;
  if (cfg?.brutalUpMbps) claim.downMbps = cfg.brutalUpMbps;
  return claim;
}

export function buildHysteriaUri(opts: HysteriaUriOpts): string {
  // Hiddify's outbound parser was failing on bare `hysteria2://...:443/#name`
  // ("Unknown parse outbound") on 2026-05-06. Adding an explicit `sni` query
  // param fixes it, even when SNI matches host (which Hysteria infers
  // automatically), some clients want it spelled out.
  const params = new URLSearchParams();
  params.set('sni', opts.host);
  if (opts.obfsPassword) {
    params.set('obfs', 'salamander');
    params.set('obfs-password', opts.obfsPassword);
  }
  // The claim, only what clientBandwidthClaim gave. A fixed 50/100 was sent
  // before, and with a profile bandwidth set it capped every client at those
  // numbers whatever the profile said.
  if (opts.upMbps) params.set('upmbps', String(opts.upMbps));
  if (opts.downMbps) params.set('downmbps', String(opts.downMbps));
  // Slice 31.5: port-hopping. `mport` is the parameter Hiddify / sing-box /
  // NekoBox honour (mihomo accepts the same form via a `ports:` field
  // emitted separately by the Clash formatter). Wire form is `START-END`.
  if (
    typeof opts.portHoppingStart === 'number' &&
    typeof opts.portHoppingEnd === 'number'
  ) {
    params.set('mport', `${opts.portHoppingStart}-${opts.portHoppingEnd}`);
  }
  if (opts.pinSha256) {
    params.set('insecure', '1');
    params.set('pinSHA256', opts.pinSha256);
  }
  return `hysteria2://${encodeURIComponent(opts.password)}@${opts.host}:${opts.port}/?${params.toString()}#${encodeURIComponent(opts.name)}`;
}
