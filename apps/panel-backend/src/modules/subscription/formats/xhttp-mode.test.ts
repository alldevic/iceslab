import { describe, expect, it } from 'vitest';
import { buildClashYaml } from './clash.js';
import { buildXrayJson } from './xrayjson.js';
import type { SubscriptionEndpoint } from '../subscription.formats.js';
import { buildVlessRealityUri } from '../../../core-adapters/xray/uri.js';
import { buildTrojanRealityUri } from '../../../core-adapters/xray/trojan-uri.js';
import { buildVmessUri } from '../../../core-adapters/xray/vmess-uri.js';

/**
 * The operator's XHTTP framing has to reach the client, and this is about why
 * that is an outage rather than a wasted setting.
 *
 * From xray-core, read rather than remembered
 * (`transport/internet/splithttp/`):
 *
 *   dialer.go  a client whose mode is absent or `auto` CHOOSES: stream-one when
 *              REALITY is in use, packet-up otherwise.
 *   hub.go     the server answers HTTP 400 to a request framed in a way its own
 *              mode does not allow - "packet-up mode is not allowed" and its two
 *              siblings.
 *
 * Cross those and the two configurations that fail are specific: a REALITY node
 * set to `packet-up` (client picks stream-one, server refuses) and a non-REALITY
 * node set to `stream-one` (client picks packet-up, server refuses). The node
 * has rendered the operator's mode since B3; every client config we emit said
 * `auto`. So the panel's own REALITY+XHTTP recipe, on any mode but auto, handed
 * out configs that could not connect.
 *
 * Every case below renders TWO different modes, and none of them assert only
 * that some mode appears: a renderer pinned to a constant is exactly the bug
 * being fixed, and pinning it to a different constant must not pass.
 */

function endpoint(over: Partial<SubscriptionEndpoint> = {}): SubscriptionEndpoint {
  return {
    protocol: 'xray',
    nodeName: 'eu-1',
    host: 'n1.example.com',
    port: 443,
    uuid: '11111111-2222-3333-4444-555555555555',
    publicKey: 'pk',
    shortId: 'abc123',
    sni: 'www.cloudflare.com',
    flow: '',
    fingerprint: 'chrome',
    network: 'xhttp',
    path: '/dl',
    uri: 'vless://u@n1.example.com:443?type=xhttp',
    ...over,
  } as SubscriptionEndpoint;
}

const MODES = ['packet-up', 'stream-one'] as const;

describe('the XHTTP framing the operator picked reaches the client', () => {
  it('xray JSON writes the chosen mode, not a pinned one', () => {
    // Same key the node writes into the inbound, so agreement is literal.
    for (const mode of MODES) {
      const stream = JSON.parse(buildXrayJson([endpoint({ xhttpMode: mode })]))
        .outbounds[0].streamSettings;
      expect(stream.xhttpSettings.mode).toBe(mode);
    }
  });

  it('clash writes the chosen mode under xhttp-opts', () => {
    // `mode` is a real parsed field in mihomo (XHTTPOptions.Mode in
    // adapter/outbound/vless.go), reaching its xhttp client - not decoration.
    for (const mode of MODES) {
      expect(buildClashYaml([endpoint({ xhttpMode: mode })])).toContain(`mode: ${mode}`);
    }
  });

  it('the vless link carries it as mode=, and only for xhttp', () => {
    for (const mode of MODES) {
      const uri = buildVlessRealityUri({
        uuid: 'u', host: 'h', port: 443, publicKey: 'pk', shortId: 's', sni: 'sni',
        name: 'n', network: 'xhttp', path: '/dl', xhttpMode: mode,
      });
      expect(new URL(uri).searchParams.get('mode')).toBe(mode);
    }

    // `mode` means the gun/multi mode on a gRPC link, so the key is scoped to
    // the transport that owns it here rather than set from the same field for
    // every network.
    const grpc = buildVlessRealityUri({
      uuid: 'u', host: 'h', port: 443, publicKey: 'pk', shortId: 's', sni: 'sni',
      name: 'n', network: 'grpc', serviceName: 'gsvc', xhttpMode: 'stream-one',
    });
    expect(new URL(grpc).searchParams.get('mode')).toBeNull();
  });

  it('the trojan link carries it the same way', () => {
    for (const mode of MODES) {
      const uri = buildTrojanRealityUri({
        password: 'p', host: 'h', port: 443, publicKey: 'pk', shortId: 's', sni: 'sni',
        name: 'n', network: 'xhttp', path: '/dl', xhttpMode: mode,
      });
      expect(new URL(uri).searchParams.get('mode')).toBe(mode);
    }
  });

  it('the vmess link carries it in `type`, where v2rayN reads it back from', () => {
    // That field normally holds the header-obfuscation type, and the 'none' it
    // used to hold was being parsed as a mode named "none" by anything following
    // v2rayN's mapping. Decoded, not searched for as a substring: `type` is one
    // key inside a base64 JSON blob, and the mode string also appears nowhere
    // else in it.
    for (const mode of MODES) {
      const uri = buildVmessUri({
        uuid: 'u', host: 'h', port: 443, name: 'n', network: 'xhttp',
        path: '/dl', xhttpMode: mode,
      });
      const obj = JSON.parse(Buffer.from(uri.slice('vmess://'.length), 'base64').toString());
      expect(obj.type).toBe(mode);
    }
  });

  it('leaves a raw link untouched: `type` still means header obfuscation there', () => {
    // The control for the case above. `type` is shared, and taking it over for
    // every transport would silently replace the obfuscation type on raw/kcp
    // links with a framing mode that does not apply to them.
    const uri = buildVmessUri({
      uuid: 'u', host: 'h', port: 443, name: 'n', network: 'raw', xhttpMode: 'stream-one',
    });
    const obj = JSON.parse(Buffer.from(uri.slice('vmess://'.length), 'base64').toString());
    expect(obj.type).toBe('none');
  });

  it('auto changes no link that exists today', () => {
    // The framing an absent `mode` produces IS auto, in xray-core and in
    // v2rayN alike, so emitting it would add a parameter that means what the
    // link already meant - and rewrite every subscription in the fleet to say
    // so. The default stays off the wire.
    const base = {
      uuid: 'u', host: 'h', port: 443, publicKey: 'pk', shortId: 's', sni: 'sni',
      name: 'n', network: 'xhttp' as const, path: '/dl',
    };
    expect(buildVlessRealityUri({ ...base, xhttpMode: 'auto' })).toBe(
      buildVlessRealityUri(base),
    );
    // ...while the config formats, which have always written the key, keep
    // writing it. Absent there is not the same as auto - it is a key mihomo and
    // xray fill from their own defaults, and the node always emits one.
    const stream = JSON.parse(buildXrayJson([endpoint({ xhttpMode: 'auto' })]))
      .outbounds[0].streamSettings;
    expect(stream.xhttpSettings.mode).toBe('auto');
  });
});
