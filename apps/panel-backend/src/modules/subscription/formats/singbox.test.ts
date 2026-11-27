import { describe, expect, it } from 'vitest';
import { buildSingboxJson } from './singbox.js';
import type { SubscriptionEndpoint } from '../subscription.formats.js';
import { readFrame } from '../subscription.frames.js';
import type { SelfHostedGeo } from '../../geo-sets/geo-self-host.js';

const hysteriaEp: SubscriptionEndpoint = {
  protocol: 'hysteria',
  nodeName: 'eu-1',
  host: 'n1.example.com',
  port: 443,
  password: 'hy-secret',
  uri: 'hysteria2://...',
};

const xrayEp: SubscriptionEndpoint = {
  protocol: 'xray',
  nodeName: 'eu-1',
  host: 'n1.example.com',
  port: 443,
  uuid: '11111111-2222-3333-4444-555555555555',
  publicKey: 'pubkey-base64url',
  shortId: 'abc123',
  sni: 'www.cloudflare.com',
  flow: 'xtls-rprx-vision',
  fingerprint: 'chrome',
  network: 'raw',
  uri: 'vless://...',
};

// Slice 24c part 3a: Trojan subprotocol over the same REALITY stack.
const trojanEp: SubscriptionEndpoint = {
  ...xrayEp,
  subprotocol: 'trojan',
  uri: 'trojan://...',
};

// Slice 24d: Shadowsocks 2022.
const ssEp: SubscriptionEndpoint = {
  protocol: 'shadowsocks',
  nodeName: 'eu-1',
  host: 'n1.example.com',
  port: 8388,
  method: '2022-blake3-aes-256-gcm',
  password: 'cabc78ae-94e3-4a16-936a-133d059acfac',
  uri: 'ss://...',
};

// ShadowTLS v3: an ss outbound that detours through a shadowtls outbound.
const shadowtlsEp: SubscriptionEndpoint = {
  protocol: 'shadowtls',
  nodeName: 'eu-1',
  host: 'n1.example.com',
  port: 443,
  shadowtlsPassword: 'stls-user-pw',
  handshake: 'www.microsoft.com',
  ssMethod: '2022-blake3-aes-128-gcm',
  ssPassword: 'inner-ss-key',
  uri: '',
};

/**
 * The sing-box config as these tests READ it.
 *
 * Only the fields the assertions touch, named once. They used to be `any`
 * twenty-six times over, which is the same admission repeated and checked
 * never: `o.server_prot` would have read as undefined and the expectation would
 * have failed somewhere else entirely, or passed.
 *
 * Deliberately NOT a description of sing-box's schema. It is a description of
 * what OUR builder emits, which is the thing under test, and every optional
 * marker below says "this outbound type does not carry that field".
 */
interface SbOutbound {
  type: string;
  tag: string;
  server?: string;
  server_port?: number;
  password?: string;
  uuid?: string;
  method?: string;
  flow?: string;
  version?: number;
  detour?: string;
  /** Selector only: the tags it offers, and which one it opens on. */
  outbounds?: string[];
  default?: string;
  tls?: {
    enabled?: boolean;
    server_name?: string;
    insecure?: boolean;
    utls?: { enabled: boolean; fingerprint: string };
    reality?: { enabled: boolean; public_key: string; short_id: string };
  };
  transport?: {
    type?: string;
    path?: string;
    host?: string | string[];
    service_name?: string;
    headers?: Record<string, string>;
  };
}

interface SbConfig {
  log?: Record<string, unknown>;
  inbounds: { type: string; tag?: string }[];
  outbounds: SbOutbound[];
  dns?: {
    servers: Record<string, unknown>[];
    rules: { rule_set?: string[]; server: string }[];
    final: string;
    strategy?: string;
  };
  route: {
    default_domain_resolver?: string;
    final?: string;
    auto_detect_interface?: boolean;
    rules?: Record<string, unknown>[];
    rule_set?: Record<string, unknown>[];
  };
}

function parse(out: string): SbConfig {
  return JSON.parse(out) as SbConfig;
}

describe('buildSingboxJson', () => {
  it('outputs valid JSON ending in a newline', () => {
    const out = buildSingboxJson([hysteriaEp]);
    expect(out.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('emits exactly one tun inbound and no listening proxy inbound (no localhost leak)', () => {
    const cfg = parse(buildSingboxJson([hysteriaEp]));
    expect(cfg.inbounds).toHaveLength(1);
    expect(cfg.inbounds[0].type).toBe('tun');
    // Never a mixed/socks/http listener: that would open a localhost proxy port.
    expect(
      cfg.inbounds.some((i) => ['mixed', 'socks', 'http'].includes(i.type)),
    ).toBe(false);
  });

  it('emits a hysteria2 outbound with mandatory fields', () => {
    const cfg = parse(buildSingboxJson([hysteriaEp]));
    const hy = cfg.outbounds.find((o) => o.type === 'hysteria2');
    expect(hy).toBeDefined();
    expect(hy.tag).toBe('eu-1-hysteria');
    expect(hy.server).toBe('n1.example.com');
    expect(hy.server_port).toBe(443);
    expect(hy.password).toBe('hy-secret');
  });

  it('emits a vless+REALITY outbound nested under tls', () => {
    const cfg = parse(buildSingboxJson([xrayEp]));
    const v = cfg.outbounds.find((o) => o.type === 'vless');
    expect(v).toBeDefined();
    expect(v.uuid).toBe('11111111-2222-3333-4444-555555555555');
    expect(v.flow).toBe('xtls-rprx-vision');
    expect(v.tls.enabled).toBe(true);
    expect(v.tls.server_name).toBe('www.cloudflare.com');
    expect(v.tls.utls.fingerprint).toBe('chrome');
    expect(v.tls.reality.enabled).toBe(true);
    expect(v.tls.reality.public_key).toBe('pubkey-base64url');
    expect(v.tls.reality.short_id).toBe('abc123');
  });

  it('appends an Auto selector listing every proxy plus direct', () => {
    const cfg = parse(buildSingboxJson([hysteriaEp, xrayEp]));
    const sel = cfg.outbounds.find((o) => o.type === 'selector');
    expect(sel.tag).toBe('Auto');
    expect(sel.outbounds).toEqual(['eu-1-hysteria', 'eu-1-xray', 'direct']);
    expect(sel.default).toBe('eu-1-hysteria');
  });

  it('always includes a direct outbound', () => {
    const cfg = parse(buildSingboxJson([hysteriaEp]));
    expect(cfg.outbounds.find((o) => o.type === 'direct' && o.tag === 'direct')).toBeDefined();
  });

  it('routes everything through Auto via route.final', () => {
    const cfg = parse(buildSingboxJson([hysteriaEp]));
    expect(cfg.route.final).toBe('Auto');
    expect(cfg.route.auto_detect_interface).toBe(true);
  });

  it('falls back to route.final = direct when no proxies are emitted', () => {
    const cfg = parse(buildSingboxJson([]));
    expect(cfg.route.final).toBe('direct');
    // No selector when empty.
    expect(cfg.outbounds.find((o) => o.type === 'selector')).toBeUndefined();
    // Just the direct outbound.
    expect(cfg.outbounds).toHaveLength(1);
  });

  it('output is byte-deterministic for the same input', () => {
    const a = buildSingboxJson([hysteriaEp, xrayEp]);
    const b = buildSingboxJson([hysteriaEp, xrayEp]);
    expect(a).toBe(b);
  });

  it('emits shadowtls: an ss outbound detouring through a shadowtls v3 outbound', () => {
    const cfg = parse(buildSingboxJson([shadowtlsEp]));
    // The selectable proxy is a shadowsocks outbound reached only via detour.
    const ss = cfg.outbounds.find(
      (o) => o.type === 'shadowsocks' && o.tag === 'eu-1-shadowtls',
    )!;
    expect(ss).toBeDefined();
    expect(ss.method).toBe('2022-blake3-aes-128-gcm');
    expect(ss.password).toBe('inner-ss-key');
    expect(ss.detour).toBe('eu-1-shadowtls-stls');
    expect(ss.server).toBeUndefined(); // reached via detour, not directly
    // Its dialer is a shadowtls v3 outbound fronting the real handshake host.
    const stls = cfg.outbounds.find((o) => o.type === 'shadowtls');
    expect(stls).toBeDefined();
    expect(stls.tag).toBe('eu-1-shadowtls-stls');
    expect(stls.server).toBe('n1.example.com');
    expect(stls.server_port).toBe(443);
    expect(stls.version).toBe(3);
    expect(stls.password).toBe('stls-user-pw');
    expect(stls.tls.enabled).toBe(true);
    expect(stls.tls.server_name).toBe('www.microsoft.com');
  });

  // ShadowTLS carries TCP by construction, so UDP-over-TCP is the only UDP the
  // channel has. `network: 'tcp'` would pin the outbound to TCP and make the
  // flag moot, so both halves are asserted.
  it('lets UDP through the shadowtls channel: the ss outbound speaks UoT', () => {
    const cfg = parse(buildSingboxJson([shadowtlsEp]));
    const ss = cfg.outbounds.find((o: { type: string; tag: string }) => o.type === 'shadowsocks' && o.tag === 'eu-1-shadowtls');
    expect(ss.udp_over_tcp).toBe(true);
    expect(ss.network).toBeUndefined();
  });

  // ───── Slice 24c part 3a: Trojan subprotocol ─────

  it('emits a trojan outbound when subprotocol=trojan; UUID becomes password', () => {
    const cfg = parse(buildSingboxJson([trojanEp]));
    const t = cfg.outbounds.find((o) => o.type === 'trojan');
    expect(t).toBeDefined();
    expect(t.tag).toBe('eu-1-xray'); // tag is by protocol field, not subprotocol
    expect(t.password).toBe('11111111-2222-3333-4444-555555555555');
    expect(t.uuid).toBeUndefined(); // Trojan outbound MUST NOT carry uuid
    expect(t.flow).toBeUndefined(); // Vision flow only on VLESS
  });

  it('Trojan still nests REALITY tls.reality block', () => {
    const cfg = parse(buildSingboxJson([trojanEp]));
    const t = cfg.outbounds.find((o) => o.type === 'trojan');
    expect(t.tls.reality.enabled).toBe(true);
    expect(t.tls.reality.public_key).toBe('pubkey-base64url');
  });

  // ───── VMess + security modes (none / tls) ─────

  it('emits a vmess outbound (security auto, alter_id 0), no reality', () => {
    const cfg = parse(
      buildSingboxJson([
        { ...xrayEp, subprotocol: 'vmess', securityLayer: 'none', network: 'ws', flow: undefined },
      ]),
    );
    const v = cfg.outbounds.find((o) => o.type === 'vmess');
    expect(v).toBeDefined();
    expect(v.uuid).toBe('11111111-2222-3333-4444-555555555555');
    expect(v.security).toBe('auto');
    expect(v.alter_id).toBe(0);
    expect(v.tls).toBeUndefined(); // none = no TLS block
  });

  it('security none omits the tls block', () => {
    const cfg = parse(buildSingboxJson([{ ...xrayEp, securityLayer: 'none' }]));
    const v = cfg.outbounds.find((o) => o.type === 'vless');
    expect(v.tls).toBeUndefined();
  });

  it('security tls emits a tls block without reality', () => {
    const cfg = parse(buildSingboxJson([{ ...xrayEp, securityLayer: 'tls' }]));
    const v = cfg.outbounds.find((o) => o.type === 'vless');
    expect(v.tls.enabled).toBe(true);
    expect(v.tls.server_name).toBe('www.cloudflare.com');
    expect(v.tls.reality).toBeUndefined();
  });

  // ───── Slice 24d: Shadowsocks ─────

  it('emits a shadowsocks outbound with method+password and no TLS', () => {
    const cfg = parse(buildSingboxJson([ssEp]));
    const ss = cfg.outbounds.find((o) => o.type === 'shadowsocks');
    expect(ss).toBeDefined();
    expect(ss.tag).toBe('eu-1-shadowsocks');
    expect(ss.server).toBe('n1.example.com');
    expect(ss.server_port).toBe(8388);
    expect(ss.method).toBe('2022-blake3-aes-256-gcm');
    expect(ss.password).toBe('cabc78ae-94e3-4a16-936a-133d059acfac');
    // SS doesn't carry TLS, that field would confuse sing-box's parser
    expect(ss.tls).toBeUndefined();
  });

  // sing-box reads `network: 'tcp'` as "UDP off" ("UDP is not supported by
  // outbound"): the stand 11.5 defect, reproduced on 1.13.19 against a 1.13
  // shadowsocks inbound. Unset is tcp and udp both.
  it('leaves UDP on in the shadowsocks outbound: no network key', () => {
    const cfg = parse(buildSingboxJson([ssEp]));
    const ss = cfg.outbounds.find((o) => o.type === 'shadowsocks');
    expect(ss.network).toBeUndefined();
    expect(ss.udp_over_tcp).toBe(false);
  });

  it('mixed subscription emits all proxy types in the Auto selector', () => {
    const cfg = parse(buildSingboxJson([hysteriaEp, xrayEp, trojanEp, ssEp]));
    const sel = cfg.outbounds.find((o) => o.type === 'selector');
    // Note: xrayEp and trojanEp share tag 'eu-1-xray' since both have
    // protocol='xray', only the subprotocol differs. In real subscriptions
    // they'd be on different ports/inbounds with unique nodeNames so tags
    // wouldn't actually collide.
    expect(sel.outbounds).toContain('eu-1-hysteria');
    expect(sel.outbounds).toContain('eu-1-xray');
    expect(sel.outbounds).toContain('eu-1-shadowsocks');
    expect(sel.outbounds).toContain('direct');
  });

  // ───── Slice 24c part 2: transport branches ─────

  it('emits ws transport block with path + Host header', () => {
    const wsEp = { ...xrayEp, network: 'ws' as const, path: '/api', hostHeader: 'cdn.example.com' };
    const cfg = parse(buildSingboxJson([wsEp]));
    const v = cfg.outbounds.find((o) => o.type === 'vless');
    expect(v.transport.type).toBe('ws');
    expect(v.transport.path).toBe('/api');
    expect(v.transport.headers.Host).toBe('cdn.example.com');
  });

  it('emits httpupgrade transport block', () => {
    const huEp = { ...xrayEp, network: 'httpupgrade' as const, path: '/u', hostHeader: 'cdn.example.com' };
    const cfg = parse(buildSingboxJson([huEp]));
    const v = cfg.outbounds.find((o) => o.type === 'vless');
    expect(v.transport.type).toBe('httpupgrade');
    expect(v.transport.path).toBe('/u');
    expect(v.transport.host).toBe('cdn.example.com');
  });

  it('emits grpc transport block with service_name', () => {
    const grpcEp = { ...xrayEp, network: 'grpc' as const, serviceName: 'GunSvc' };
    const cfg = parse(buildSingboxJson([grpcEp]));
    const v = cfg.outbounds.find((o) => o.type === 'vless');
    expect(v.transport.type).toBe('grpc');
    expect(v.transport.service_name).toBe('GunSvc');
  });

  it('omits transport block on raw (REALITY canonical)', () => {
    const cfg = parse(buildSingboxJson([xrayEp])); // network: 'raw'
    const v = cfg.outbounds.find((o) => o.type === 'vless');
    expect(v.transport).toBeUndefined();
  });

  // ───── Routing Templates (R1b) ─────

  describe('routingPreset', () => {
    it('default proxy-all output is byte-identical to pre-R1 (no rules / rule_set)', () => {
      expect(buildSingboxJson([xrayEp], { routingPreset: 'proxy-all' })).toBe(
        buildSingboxJson([xrayEp]),
      );
      const cfg = parse(buildSingboxJson([xrayEp]));
      expect(cfg.route.rules).toBeUndefined();
      expect(cfg.route.rule_set).toBeUndefined();
    });

    it('ru-split emits four remote binary rule-sets without download_detour', () => {
      const cfg = parse(buildSingboxJson([xrayEp], { routingPreset: 'ru-split' }));
      const sets = cfg.route.rule_set;
      expect(sets.map((s) => s.tag)).toEqual([
        'geosite-category-ads-all',
        'geosite-category-ru',
        'geosite-category-gov-ru',
        'geoip-ru',
      ]);
      for (const s of sets) {
        expect(s.type).toBe('remote');
        expect(s.format).toBe('binary');
        expect(s.url).toMatch(
          /^https:\/\/raw\.githubusercontent\.com\/SagerNet\/sing-(geosite|geoip)\/rule-set\/.+\.srs$/,
        );
        // Deprecated since sing-box 1.14 and redundant: until the rule-set
        // is downloaded its rules cannot match, so the fetch rides final.
        expect(s.download_detour).toBeUndefined();
      }
    });

    it('ru-split rules: reject ads, direct private IPs and RU, final stays Auto', () => {
      const cfg = parse(buildSingboxJson([xrayEp], { routingPreset: 'ru-split' }));
      const rules = cfg.route.rules;
      expect(rules).toHaveLength(3);
      expect(rules[0]).toEqual({
        rule_set: ['geosite-category-ads-all'],
        action: 'reject',
      });
      expect(rules[1]).toEqual({
        ip_is_private: true,
        action: 'route',
        outbound: 'direct',
      });
      expect(rules[2]).toEqual({
        rule_set: ['geosite-category-ru', 'geosite-category-gov-ru', 'geoip-ru'],
        action: 'route',
        outbound: 'direct',
      });
      expect(cfg.route.final).toBe('Auto');
    });

    it('ru-split composes with bundle=url-test (rules present, final = Auto-URLTest)', () => {
      const cfg = parse(
        buildSingboxJson([xrayEp], {
          bundle: 'url-test',
          routingPreset: 'ru-split',
        }),
      );
      expect(cfg.route.rules).toHaveLength(3);
      expect(cfg.route.final).toBe('Auto-URLTest');
    });
  });

  // ───── Routing Templates (H2) - cn-split ─────

  describe('routingPreset cn-split', () => {
    it('emits three remote binary rule-sets (ads + geosite-cn + geoip-cn)', () => {
      const cfg = parse(buildSingboxJson([xrayEp], { routingPreset: 'cn-split' }));
      const sets = cfg.route.rule_set;
      expect(sets.map((s) => s.tag)).toEqual([
        'geosite-category-ads-all',
        'geosite-cn',
        'geoip-cn',
      ]);
      for (const s of sets) {
        expect(s.type).toBe('remote');
        expect(s.format).toBe('binary');
        expect(s.url).toMatch(
          /^https:\/\/raw\.githubusercontent\.com\/SagerNet\/sing-(geosite|geoip)\/rule-set\/.+\.srs$/,
        );
        expect(s.download_detour).toBeUndefined();
      }
    });

    it('rules: reject ads, direct private IPs and CN, final stays Auto', () => {
      const cfg = parse(buildSingboxJson([xrayEp], { routingPreset: 'cn-split' }));
      const rules = cfg.route.rules;
      expect(rules).toHaveLength(3);
      expect(rules[0]).toEqual({
        rule_set: ['geosite-category-ads-all'],
        action: 'reject',
      });
      expect(rules[1]).toEqual({
        ip_is_private: true,
        action: 'route',
        outbound: 'direct',
      });
      expect(rules[2]).toEqual({
        rule_set: ['geosite-cn', 'geoip-cn'],
        action: 'route',
        outbound: 'direct',
      });
      expect(cfg.route.final).toBe('Auto');
    });

    it('resolves CN domains regionally and leaks no RU rule-sets', () => {
      const out = buildSingboxJson([xrayEp], { routingPreset: 'cn-split' });
      const cfg = parse(out);
      expect(cfg.dns!.servers[0]).toEqual({ type: 'udp', tag: 'dns-regional', server: '223.5.5.5' });
      expect(cfg.dns!.rules).toEqual([{ rule_set: ['geosite-cn'], server: 'dns-regional' }]);
      expect(cfg.route.default_domain_resolver).toBe('dns-regional');
      expect(out).not.toContain('geosite-category-ru');
      expect(out).not.toContain('geoip-ru');
      expect(out).not.toContain('77.88.8.8');
    });
  });

  // ───── Split DNS (f12-20) ─────

  describe('split DNS', () => {
    const rulesOf = (cfg: SbConfig) => cfg.dns!.rules.flatMap((r) => r.rule_set ?? []);
    const declared = (cfg: SbConfig) => cfg.route.rule_set!.map((r) => r.tag);

    it('ru-split: regional UDP direct, DoH through the proxy, default resolver is the regional one', () => {
      const cfg = parse(buildSingboxJson([xrayEp], { routingPreset: 'ru-split' }));
      expect(cfg.dns!.servers).toEqual([
        { type: 'udp', tag: 'dns-regional', server: '77.88.8.8' },
        { type: 'https', tag: 'dns-proxy', server: '1.1.1.1', detour: 'Auto' },
      ]);
      expect(cfg.dns!.rules).toEqual([
        { rule_set: ['geosite-category-ru', 'geosite-category-gov-ru'], server: 'dns-regional' },
      ]);
      expect(cfg.dns!.final).toBe('dns-proxy');
      expect(cfg.route.default_domain_resolver).toBe('dns-regional');
    });

    // sing-box 1.13.14 refuses to START (`sing-box check` passes) with
    // "detour to an empty direct outbound makes no sense" on a DNS server whose
    // detour is the plain direct outbound: direct is the default, so leave it out.
    it.each(['ru-split', 'cn-split'] as const)('%s: no DNS server detours to a direct outbound', (preset) => {
      const cfg = parse(buildSingboxJson([xrayEp], { routingPreset: preset }));
      const direct = new Set(cfg.outbounds.filter((o) => o.type === 'direct').map((o) => o.tag));
      expect(cfg.dns!.servers.length).toBeGreaterThan(0);
      for (const srv of cfg.dns!.servers as { detour?: string }[]) {
        expect(srv.detour === undefined || !direct.has(srv.detour)).toBe(true);
        expect(srv.detour).not.toBe('direct');
      }
    });

    it('follows the url-test group the traffic rides', () => {
      const cfg = parse(buildSingboxJson([xrayEp], { routingPreset: 'ru-split', bundle: 'url-test' }));
      expect(cfg.dns!.servers[1]).toMatchObject({ tag: 'dns-proxy', detour: 'Auto-URLTest' });
    });

    it.each(['ru-split', 'cn-split'] as const)('%s: the DNS rules name rule-sets that route declares and sends direct', (preset) => {
      const cfg = parse(buildSingboxJson([xrayEp], { routingPreset: preset }));
      const direct = cfg.route.rules!.filter((r) => r.outbound === 'direct').flatMap((r) => (r.rule_set as string[] | undefined) ?? []);
      for (const tag of rulesOf(cfg)) {
        expect(declared(cfg)).toContain(tag);
        expect(direct).toContain(tag);
      }
      // Domain sets only: an address set has no place in a DNS rule.
      expect(rulesOf(cfg).every((t) => t.startsWith('geosite-'))).toBe(true);
    });

    it('proxy-all: no dns block, no default_domain_resolver', () => {
      const cfg = parse(buildSingboxJson([xrayEp], { routingPreset: 'proxy-all' }));
      expect(Object.keys(cfg)).not.toContain('dns');
      expect(cfg.route.default_domain_resolver).toBeUndefined();
    });

    it('an own preset gets none', () => {
      const cfg = parse(
        buildSingboxJson([xrayEp], {
          ownPresetRules: [{ match: ['geosite:category-ru'], action: 'direct', note: '' }],
        }),
      );
      expect(Object.keys(cfg)).not.toContain('dns');
      expect(cfg.route.default_domain_resolver).toBeUndefined();
    });

    it('no node, no dns block', () => {
      const cfg = parse(buildSingboxJson([], { routingPreset: 'ru-split' }));
      expect(Object.keys(cfg)).not.toContain('dns');
      expect(cfg.route.default_domain_resolver).toBeUndefined();
    });

    it('the frame with its own dns is handed out as written', () => {
      const frame = readFrame('singbox', JSON.stringify({
        iceslab: { routing: 'preset' },
        dns: { servers: [{ type: 'udp', tag: 'mine', server: '9.9.9.9' }] },
        outbounds: [{ type: 'selector', tag: 'Pick', outbounds: [] }],
        route: { final: 'Pick' },
      }));
      const cfg = parse(buildSingboxJson([xrayEp], { frame, routingPreset: 'ru-split' }));
      expect(cfg.dns).toEqual({ servers: [{ type: 'udp', tag: 'mine', server: '9.9.9.9' }] });
      expect(cfg.route.default_domain_resolver).toBeUndefined();
    });

    it('a frame without iceslab routing gets none', () => {
      const frame = readFrame('singbox', JSON.stringify({ outbounds: [{ type: 'selector', tag: 'Pick', outbounds: [] }], route: { final: 'Pick' } }));
      expect(Object.keys(parse(buildSingboxJson([xrayEp], { frame, routingPreset: 'ru-split' })))).not.toContain('dns');
    });
  });

  // Milestone 19.6: the operator's DNS rules.
  describe('DNS rules', () => {
    const r = (server: string, ...match: string[]) => ({ match, server, note: '' });
    const OWN = [{ match: ['example.io'], action: 'direct' as const, note: '' }];
    const dnsOf = (opts: Parameters<typeof buildSingboxJson>[1]) => parse(buildSingboxJson([xrayEp], opts));
    const hijacks = (cfg: SbConfig) => (cfg.route.rules ?? []).filter((x) => x.action === 'hijack-dns');

    it('an own preset: no rules, no dns; a rule, a server per distinct value and a rule on the names', () => {
      expect(Object.keys(dnsOf({ ownPresetRules: OWN, dnsRules: [] }))).not.toContain('dns');
      const cfg = dnsOf({ ownPresetRules: OWN, dnsRules: [r('tcp://10.0.0.1', 'domain:corp.example', 'full:a.corp.example'), r('tcp://10.0.0.1', 'intra.example')] });
      expect(cfg.dns!.servers).toEqual([
        { type: 'local', tag: 'dns-local' },
        { type: 'https', tag: 'dns-proxy', server: '1.1.1.1', detour: 'Auto' },
        { type: 'tcp', tag: 'dns-tcp-10.0.0.1', server: '10.0.0.1', detour: 'Auto' },
      ]);
      expect(cfg.dns!.rules).toEqual([
        { domain: ['a.corp.example'], domain_suffix: ['corp.example'], server: 'dns-tcp-10.0.0.1' },
        { domain_suffix: ['intra.example'], server: 'dns-tcp-10.0.0.1' },
      ]);
      expect(cfg.dns!.final).toBe('dns-proxy');
      expect(cfg.route.default_domain_resolver).toBe('dns-local');
    });

    it('proxy-all gets the block too, with a hijack ahead of everything', () => {
      const cfg = dnsOf({ dnsRules: [r('10.0.0.2', 'corp.example')] });
      expect(cfg.dns!.servers[2]).toEqual({ type: 'udp', tag: 'dns-udp-10.0.0.2', server: '10.0.0.2', detour: 'Auto' });
      expect(cfg.route.rules).toEqual([{ action: 'sniff', sniffer: ['dns'] }, { protocol: 'dns', action: 'hijack-dns' }]);
    });

    it('proxy-all with no rules is what it was', () => {
      expect(buildSingboxJson([xrayEp], { dnsRules: [] })).toBe(buildSingboxJson([xrayEp]));
      for (const routingPreset of ['ru-split', 'cn-split'] as const)
        expect(buildSingboxJson([xrayEp], { routingPreset, dnsRules: [] })).toBe(buildSingboxJson([xrayEp], { routingPreset }));
    });

    it('every kind of server, with its port and path when they are not the default', () => {
      const cfg = dnsOf({
        dnsRules: [
          r('10.0.0.1', 'a.example'),
          r('tcp://10.0.0.1:5300', 'b.example'),
          r('tls://dns.example', 'c.example'),
          r('tls://[2001:db8::1]:8853', 'd.example'),
          r('https://dns.example', 'e.example'),
          r('https://dns.example:8443/q', 'f.example'),
        ],
      });
      expect(cfg.dns!.servers.slice(2)).toEqual([
        { type: 'udp', tag: 'dns-udp-10.0.0.1', server: '10.0.0.1', detour: 'Auto' },
        { type: 'tcp', tag: 'dns-tcp-10.0.0.1:5300', server: '10.0.0.1', server_port: 5300, detour: 'Auto' },
        { type: 'tls', tag: 'dns-tls-dns.example', server: 'dns.example', detour: 'Auto' },
        { type: 'tls', tag: 'dns-tls-2001:db8::1:8853', server: '2001:db8::1', server_port: 8853, detour: 'Auto' },
        { type: 'https', tag: 'dns-https-dns.example', server: 'dns.example', detour: 'Auto' },
        { type: 'https', tag: 'dns-https-dns.example:8443/q', server: 'dns.example', server_port: 8443, path: '/q', detour: 'Auto' },
      ]);
      expect(new Set(cfg.dns!.servers.map((s) => s.tag)).size).toBe(cfg.dns!.servers.length);
    });

    it('the servers detour through the url-test group the traffic rides', () => {
      const cfg = parse(buildSingboxJson([xrayEp], { dnsRules: [r('tcp://10.0.0.1', 'a.example')], bundle: 'url-test' }));
      expect(cfg.dns!.servers.every((s) => s.type === 'local' || s.detour === 'Auto-URLTest')).toBe(true);
    });

    it('ru-split: the operator rule stands before the regional one, the regional servers stay', () => {
      const cfg = dnsOf({ routingPreset: 'ru-split', dnsRules: [r('tcp://10.0.0.1', 'geosite:category-ru', 'corp.example')] });
      expect(cfg.dns!.servers.slice(0, 2)).toEqual([
        { type: 'udp', tag: 'dns-regional', server: '77.88.8.8' },
        { type: 'https', tag: 'dns-proxy', server: '1.1.1.1', detour: 'Auto' },
      ]);
      expect(cfg.dns!.rules).toEqual([
        { rule_set: ['geosite-category-ru'], server: 'dns-tcp-10.0.0.1' },
        { domain_suffix: ['corp.example'], server: 'dns-tcp-10.0.0.1' },
        { rule_set: ['geosite-category-ru', 'geosite-category-gov-ru'], server: 'dns-regional' },
      ]);
      expect(cfg.route.default_domain_resolver).toBe('dns-regional');
      expect(hijacks(cfg)).toHaveLength(1);
    });

    it('the rule-sets of a DNS rule are declared once, whoever else names them', () => {
      const cfg = dnsOf({ routingPreset: 'ru-split', dnsRules: [r('10.0.0.1', 'geosite:category-ru'), r('10.0.0.2', 'geosite:category-ru', 'geosite:google')] });
      const tags = cfg.route.rule_set!.map((x) => x.tag as string);
      expect(new Set(tags).size).toBe(tags.length);
      expect(tags).toContain('geosite-category-ru');
      expect(tags).toContain('geosite-google');
      for (const t of cfg.dns!.rules.flatMap((x) => x.rule_set ?? [])) expect(tags).toContain(t);
    });

    it('a hijack and a sniff of the frame are not doubled', () => {
      const frame = readFrame('singbox', JSON.stringify({
        iceslab: { routing: 'preset' },
        outbounds: [{ type: 'selector', tag: 'Pick', outbounds: [] }],
        route: { final: 'Pick', rules: [{ action: 'sniff' }, { protocol: 'dns', action: 'hijack-dns' }] },
      }));
      const cfg = parse(buildSingboxJson([xrayEp], { frame, dnsRules: [r('10.0.0.1', 'a.example')] }));
      expect(cfg.route.rules).toEqual([{ action: 'sniff' }, { protocol: 'dns', action: 'hijack-dns' }]);
      expect(cfg.dns!.servers[2]).toMatchObject({ detour: 'Pick' });
    });

    it('no rules written: a frame with its own dns, no node, no `iceslab.routing: preset`', () => {
      const dnsRules = [r('10.0.0.1', 'a.example')];
      const own = readFrame('singbox', JSON.stringify({
        iceslab: { routing: 'preset' },
        dns: { servers: [{ type: 'udp', tag: 'mine', server: '9.9.9.9' }] },
        outbounds: [{ type: 'selector', tag: 'Pick', outbounds: [] }],
        route: { final: 'Pick' },
      }));
      const withOwn = parse(buildSingboxJson([xrayEp], { frame: own, dnsRules }));
      expect(withOwn.dns).toEqual({ servers: [{ type: 'udp', tag: 'mine', server: '9.9.9.9' }] });
      expect(hijacks(withOwn)).toHaveLength(0);
      expect(JSON.stringify(withOwn.route)).not.toContain('10.0.0.1');
      const bare = parse(buildSingboxJson([], { dnsRules }));
      expect(Object.keys(bare)).not.toContain('dns');
      expect(bare.route.rules).toBeUndefined();
      const plain = readFrame('singbox', JSON.stringify({ outbounds: [{ type: 'selector', tag: 'Pick', outbounds: [] }], route: { final: 'Pick' } }));
      const noSwitch = parse(buildSingboxJson([xrayEp], { frame: plain, dnsRules }));
      expect(Object.keys(noSwitch)).not.toContain('dns');
      expect(noSwitch.route.rules).toBeUndefined();
    });
  });

  // ───── Byte-identity regression guards (H2) ─────

  describe('routingPreset byte-identity (H2 guard)', () => {
    it('proxy-all stays byte-identical to the default build', () => {
      expect(buildSingboxJson([xrayEp], { routingPreset: 'proxy-all' })).toBe(
        buildSingboxJson([xrayEp]),
      );
    });

    it('ru-split output differs from cn-split', () => {
      expect(buildSingboxJson([xrayEp], { routingPreset: 'ru-split' })).not.toBe(
        buildSingboxJson([xrayEp], { routingPreset: 'cn-split' }),
      );
    });
  });
  // Milestone 10.5: rule-sets from the panel itself (GEO_SELF_HOST).
  describe('the panel serves the rule-sets (GEO_SELF_HOST)', () => {
    const geo = (over: Partial<SelfHostedGeo> = {}): SelfHostedGeo => ({
      baseUrl: 'https://panel.example.com/geo/tok',
      tags: { geosite: new Set(['category-ads-all', 'category-ru', 'category-gov-ru']), geoip: new Set(['ru']) },
      srs: true,
      ...over,
    });
    const urls = (out: string) => Object.fromEntries(parse(out).route.rule_set!.map((r) => [r.tag as string, r.url as string]));
    const base = buildSingboxJson([xrayEp], { routingPreset: 'ru-split' });

    it('no geo (the flag off): the output is the base, byte for byte', () => {
      expect(buildSingboxJson([xrayEp], { routingPreset: 'ru-split', geo: null })).toBe(base);
      expect(buildSingboxJson([xrayEp], { routingPreset: 'ru-split', geo: undefined })).toBe(base);
    });

    it('every tag the panel has is its address, a remote binary rule-set as before', () => {
      const out = buildSingboxJson([xrayEp], { routingPreset: 'ru-split', geo: geo() });
      expect(urls(out)).toEqual({
        'geosite-category-ads-all': 'https://panel.example.com/geo/tok/geosite-category-ads-all.srs',
        'geosite-category-ru': 'https://panel.example.com/geo/tok/geosite-category-ru.srs',
        'geosite-category-gov-ru': 'https://panel.example.com/geo/tok/geosite-category-gov-ru.srs',
        'geoip-ru': 'https://panel.example.com/geo/tok/geoip-ru.srs',
      });
      for (const r of parse(out).route.rule_set!) expect(r).toMatchObject({ type: 'remote', format: 'binary' });
      // Rules and DNS are the base's: only the addresses moved.
      expect(out.replaceAll('https://panel.example.com/geo/tok/', 'X')).toBe(base.replace(/https:\/\/raw\.githubusercontent\.com\/SagerNet\/sing-geo(site|ip)\/rule-set\//g, 'X'));
    });

    it('a tag the panel set lacks stays on the base address, the others move', () => {
      const out = buildSingboxJson([xrayEp], {
        routingPreset: 'ru-split',
        geo: geo({ tags: { geosite: new Set(['category-ads-all', 'category-ru']), geoip: new Set(['ru']) } }),
      });
      const u = urls(out);
      expect(u['geosite-category-gov-ru']).toBe('https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-category-gov-ru.srs');
      expect(u['geosite-category-ru']).toBe('https://panel.example.com/geo/tok/geosite-category-ru.srs');
      expect(u['geoip-ru']).toBe('https://panel.example.com/geo/tok/geoip-ru.srs');
    });

    it('a set the panel does not serve: the base addresses', () => {
      expect(buildSingboxJson([xrayEp], { routingPreset: 'ru-split', geo: geo({ tags: { geosite: null, geoip: null } }) })).toBe(base);
    });

    it('no sing-box on the panel (nothing to compile): the base addresses, whatever the tags', () => {
      expect(buildSingboxJson([xrayEp], { routingPreset: 'ru-split', geo: geo({ srs: false }) })).toBe(base);
    });

    it('the tag is matched without case or @attr, as the compiler reads it', () => {
      const out = buildSingboxJson([xrayEp], {
        ownPresetRules: [{ action: 'direct', match: ['geosite:Google@CN', 'geoip:CN'] }],
        geo: geo({ tags: { geosite: new Set(['google']), geoip: new Set(['cn']) } }),
      });
      expect(urls(out)).toEqual({
        'geosite-google@cn': 'https://panel.example.com/geo/tok/geosite-google@cn.srs',
        'geoip-cn': 'https://panel.example.com/geo/tok/geoip-cn.srs',
      });
    });

    it('a tag whose name cannot be a file name of the route stays on the base address', () => {
      const out = buildSingboxJson([xrayEp], {
        ownPresetRules: [{ action: 'direct', match: ['geosite:a.b'] }],
        geo: geo({ tags: { geosite: new Set(['a.b']), geoip: new Set() } }),
      });
      expect(urls(out)['geosite-a.b']).toContain('raw.githubusercontent.com');
    });
  });
});

describe('buildSingboxJson IPv6 server', () => {
  it('server is the bare address', () => {
    const cfg = parse(buildSingboxJson([{ ...hysteriaEp, host: '2001:db8::1' }]));
    expect(cfg.outbounds.find((o) => o.type === 'hysteria2')?.server).toBe('2001:db8::1');
  });
});
