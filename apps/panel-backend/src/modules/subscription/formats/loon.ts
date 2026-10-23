import { transportServed } from '@iceslab/shared';
import { isPlainXray, type SubscriptionEndpoint } from '../subscription.formats.js';

/**
 * Loon proxy-line list (`?format=loon`): `Name = Type,host,port,<positional>,key=value,...`.
 *
 * The grammar is nsloon.app/en/docs/Node, read 2026-09-25: parameters are
 * `key=value` on every type, the TLS name is `sni`, and the type names are
 * `Shadowsocks`, `Hysteria2`, `VLESS`, `VMess`, `Trojan`. Until then this
 * builder wrote `key:value` and `tls-name:`, taken from nothing it could
 * cite, and Loon read none of those parameters: a Salamander hysteria went
 * out without its obfuscation, a REALITY vless without its key.
 *
 * Transports (A-133, 22.10, the same page re-read): `transport=tcp|ws` (and
 * `http`, which this panel does not serve), WebSocket with `path=` and
 * `host=`; Trojan takes `tcp` and `ws` only. No gRPC, XHTTP, httpupgrade or
 * kcp in Loon's grammar, so such an endpoint is left out. gRPC went out as
 * `transport=grpc` and the rest as `transport=tcp`, and ws without its path.
 */
function safeName(name: string): string {
  return name.replace(/[,=]/g, '-').trim();
}

export function buildLoonConf(endpoints: SubscriptionEndpoint[]): string {
  const lines: string[] = [];
  for (const e of endpoints) {
    const name = safeName(e.nodeName);
    if (e.protocol === 'shadowsocks') {
      lines.push(`${name} = Shadowsocks,${e.host},${e.port},${e.method},"${e.password}",udp=true`);
    } else if (e.protocol === 'hysteria') {
      const p = [`${name} = Hysteria2,${e.host},${e.port},"${e.password}"`];
      if (e.obfsPassword) p.push(`salamander-password=${e.obfsPassword}`);
      if (typeof e.portHoppingStart === 'number' && typeof e.portHoppingEnd === 'number') {
        p.push(`server-ports="${e.portHoppingStart}:${e.portHoppingEnd}"`);
      }
      if (e.downMbps) p.push(`download-bandwidth=${e.downMbps}`);
      // E30a: the panel's self-signed certificate on a node addressed by IP.
      if (e.tlsPin) p.push('skip-cert-verify=false', `tls-cert-sha256=${e.tlsPin.certSha256}`);
      lines.push(p.join(','));
    } else if (e.protocol === 'xray' && !isPlainXray(e)) {
      // socks/http (the Telegram doors) are carried by plain, clash, sing-box and
      // xray-json only, by decision of 23.09; this format leaves them out.
      const sec = e.securityLayer ?? 'default';
      const reality = sec === 'default';
      const tls = sec !== 'none';
      const sub = e.subprotocol ?? 'vless';
      // What Loon carries is the shared table's to say (A-224): tcp and ws.
      if (!transportServed('loon', e)) continue;
      const ws = e.network === 'ws';
      const net = ws ? 'ws' : 'tcp';
      const wsParts = ws ? [`path=${e.path ?? '/'}`, `host=${e.hostHeader ?? (tls ? e.sni : e.host)}`] : [];
      if (sub === 'vless') {
        const p = [`${name} = VLESS,${e.host},${e.port},"${e.uuid}"`, `transport=${net}`, ...wsParts];
        if (e.flow && !ws) p.push(`flow=${e.flow}`);
        if (reality) p.push(`public-key="${e.publicKey}"`, `short-id=${e.shortId}`);
        if (tls) p.push('over-tls=true', `sni=${e.sni}`);
        lines.push(p.join(','));
      } else if (sub === 'vmess') {
        // ⚠ The cipher `auto` is NOT verified: the docs' example shows
        // `aes-128-gcm` and does not list the accepted values. Kept until a
        // live import in Loon on iOS says whether `auto` is read (ARCH, 25.09).
        const p = [`${name} = VMess,${e.host},${e.port},auto,"${e.uuid}"`, `transport=${net}`, ...wsParts];
        if (tls) p.push('over-tls=true', `sni=${e.sni}`);
        lines.push(p.join(','));
      } else if (sub === 'trojan') {
        const p = [`${name} = Trojan,${e.host},${e.port},"${e.uuid}"`, ...(ws ? ['transport=ws', ...wsParts] : [])];
        if (tls) p.push(`sni=${e.sni}`);
        lines.push(p.join(','));
      }
    }
    // naive / mtproto / mieru / amneziawg -> skip (Loon unsupported)
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}
