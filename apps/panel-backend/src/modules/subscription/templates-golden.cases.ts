import type { DnsRule, RoutingPresetId } from '@iceslab/shared';
import type { SubscriptionEndpoint } from './subscription.formats.js';
import type { DeviceRouteRule } from '../routing-presets/routing-presets.builtins.js';
import { buildClashYaml } from './formats/clash.js';
import { buildSingboxJson } from './formats/singbox.js';
import { buildXrayJson, buildXrayJsonArray } from './formats/xrayjson.js';
import { expandCascadeEntry } from './cascade-entries.js';

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
  // A-262: a balancer-cascade entry. VLESS, the only kind a route goes into
  // (a trojan one here until 26.10, whose re-tagged password the entry
  // refused), with labels as disambiguateCascadeLabels leaves them.
  {
    ...base, protocol: 'xray', nodeName: 'cz-cascade', host: 'cz.example.com', uri: '', uuid: UUID, publicKey: 'PUB3',
    shortId: 'ef', sni: 'www.example.net', flow: 'xtls-rprx-vision', fingerprint: 'chrome', network: 'raw', subprotocol: 'vless',
    securityLayer: 'default',
    cascadeExits: [
      { label: 'stand-cascade → SE', tag: 1 },
      { label: 'stand-cascade → DE', tag: 2 },
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

// Through the expansion every format is handed in production
// (generateSubscription, A-262): a cascade entry arrives as its routes.
const SETS: Record<string, SubscriptionEndpoint[]> = { all: ALL.flatMap(expandCascadeEntry), none: [], one: [ALL[0]!] };

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

// Stage 19.4: DNS rules of the kinds xray runs, and a DoT one it does not.
const XRAY_DNS_RULES: DnsRule[] = [
  { match: ['corp.example', 'geosite:category-ads-all'], server: 'tcp://10.0.0.2', note: '' },
  { match: ['full:www.other.example'], server: 'https://dns.corp.example/dns-query', note: '' },
  { match: ['skipped.example'], server: 'tls://10.0.0.9', note: '' },
];

// Milestone 19.6: DNS rules of every server kind, two of them on one server.
const SINGBOX_DNS_RULES: DnsRule[] = [
  { match: ['domain:corp.example', 'full:host.corp.example'], server: 'tcp://10.0.0.1', note: '' },
  { match: ['geosite:category-ru'], server: '10.0.0.2', note: '' },
  { match: ['intra.example'], server: 'tcp://10.0.0.1', note: '' },
  { match: ['dot.example'], server: 'tls://dns.example:8853', note: '' },
  { match: ['doh.example'], server: 'https://dns.example/q', note: '' },
];

const CDL = { direct: ['domain:direct.example', 'plain.example'], proxy: ['proxied.example'], block: ['ads.example'] };
// Stage 19.5: the DNS rules the mihomo cases carry; Stash and legacy Clash get none of it.
const MIHOMO_DNS_RULES: DnsRule[] = [
  { match: ['domain:corp.example', 'full:host.corp.example', 'geosite:category-ru'], server: 'tcp://10.0.0.1', note: '' },
  { match: ['geosite:category-ads-all'], server: 'https://dns.example/dns-query', note: '' },
];
const CUSTOM_RULES = [{ type: 'field', domain: ['geosite:netflix'], outboundTag: 'direct' }];

/** Every case: a name and the output of today's builder for it. */
export function goldenCases(): Record<string, () => string> {
  const out: Record<string, () => string> = {};
  for (const [set, eps] of Object.entries(SETS)) {
    for (const p of PRESETS) {
      const k = (fmt: string, extra = '') => `${fmt}/${set}/${p.key}${extra}`;
      out[k('clash')] = () => buildClashYaml(eps, { ...p.opts });
      out[k('clash', '/cdl')] = () => buildClashYaml(eps, { ...p.opts, customDomainLists: CDL });
      out[k('clash', '/dns')] = () => buildClashYaml(eps, { ...p.opts, dnsRules: MIHOMO_DNS_RULES });
      out[k('singbox')] = () => buildSingboxJson(eps, { ...p.opts });
      out[k('singbox', '/url-test')] = () => buildSingboxJson(eps, { ...p.opts, bundle: 'url-test' });
      out[k('singbox', '/dns')] = () => buildSingboxJson(eps, { ...p.opts, dnsRules: SINGBOX_DNS_RULES });
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
  // Stage 19.4: with DNS rules the xray formats grow a `dns` section, the dns
  // outbound and the port 53 rule (not in xkeen). Added cases; the ones above are
  // the empty-rules output and stay as they were.
  for (const [set, eps] of Object.entries(SETS)) {
    for (const p of PRESETS) {
      const k = (fmt: string) => `${fmt}/${set}/${p.key}/dns-rules`;
      out[k('xrayjson')] = () => buildXrayJson(eps, { ...p.opts, dnsRules: XRAY_DNS_RULES });
      out[k('xkeen')] = () => buildXrayJson(eps, { ...p.opts, forRouter: true, dnsRules: XRAY_DNS_RULES });
      out[k('xrayjson-array')] = () => buildXrayJsonArray(eps, { ...p.opts, dnsRules: XRAY_DNS_RULES });
    }
  }
  return out;
}
