import {
  cannotCarryTransport,
  emitsVisionFlow,
  cannotCarryVlessEncryption,
  type SubscriptionEndpoint,
} from '../subscription.formats.js';

/**
 * Loon proxy-line list (`?format=loon`). Comma-positional head, then
 * `key=value` pairs: `Name = type,host,port,...,key=value`.
 *
 * The separator is the whole story of this file's history. It used to write
 * `key:value`, which is not Loon's grammar anywhere - every keyed parameter we
 * emitted was malformed, on every line, for every protocol. The header here
 * used to say as much, in its way: it called the grammar unverified and the
 * builder alpha, and asked whoever hit a problem to check in the app.
 *
 * It is verified now, from three independent places that agree:
 *
 *   - Loon's own manual, `LoonManual/docs/cn/node.md`
 *   - Loon's own examples, `LoonExampleConfig/example.conf` and
 *     `Nodes/ExampleNodes.list`
 *   - sub-store's Loon producer, the converter most subscriptions pass through
 *     (`proxy-utils/producers/loon.js`)
 *
 * What they establish, beyond the separator:
 *
 *   transports   VLESS and VMess carry `tcp`, `ws`, `http`; Trojan carries `ws`.
 *                Nothing else has a spelling. sub-store does not degrade an
 *                unknown transport, it throws `network <x> is unsupported`.
 *   path / host  `path=` and `host=` belong to ws (and http), and this builder
 *                never emitted either - a ws line that dialled `/` at a server
 *                listening elsewhere.
 *   REALITY      `sni=`, `public-key="<quoted>"`, `short-id=`. The manual does
 *                not document REALITY at all; sub-store emits it for VLESS,
 *                Trojan, VMess and AnyTLS alike, which is the evidence that
 *                Loon takes it.
 *   tls-name     goes with a plain TLS endpoint. A REALITY one names its server
 *                through `sni=` instead, and emitting both is not the grammar.
 */
/**
 * The transports Loon can name. `grpc` was in this list on the strength of this
 * builder having always emitted it - the note here said dropping it "on no
 * evidence would be a regression by guess". The evidence arrived: Loon
 * documents tcp / ws / http and sub-store refuses grpc outright. A grpc
 * endpoint now takes the same exit as xhttp and mKCP - skipped, because an
 * imported server that can never connect is worse than a line that is not
 * there. (`http` is absent because no xray network maps onto it: our transports
 * are raw / xhttp / ws / grpc / httpupgrade / kcp.)
 */
const LOON_TRANSPORTS = ['raw', 'ws'] as const;

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
      lines.push(p.join(','));
    } else if (e.protocol === 'xray') {
      // U5: Loon's proxy line has no place for the VLESS-Encryption client
      // string, so such an endpoint would import and then fail every connect.
      if (cannotCarryVlessEncryption(e)) continue;
      // XHTTP, HTTPUpgrade and mKCP have no spelling in Loon's proxy line - its
      // official example config carries `transport=tcp` and `transport=ws` and
      // nothing else. They used to collapse into `transport:tcp` below, which
      // imports and never connects. `grpc` stays: this builder already emitted
      // it, and dropping it on no evidence would be a regression by guess.
      if (cannotCarryTransport(e, LOON_TRANSPORTS)) continue;
      const sec = e.securityLayer ?? 'default';
      const reality = sec === 'default';
      const tls = sec !== 'none';
      const sub = e.subprotocol ?? 'vless';
      const net = e.network === 'ws' ? 'ws' : 'tcp';

      /** `transport=`, plus the two fields ws needs to reach the right path.
       *  Emitting the transport without them is how `loon:ws` sat in the matrix
       *  as `partial`: the name was right and the dial went to `/`. */
      const transport = (): string[] => {
        const out = [`transport=${net}`];
        if (net === 'ws') {
          if (e.path) out.push(`path=${e.path}`);
          if (e.hostHeader) out.push(`host=${e.hostHeader}`);
        }
        return out;
      };

      /** How the endpoint names the server it expects. REALITY answers with its
       *  public key and short id under `sni=`; a plain TLS endpoint uses
       *  `tls-name=`. The two are alternatives, not a pair. */
      const serverIdentity = (): string[] => {
        if (reality) {
          return [`sni=${e.sni}`, `public-key="${e.publicKey}"`, `short-id=${e.shortId}`];
        }
        return tls ? [`tls-name=${e.sni}`] : [];
      };

      if (sub === 'vless') {
        const p = [`${name} = VLESS,${e.host},${e.port},"${e.uuid}"`, ...transport()];
        p.push(`over-tls=${tls}`);
        if (emitsVisionFlow(e)) p.push(`flow=${e.flow}`);
        p.push(...serverIdentity());
        lines.push(p.join(','));
      } else if (sub === 'vmess') {
        // `auto` is a security Loon takes (sub-store passes it through its own
        // normaliser unchanged), so the cipher stays as it was.
        const p = [`${name} = vmess,${e.host},${e.port},auto,"${e.uuid}"`, ...transport()];
        p.push(`over-tls=${tls}`);
        p.push(...serverIdentity());
        lines.push(p.join(','));
      } else if (sub === 'trojan') {
        // Trojan is TLS by definition and carries no `over-tls` in any of the
        // three references. Its transport line is emitted only for ws: sub-store
        // omits the key entirely for tcp here, unlike VLESS/VMess.
        const p = [`${name} = trojan,${e.host},${e.port},"${e.uuid}"`];
        if (net === 'ws') p.push(...transport());
        p.push(...serverIdentity());
        lines.push(p.join(','));
      }
    }
    // naive / mtproto / mieru / amneziawg / wireguard -> skip (Loon unsupported)
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}
