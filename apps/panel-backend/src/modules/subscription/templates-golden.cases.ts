import type { RoutingPresetId } from '@iceslab/shared';
import type { SubscriptionEndpoint } from './subscription.formats.js';
import type { DeviceRouteRule } from '../routing-presets/routing-presets.builtins.js';
import { buildClashYaml } from './formats/clash.js';
import { buildSingboxJson } from './formats/singbox.js';
import { buildXrayJson, buildXrayJsonArray } from './formats/xrayjson.js';

/**
 * A-236 step 3: the cases the Default-template golden is taken over. The
 * golden (formats/__testdata__/templates-default.golden.json) was written from
 * these BEFORE the builders were moved onto frames; the test renders them
 * again and wants every byte back.
 *
 * Endpoints of every kind the four formats write, three sets (all, none, one),
 * the routing presets (three built-ins and an own one), and the options each
 * format has (bundles, the operator's custom rules and domain lists, the TLS
 * fragment, xkeen).
 */

const base = { nodeId: 'n', port: 443 } as const;
const UUID = '11111111-1111-4111-8111-111111111111';

const ALL = [
  {
    ...base, protocol: 'xray', nodeName: 'de-vless', host: 'de.example.com', uri: '', uuid: UUID, publicKey: 'PUB',
    shortId: 'ab', sni: 'www.example.com', flow: 'xtls-rprx-vision', fingerprint: 'chrome', network: 'raw',
    subprotocol: 'vless', securityLayer: 'default',
  },
  {
    ...base, protocol: 'xray', nodeName: 'nl-ws', host: 'nl.example.com', uri: '', uuid: UUID, publicKey: '',
    shortId: '', sni: 'nl.example.com', flow: '', fingerprint: 'firefox', network: 'ws', path: '/w', hostHeader: 'cdn.example.com',
    subprotocol: 'vless', securityLayer: 'tls', alpn: ['h2', 'http/1.1'],
  },
  {
    ...base, protocol: 'xray', nodeName: 'fi-xhttp', host: 'fi.example.com', uri: '', uuid: UUID, publicKey: 'PUB2',
    shortId: 'cd', sni: 'www.example.org', flow: '', fingerprint: 'chrome', network: 'xhttp', path: '/x', xhttpMode: 'stream-one',
    subprotocol: 'vless', securityLayer: 'default',
  },
  {
    ...base, protocol: 'xray', nodeName: 'se-vmess', host: 'se.example.com', uri: '', uuid: UUID, publicKey: '',
    shortId: '', sni: '', flow: '', fingerprint: '', network: 'ws', path: '/v', subprotocol: 'vmess', securityLayer: 'none',
  },
  {
    ...base, protocol: 'xray', nodeName: 'pl-trojan', host: 'pl.example.com', uri: '', uuid: UUID, publicKey: '',
    shortId: '', sni: 'pl.example.com', flow: '', fingerprint: 'chrome', network: 'grpc', serviceName: 'svc',
    subprotocol: 'trojan', securityLayer: 'tls', allowInsecure: true,
  },
  {
    ...base, protocol: 'xray', nodeName: 'cz-trojan', host: 'cz.example.com', uri: '', uuid: UUID, publicKey: 'PUB3',
    shortId: 'ef', sni: 'www.example.net', flow: '', fingerprint: 'chrome', network: 'raw', subprotocol: 'trojan',
    securityLayer: 'default',
    cascadeExits: [
      { name: 'exit-a', tag: 1 },
      { name: 'exit-b', tag: 2 },
    ],
  },
  {
    ...base, protocol: 'hysteria', nodeName: 'hy', host: 'hy.example.com', uri: '', password: 'p w',
    obfsPassword: 'ob', portHoppingStart: 20000, portHoppingEnd: 30000, downMbps: 100,
    tlsPin: { certSha256: 'aabb', certPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n', serverName: '1.2.3.4' },
    sni: 'hy.example.com',
  },
  { ...base, protocol: 'shadowsocks', nodeName: 'ss', host: 'ss.example.com', uri: '', method: 'chacha20-ietf-poly1305', password: 'p' },
  {
    ...base, protocol: 'tuic', nodeName: 'tuic', host: 'tu.example.com', uri: '', uuid: UUID, password: 'p',
    serverName: 'www.example.com', congestionControl: 'bbr',
  },
  { ...base, protocol: 'anytls', nodeName: 'anytls', host: 'an.example.com', uri: '', password: 'p', serverName: 'www.example.com' },
  {
    ...base, protocol: 'shadowtls', nodeName: 'stls', host: 'st.example.com', uri: '', shadowtlsPassword: 'p',
    handshake: 'www.example.com', ssMethod: '2022-blake3-aes-128-gcm', ssPassword: 'p',
  },
  { ...base, protocol: 'mieru', nodeName: 'mieru', host: 'mi.example.com', uri: '', username: 'u', password: 'p', mtu: 1400 },
  { ...base, protocol: 'xray', subprotocol: 'socks', nodeName: 'tg-socks', host: 'tg.example.com', uri: '', username: 'bob', password: 'pw' },
  { ...base, protocol: 'xray', subprotocol: 'http', nodeName: 'tg-http', host: 'tg.example.com', uri: '', username: 'bob', password: 'pw' },
] as unknown as SubscriptionEndpoint[];

const SETS: Record<string, SubscriptionEndpoint[]> = { all: ALL, none: [], one: [ALL[0]!] };

const OWN: DeviceRouteRule[] = [
  { match: ['geosite:google', 'example.io'], action: 'direct', note: '' },
  { match: ['10.0.0.0/8', 'port:25'], action: 'block', note: '' },
  { match: ['geoip:us'], action: 'proxy', note: '' },
];
const PRESETS: { key: string; opts: { routingPreset?: RoutingPresetId; ownPresetRules?: DeviceRouteRule[] } }[] = [
  { key: 'proxy-all', opts: { routingPreset: 'proxy-all' } },
  { key: 'ru-split', opts: { routingPreset: 'ru-split' } },
  { key: 'cn-split', opts: { routingPreset: 'cn-split' } },
  { key: 'own', opts: { ownPresetRules: OWN } },
];

const CDL = { direct: ['domain:direct.example', 'plain.example'], proxy: ['proxied.example'], block: ['ads.example'] };
const CUSTOM_RULES = [{ type: 'field', domain: ['geosite:netflix'], outboundTag: 'direct' }];

/** Every case: a name and the output of today's builder for it. */
export function goldenCases(): Record<string, () => string> {
  const out: Record<string, () => string> = {};
  for (const [set, eps] of Object.entries(SETS)) {
    for (const p of PRESETS) {
      const k = (fmt: string, extra = '') => `${fmt}/${set}/${p.key}${extra}`;
      out[k('clash')] = () => buildClashYaml(eps, { ...p.opts });
      out[k('clash', '/cdl')] = () => buildClashYaml(eps, { ...p.opts, customDomainLists: CDL });
      out[k('singbox')] = () => buildSingboxJson(eps, { ...p.opts });
      out[k('singbox', '/url-test')] = () => buildSingboxJson(eps, { ...p.opts, bundle: 'url-test' });
      out[k('xrayjson')] = () => buildXrayJson(eps, { ...p.opts });
      out[k('xrayjson', '/balancer')] = () => buildXrayJson(eps, { ...p.opts, bundle: 'balancer' });
      out[k('xrayjson', '/all-options')] = () =>
        buildXrayJson(eps, { ...p.opts, customRules: CUSTOM_RULES, customDomainLists: CDL, tlsFragment: true });
      out[k('xkeen')] = () => buildXrayJson(eps, { ...p.opts, forRouter: true, customDomainLists: CDL });
      out[k('xrayjson-array')] = () => buildXrayJsonArray(eps, { ...p.opts });
      out[k('xrayjson-array', '/all-options')] = () =>
        buildXrayJsonArray(eps, { ...p.opts, customRules: CUSTOM_RULES, customDomainLists: CDL, tlsFragment: true });
    }
  }
  return out;
}
