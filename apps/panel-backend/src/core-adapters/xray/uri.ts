/**
 * VLESS + REALITY + Vision URI builder for Xray-core clients (v2rayN,
 * NekoRay, Hiddify in Xray mode, etc).
 *
 * Wire format:
 *   vless://<uuid>@<host>:<port>?<query>#<fragment>
 *
 * Query params we set (per Xray docs as of v24.9.30):
 *   type=raw          - network mode (renamed from `tcp` in v24.9.30)
 *   security=reality  - REALITY TLS replacement
 *   encryption=...    - `none` unless the inbound runs VLESS-Encryption, in
 *                       which case it is that profile's client string (U5)
 *   pqv=<verifyKey>   - ML-DSA-65 verify key, only when the inbound signs its
 *                       REALITY certificate with the matching seed (U5)
 *   pbk=<pubkey>      - REALITY public key (paired with server's privateKey)
 *   sid=<shortId>     - one of the inbound's REALITY shortIds
 *   sni=<host>        - REALITY target serverName the client claims
 *   fp=<fingerprint>  - TLS fingerprint (chrome/firefox/safari/...)
 *   flow=<flow>       - `xtls-rprx-vision` for Vision (REALITY-recommended)
 *
 * Slice 17: flat builder; slice 23 (inbound editor) will pull these from
 * the inbounds table per-instance.
 */

export type VlessNetwork = 'raw' | 'xhttp' | 'ws' | 'grpc' | 'httpupgrade' | 'kcp';

export interface VlessRealityUriOpts {
  uuid: string;
  host: string;
  port: number;
  publicKey: string;
  shortId: string;
  sni: string;
  flow?: string;
  fingerprint?: string;
  name: string;
  /** Stream transport. Default `raw` (canonical REALITY+Vision). */
  network?: VlessNetwork;
  /** Path for ws / xhttp. Ignored for raw / grpc. */
  path?: string;
  /** Host-header override for ws / xhttp. */
  hostHeader?: string;
  /** gRPC serviceName. Required when network=grpc. */
  serviceName?: string;
  /**
   * XHTTP framing, emitted as `mode=` when it is not the client default.
   * Sourced, not guessed: v2rayN's share-link handler writes exactly this key
   * inside the xhttp branch and reads it back into `XhttpMode`
   * (ServiceLib/Handler/Fmt/BaseFmt.cs), and accepts the same four values we
   * do. `auto` is left off - it is what both v2rayN and xray-core assume for an
   * absent mode, so omitting it keeps every link we emit today byte-identical
   * and moves only the ones that were actually broken.
   */
  xhttpMode?: 'auto' | 'packet-up' | 'stream-up' | 'stream-one';
  /** Slice 30.1: per-host overrides emitted into the URI. */
  /** ALPN list (e.g. ['h2','http/1.1']). Joined by comma into `alpn` param. */
  alpn?: string[];
  /** `?allowInsecure=1` flag: when the host fronts the inbound through a
   *  self-signed CDN. Clients that don't honour the flag still try TLS verify
   *  and fail, but the flag is harmless to emit. */
  allowInsecure?: boolean;
  /** `none` disables client-side TLS (CDN-terminated host); `tls` forces it
   *  even when the adapter's default would be reality. `default` omits the
   *  override and lets the client follow the adapter's chosen security. */
  securityLayer?: 'default' | 'tls' | 'none';
  /** U5 - client half of VLESS-Encryption. Emitted as `encryption=`; empty
   *  keeps the pre-U5 `encryption=none`. Every mainstream client reads this
   *  param straight into the VLESS user's `encryption` (checked against
   *  v2rayN's VLESSFmt and mihomo's URI converter), so an inbound with
   *  `decryption` set is unreachable without it. */
  vlessEncryption?: string;
  /** U5 - client half of post-quantum REALITY: the ML-DSA-65 verify key, from
   *  the same `xray mldsa65` run as the inbound's seed. Emitted as `pqv=`
   *  (v2rayN BaseFmt maps `pqv` <-> realitySettings.mldsa65Verify). Only
   *  meaningful on the reality layer. */
  mldsa65Verify?: string;
}

export function buildVlessRealityUri(opts: VlessRealityUriOpts): string {
  const network: VlessNetwork = opts.network ?? 'raw';
  const flow = opts.flow ?? 'xtls-rprx-vision';

  // Slice 30.1: `securityLayer` host override. `tls` and `none` replace the
  // adapter's default `reality`; `default` keeps the canonical REALITY layer.
  // `none` is used when the host fronts the inbound through a CDN that owns
  // the TLS termination, the client speaks plain HTTP/2 to the CDN and the
  // CDN terminates TLS upstream.
  let security = 'reality';
  if (opts.securityLayer === 'tls') security = 'tls';
  else if (opts.securityLayer === 'none') security = 'none';

  const params = new URLSearchParams({
    type: network,
    security,
    // U5: the profile's client string when the inbound runs VLESS-Encryption,
    // otherwise the historical `none`. Not a cosmetic difference - the server
    // half alone gets the handshake refused, so this param is the whole
    // client side of the feature.
    encryption: opts.vlessEncryption || 'none',
  });

  // REALITY public key + shortId apply only to the reality layer. SNI +
  // fingerprint are meaningful for any TLS-like layer (reality or tls) but not
  // for plain 'none' (a fronting CDN terminates TLS; the client speaks plain
  // to it). Insertion order preserves the reality query string exactly.
  if (security === 'reality') {
    params.set('pbk', opts.publicKey);
    params.set('sid', opts.shortId);
    // Without it the client verifies the REALITY certificate the classical way
    // and never looks at the post-quantum signature the node went to the
    // trouble of adding - a downgrade nothing reports.
    if (opts.mldsa65Verify) params.set('pqv', opts.mldsa65Verify);
  }
  if (security !== 'none') {
    params.set('sni', opts.sni);
    params.set('fp', opts.fingerprint ?? 'chrome');
  }

  if (opts.alpn && opts.alpn.length > 0) {
    params.set('alpn', opts.alpn.join(','));
  }
  if (opts.allowInsecure) {
    params.set('allowInsecure', '1');
  }

  // Vision is only meaningful with raw/xhttp. ws/grpc/httpupgrade/kcp don't
  // accept it, most clients ignore it, but a few (Xray itself when strict)
  // reject the URI.
  if (flow && (network === 'raw' || network === 'xhttp')) {
    params.set('flow', flow);
  }

  // path + host header, same param names across ws/xhttp/httpupgrade per
  // VLESS URI convention. kcp doesn't carry path/host.
  if (network === 'ws' || network === 'xhttp' || network === 'httpupgrade') {
    if (opts.path) params.set('path', opts.path);
    if (opts.hostHeader) params.set('host', opts.hostHeader);
  }
  // The framing has to travel with the link: xray's xhttp server answers 400 to
  // a request whose mode it does not allow, and a client with no `mode` picks
  // one from whether REALITY is in play. `mode` is scoped to xhttp here because
  // the same key means the gRPC gun/multi mode on a grpc link.
  if (network === 'xhttp' && opts.xhttpMode && opts.xhttpMode !== 'auto') {
    params.set('mode', opts.xhttpMode);
  }
  if (network === 'grpc' && opts.serviceName) {
    params.set('serviceName', opts.serviceName);
  }
  if (network === 'kcp') {
    // header type: `none` is the safest default; admins picking obfuscated
    // mTLS-like profiles (`wechat-video`, etc) can override the inbound
    // streamSettings on the node side, but URI surface stays minimal.
    params.set('headerType', 'none');
  }

  return `vless://${opts.uuid}@${opts.host}:${opts.port}?${params.toString()}#${encodeURIComponent(opts.name)}`;
}
