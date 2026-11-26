import { describe, expect, it } from 'vitest';
import { NETWORKS_CARRYING_VISION } from '@iceslab/shared';
import { emitsVisionFlow, type SubscriptionEndpoint } from '../subscription.formats.js';
import { buildClashYaml } from './clash.js';
import { buildSingboxJson } from './singbox.js';
import { buildXrayJson } from './xrayjson.js';
import { buildQuantumultXConf } from './quantumultx.js';
import { buildLoonConf } from './loon.js';
import { buildVlessRealityUri } from '../../../core-adapters/xray/uri.js';

/**
 * `xtls-rprx-vision` splices the TLS record layer: it rides RAW and XHTTP behind
 * a TLS-like layer, and nowhere else. The rule is one function, and every format
 * asks it. This walks network x security layer x format and pins whether the
 * flow is written, so a format that grows its own condition again fails here.
 */
const VISION = 'xtls-rprx-vision';
const NETWORKS = ['raw', 'xhttp', 'ws', 'grpc', 'httpupgrade', 'kcp'] as const;
const SECURITIES = ['default', 'tls', 'none'] as const;
type Network = (typeof NETWORKS)[number];
type Security = (typeof SECURITIES)[number];

function endpoint(network: Network, securityLayer: Security): SubscriptionEndpoint {
  return {
    protocol: 'xray',
    subprotocol: 'vless',
    nodeName: `v-${network}-${securityLayer}`,
    host: 'n.example.com',
    port: 443,
    uuid: '11111111-1111-4111-8111-111111111111',
    publicKey: 'PUBKEY',
    shortId: 'SHORT',
    sni: 'www.example.com',
    flow: VISION,
    fingerprint: 'chrome',
    network,
    path: '/p',
    hostHeader: 'cdn.example.com',
    serviceName: 'svc',
    securityLayer,
    uri: '',
  } as SubscriptionEndpoint;
}

const rule = (network: Network, sec: Security): boolean =>
  (NETWORKS_CARRYING_VISION as readonly string[]).includes(network) && sec !== 'none';

const FORMATS: Array<[string, (e: SubscriptionEndpoint) => string]> = [
  ['xrayjson', (e) => buildXrayJson([e])],
  ['clash', (e) => buildClashYaml([e])],
  ['singbox', (e) => buildSingboxJson([e])],
  ['loon', (e) => buildLoonConf([e])],
  ['quantumultx', (e) => buildQuantumultXConf([e])],
];

describe('emitsVisionFlow', () => {
  for (const network of NETWORKS) {
    for (const sec of SECURITIES) {
      it(`${network} / ${sec} -> ${rule(network, sec)}`, () => {
        expect(emitsVisionFlow(endpoint(network, sec))).toBe(rule(network, sec));
      });
    }
  }

  it('is false without a flow, and for the plain socks/http doors', () => {
    expect(emitsVisionFlow({ ...endpoint('raw', 'default'), flow: '' } as SubscriptionEndpoint)).toBe(false);
    expect(emitsVisionFlow({ ...endpoint('raw', 'default'), flow: undefined } as SubscriptionEndpoint)).toBe(false);
    expect(
      emitsVisionFlow({
        protocol: 'xray',
        subprotocol: 'socks',
        flow: VISION,
        nodeName: 'p',
        host: 'h',
        port: 1,
        username: 'u',
        password: 'p',
        uri: '',
      } as unknown as SubscriptionEndpoint),
    ).toBe(false);
  });

  it('an endpoint written without a network is raw', () => {
    expect(emitsVisionFlow({ ...endpoint('raw', 'default'), network: undefined } as SubscriptionEndpoint)).toBe(true);
  });
});

describe('Vision flow: network x security layer x format', () => {
  for (const [name, build] of FORMATS) {
    for (const network of NETWORKS) {
      for (const sec of SECURITIES) {
        it(`${name} / ${network} / ${sec}`, () => {
          const out = build(endpoint(network, sec));
          // A format that does not carry the transport writes no endpoint at
          // all, and so no flow: the rule only ever narrows what it writes.
          if (!rule(network, sec)) {
            expect(out).not.toContain(VISION);
          } else if (out.includes(`v-${network}-${sec}`) || name === 'xrayjson') {
            expect(out).toContain(VISION);
          }
        });
      }
    }
  }

  it('the formats that carry raw + REALITY write it, every one of them', () => {
    for (const [name, build] of FORMATS) {
      expect(build(endpoint('raw', 'default')), name).toContain(VISION);
    }
  });

  it('Loon no longer writes it without TLS or over a transport it cannot hold', () => {
    expect(buildLoonConf([endpoint('raw', 'none')])).not.toContain('flow=');
    expect(buildLoonConf([endpoint('raw', 'default')])).toContain(`flow=${VISION}`);
    expect(buildLoonConf([endpoint('ws', 'tls')])).not.toContain('flow=');
  });
});

describe('the share link against the same table', () => {
  // The link builder keys on the network alone and gets `flow` as a plain
  // option, so the network axis is its to answer. It still writes the flow with
  // the security layer `none` (its caller passes no flow in that case); that
  // difference from emitsVisionFlow is left as it was.
  for (const network of NETWORKS) {
    it(`${network}`, () => {
      const uri = buildVlessRealityUri({
        uuid: 'u',
        host: 'n.example.com',
        port: 443,
        publicKey: 'k',
        shortId: 's',
        sni: 'x',
        name: 'n',
        network,
        flow: VISION,
      } as Parameters<typeof buildVlessRealityUri>[0]);
      expect(uri.includes(`flow=${VISION}`)).toBe((NETWORKS_CARRYING_VISION as readonly string[]).includes(network));
    });
  }
});
