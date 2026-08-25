// What each client format actually yields, per transport and per protocol.
//
// A characterisation test, like `transport-matrix.test.ts` next door, and for
// the same reason: this is the module that decides which clients a buyer is
// OFFERED, so a wrong answer here is a working app recommended to someone whose
// config it will render empty. Until now the only check on it was a `Set`
// written by hand in the shop-document test — the test supplying the answer the
// module is supposed to compute.
//
// The table below is read off our own builders. It is allowed to change; what
// it is not allowed to do is change without someone seeing it.

import { describe, expect, it } from 'vitest';
import { usableFormats } from './format-usable.js';
import type { SubscriptionEndpoint } from '../subscription.formats.js';

function xray(network: string): SubscriptionEndpoint {
  return {
    protocol: 'xray',
    nodeName: 'eu-1',
    host: 'n1.example.com',
    port: 443,
    uuid: '11111111-2222-3333-4444-555555555555',
    publicKey: 'pk',
    shortId: 'abc123',
    sni: 'www.cloudflare.com',
    flow: 'xtls-rprx-vision',
    fingerprint: 'chrome',
    network,
    path: '/dl',
    serviceName: 'gsvc',
    uri: `vless://u@n1.example.com:443?type=${network}`,
  } as unknown as SubscriptionEndpoint;
}

function awg(): SubscriptionEndpoint {
  return {
    protocol: 'amneziawg',
    nodeName: 'eu-1',
    host: 'n1.example.com',
    port: 51820,
    privateKey: 'k',
    allowedIp: '10.0.0.2/32',
    serverPublicKey: 'spk',
    jc: 4, jmin: 64, jmax: 128, s1: 32, s2: 56, s3: 32, s4: 16,
    h1: 100, h2: 200, h3: 300, h4: 400,
    i1: '', i2: '', i3: '', i4: '', i5: '',
    // No standardised URI for either WireGuard flavour.
    uri: '',
  } as unknown as SubscriptionEndpoint;
}

const list = (e: SubscriptionEndpoint[]): string => [...usableFormats(e)].sort().join(' ');

describe('usableFormats', () => {
  it('the table, exactly as it stands today', () => {
    const rows = ['raw', 'xhttp', 'ws', 'grpc', 'httpupgrade', 'kcp'].map(
      (n) => `${n.padEnd(12)} ${list([xray(n)])}`,
    );
    // sing-box drops out on `xhttp` and `kcp`, and that is the whole point of
    // this module: on a fleet using either, every sing-box-cored client —
    // Hiddify, sing-box, NekoBox — renders an empty config.
    expect('\n' + rows.join('\n') + '\n').toBe(`
raw          clash plain singbox xrayjson
xhttp        clash plain xrayjson
ws           clash plain singbox xrayjson
grpc         clash plain singbox xrayjson
httpupgrade  clash plain singbox xrayjson
kcp          clash plain xrayjson
`);
  });

  it('agrees with the matrix it leans on: an entry emitted is an entry that carries', () => {
    // `transport-matrix.test.ts` records `omitted` for sing-box on xhttp/kcp and
    // a carrying verdict everywhere else, with no `degraded` or `dropped`
    // anywhere. That invariant is what lets this module read "an entry came
    // out" as "the client can use it", so the two must not disagree.
    for (const n of ['raw', 'ws', 'grpc', 'httpupgrade']) {
      expect(usableFormats([xray(n)]).has('singbox'), `singbox on ${n}`).toBe(true);
    }
    for (const n of ['xhttp', 'kcp']) {
      expect(usableFormats([xray(n)]).has('singbox'), `singbox on ${n}`).toBe(false);
    }
  });

  it('gives a tunnel-only buyer no subscription format at all', () => {
    // The AmneziaWG buyer measured on the lab: 0 bytes from plain, empty
    // proxies from clash, a lone `direct` from sing-box. Their clients come
    // from the file channel, and no subscription-fetching app should be listed.
    expect(list([awg()])).toBe('');
  });

  it('a mixed subscription is judged on what it has, not on its worst part', () => {
    // One xhttp node and one raw node: sing-box renders the raw one, so a
    // sing-box client is still worth offering.
    expect(usableFormats([xray('xhttp'), xray('raw')]).has('singbox')).toBe(true);
    // And the tunnel alongside a proxy does not suppress the proxy formats.
    expect(usableFormats([awg(), xray('raw')]).has('plain')).toBe(true);
  });

  it('says nothing is usable when there is nothing to render', () => {
    expect(usableFormats([]).size).toBe(0);
  });
});
