/**
 * VMess share-link builder for Xray-core clients (v2rayN, NekoBox, Hiddify).
 *
 * Unlike VLESS/Trojan (query-param URIs), VMess uses:
 *   vmess://base64(JSON)
 *
 * JSON fields per the v2rayN spec (Description-of-VMess-share-link):
 *   v, ps, add, port, id, aid, scy, net, type, host, path, tls, sni, alpn, fp
 *
 * IMPORTANT: this format has NO REALITY fields. VMess therefore pairs with
 * security 'none' (plain / CDN-fronted) or 'tls' only, never REALITY. The
 * panel forces this at the form level.
 */

export type VmessNetwork = 'raw' | 'xhttp' | 'ws' | 'grpc' | 'httpupgrade' | 'kcp';

export interface VmessUriOpts {
  uuid: string;
  host: string;
  port: number;
  name: string;
  network?: VmessNetwork;
  path?: string;
  hostHeader?: string;
  serviceName?: string;
  /** XHTTP framing. Rides the vmess JSON's `type` field - see the emitter. */
  xhttpMode?: 'auto' | 'packet-up' | 'stream-up' | 'stream-one';
  sni?: string;
  fingerprint?: string;
  alpn?: string[];
  /** 'tls' or 'none'. VMess links cannot carry REALITY. Default 'none'. */
  securityLayer?: 'tls' | 'none';
}

// Map our internal transport names to the vmess `net` value. VMess calls plain
// TCP "tcp" (we call it "raw"); the rest pass through.
function vmessNet(n: VmessNetwork): string {
  return n === 'raw' ? 'tcp' : n;
}

export function buildVmessUri(opts: VmessUriOpts): string {
  const network = opts.network ?? 'raw';
  const tls = opts.securityLayer === 'tls' ? 'tls' : '';

  const obj: Record<string, string> = {
    v: '2',
    ps: opts.name,
    add: opts.host,
    port: String(opts.port),
    id: opts.uuid,
    aid: '0', // AEAD
    scy: 'auto',
    net: vmessNet(network),
    type: 'none', // header obfuscation type
    host: '',
    path: '',
    tls,
  };

  // ws / httpupgrade / xhttp carry a path and an optional Host header.
  if (network === 'ws' || network === 'httpupgrade' || network === 'xhttp') {
    if (opts.path) obj.path = opts.path;
    if (opts.hostHeader) obj.host = opts.hostHeader;
  }
  // The vmess JSON has no field of its own for the xhttp framing: v2rayN reuses
  // `type` - normally the header-obfuscation type - and reads it straight back
  // into XhttpMode (Fmt/VmessFmt.cs, both directions). Which also means the
  // literal 'none' this object defaults to was being read as a mode named
  // "none" by any client following that mapping, so xhttp gets a real value
  // here even when it is 'auto'.
  if (network === 'xhttp') {
    obj.type = opts.xhttpMode ?? 'auto';
  }
  // gRPC serviceName lives in `path` in the v2rayN vmess format.
  if (network === 'grpc' && opts.serviceName) {
    obj.path = opts.serviceName;
  }
  // TLS-layer extras only apply when tls is on (none = CDN terminates TLS).
  if (tls === 'tls') {
    if (opts.sni) obj.sni = opts.sni;
    if (opts.fingerprint) obj.fp = opts.fingerprint;
    if (opts.alpn && opts.alpn.length > 0) obj.alpn = opts.alpn.join(',');
  }

  const b64 = Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64');
  return `vmess://${b64}`;
}
