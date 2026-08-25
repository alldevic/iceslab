import {
  cannotCarryTransport,
  emitsVisionFlow,
  cannotCarryVlessEncryption,
  type SubscriptionEndpoint,
} from '../subscription.formats.js';

/**
 * Quantumult X server_local proxy-line list (`?format=quantumultx`). One
 * `type=host:port, ..., tag=name` line per endpoint.
 *
 * QX supports shadowsocks / vmess / vless / trojan, including REALITY (verified
 * against the official sample.conf 2026-06-12): TLS is `obfs=over-tls` +
 * `obfs-host=<sni>`, REALITY adds `reality-base64-pubkey` / `reality-hex-shortid`,
 * and VLESS Vision uses `vless-flow=`. QX has no hysteria2/wireguard, so those
 * endpoints are skipped.
 */
/** RAW and WebSocket. See `cannotCarryTransport` for where this list comes from. */
const QX_TRANSPORTS = ['raw', 'ws'] as const;

function safeTag(name: string): string {
  return name.replace(/[,=]/g, '-').trim();
}

export function buildQuantumultXConf(endpoints: SubscriptionEndpoint[]): string {
  const lines: string[] = [];
  for (const e of endpoints) {
    const tag = safeTag(e.nodeName);
    if (e.protocol === 'shadowsocks') {
      lines.push(`shadowsocks=${e.host}:${e.port}, method=${e.method}, password=${e.password}, udp-relay=true, tag=${tag}`);
    } else if (e.protocol === 'xray') {
      // U5: QX's vless line carries `method=none` and has no field for a
      // VLESS-Encryption client string, so such an endpoint is unrepresentable.
      if (cannotCarryVlessEncryption(e)) continue;
      // QX spells the transport through `obfs=`, and its VLESS line has values
      // for exactly two of ours: WebSocket and none. gRPC, XHTTP, HTTPUpgrade
      // and mKCP have no spelling here at all (official sample.conf carries
      // `http`, `ws`, `wss`, `over-tls` and nothing else), so an endpoint on
      // one of those used to import as a plain-TLS entry and fail every
      // connect. Skip it instead.
      if (cannotCarryTransport(e, QX_TRANSPORTS)) continue;
      const sec = e.securityLayer ?? 'default';
      const reality = sec === 'default';
      const tls = sec !== 'none';
      const sub = e.subprotocol ?? 'vless';
      const ws = e.network === 'ws';
      // `wss` IS `over-tls` plus WebSocket - QX has no way to say both, and the
      // sample.conf pairs `obfs=wss` with REALITY directly
      // (`vless-wss-reality-01`), so REALITY needs no different spelling here.
      const obfs = ws ? (tls ? 'obfs=wss' : 'obfs=ws') : 'obfs=over-tls';
      const tlsParts = tls || ws ? [obfs, `obfs-host=${e.sni}`] : [];
      if (ws) tlsParts.push(`obfs-uri=${e.path ?? '/'}`);
      const realityParts = reality
        ? [`reality-base64-pubkey=${e.publicKey}`, `reality-hex-shortid=${e.shortId}`]
        : [];
      if (sub === 'vless') {
        const p = [`vless=${e.host}:${e.port}`, 'method=none', `password=${e.uuid}`, ...tlsParts, ...realityParts];
        if (emitsVisionFlow(e)) p.push(`vless-flow=${e.flow}`);
        p.push('udp-relay=true', `tag=${tag}`);
        lines.push(p.join(', '));
      } else if (sub === 'vmess') {
        const p = [`vmess=${e.host}:${e.port}`, 'method=none', `password=${e.uuid}`, ...tlsParts, ...realityParts, 'udp-relay=true', `tag=${tag}`];
        lines.push(p.join(', '));
      } else if (sub === 'trojan') {
        const p = [`trojan=${e.host}:${e.port}`, `password=${e.uuid}`, 'over-tls=true', `tls-host=${e.sni}`, ...realityParts, 'udp-relay=true', `tag=${tag}`];
        lines.push(p.join(', '));
      }
    }
    // hysteria / naive / mtproto / mieru / amneziawg -> skip (QX unsupported)
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}
