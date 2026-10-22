import { isPlainXray, type SubscriptionEndpoint } from '../subscription.formats.js';

/**
 * Quantumult X server_local proxy-line list (`?format=quantumultx`). One
 * `type=host:port, ..., tag=name` line per endpoint.
 *
 * QX supports shadowsocks / vmess / vless / trojan, including REALITY (verified
 * against the official sample.conf 2026-06-12): TLS is `obfs=over-tls` +
 * `obfs-host=<sni>`, REALITY adds `reality-base64-pubkey` / `reality-hex-shortid`,
 * and VLESS Vision uses `vless-flow=`. QX has no hysteria2/wireguard, so those
 * endpoints are skipped.
 *
 * Transports (A-133, 22.10, the same sample.conf re-read): raw, and WebSocket
 * as `obfs=ws` (plain) or `obfs=wss` (over TLS) with `obfs-uri` (the path)
 * and `obfs-host` ("used for TLS handshake and for HTTP header host field").
 * Nothing else: gRPC, XHTTP, httpupgrade and kcp are not in QX's grammar, so
 * such an endpoint is left out, as an unsupported protocol is. They went out
 * as bare TCP+TLS before, a line that looked fine and never connected.
 */
function safeTag(name: string): string {
  return name.replace(/[,=]/g, '-').trim();
}

export function buildQuantumultXConf(endpoints: SubscriptionEndpoint[]): string {
  const lines: string[] = [];
  for (const e of endpoints) {
    const tag = safeTag(e.nodeName);
    if (e.protocol === 'shadowsocks') {
      lines.push(`shadowsocks=${e.host}:${e.port}, method=${e.method}, password=${e.password}, udp-relay=true, tag=${tag}`);
    } else if (e.protocol === 'xray' && !isPlainXray(e)) {
      // socks/http (the Telegram doors) are carried by plain, clash, sing-box and
      // xray-json only, by decision of 23.09; this format leaves them out.
      const sec = e.securityLayer ?? 'default';
      const reality = sec === 'default';
      const tls = sec !== 'none';
      const sub = e.subprotocol ?? 'vless';
      const ws = e.network === 'ws';
      // A transport QX does not speak: leave the endpoint out (A-133).
      if (e.network !== 'raw' && !ws) continue;
      // WebSocket rides `obfs=ws|wss`; REALITY is not a WebSocket security.
      if (ws && reality) continue;
      const wsParts = ws
        ? [
            tls ? 'obfs=wss' : 'obfs=ws',
            `obfs-host=${tls ? e.sni : (e.hostHeader ?? e.host)}`,
            `obfs-uri=${e.path ?? '/'}`,
          ]
        : [];
      const tlsParts = ws ? wsParts : tls ? ['obfs=over-tls', `obfs-host=${e.sni}`] : [];
      const realityParts = reality
        ? [`reality-base64-pubkey=${e.publicKey}`, `reality-hex-shortid=${e.shortId}`]
        : [];
      if (sub === 'vless') {
        const p = [`vless=${e.host}:${e.port}`, 'method=none', `password=${e.uuid}`, ...tlsParts, ...realityParts];
        if (e.flow && tls && !ws) p.push(`vless-flow=${e.flow}`);
        p.push('udp-relay=true', `tag=${tag}`);
        lines.push(p.join(', '));
      } else if (sub === 'vmess') {
        const p = [`vmess=${e.host}:${e.port}`, 'method=none', `password=${e.uuid}`, ...tlsParts, ...realityParts, 'udp-relay=true', `tag=${tag}`];
        lines.push(p.join(', '));
      } else if (sub === 'trojan') {
        // "trojan: over-tls=true or obfs=wss": WebSocket only over TLS.
        if (ws && !tls) continue;
        const transport = ws ? wsParts : ['over-tls=true', `tls-host=${e.sni}`];
        const p = [`trojan=${e.host}:${e.port}`, `password=${e.uuid}`, ...transport, ...realityParts, 'udp-relay=true', `tag=${tag}`];
        lines.push(p.join(', '));
      }
    }
    // hysteria / naive / mtproto / mieru / amneziawg -> skip (QX unsupported)
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}
