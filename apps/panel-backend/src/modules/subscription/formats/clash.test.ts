import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { DnsRule } from '@iceslab/shared';
import { readFrame } from '../subscription.frames.js';
import { buildClashYaml } from './clash.js';
import type { SubscriptionEndpoint } from '../subscription.formats.js';
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

const trojanEp: SubscriptionEndpoint = {
  ...xrayEp,
  subprotocol: 'trojan',
  uri: 'trojan://...',
};

const ssEp: SubscriptionEndpoint = {
  protocol: 'shadowsocks',
  nodeName: 'eu-1',
  host: 'n1.example.com',
  port: 8388,
  method: '2022-blake3-aes-256-gcm',
  password: 'cabc78ae-94e3-4a16-936a-133d059acfac',
  uri: 'ss://...',
};

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

const mieruEp: SubscriptionEndpoint = {
  protocol: 'mieru',
  nodeName: 'eu-1',
  host: 'n1.example.com',
  port: 2012,
  username: 'alice',
  password: 'cabc78ae-94e3-4a16-936a-133d059acfac',
  mtu: 1400,
  uri: 'mieru://...',
};

describe('buildClashYaml', () => {
  it('emits a hysteria2 proxy entry with mandatory fields', () => {
    const out = buildClashYaml([hysteriaEp]);
    expect(out).toContain('proxies:');
    expect(out).toContain('- name: eu-1-hysteria');
    expect(out).toContain('type: hysteria2');
    expect(out).toContain('server: n1.example.com');
    expect(out).toContain('port: 443');
    expect(out).toContain('password: hy-secret');
  });

  it('emits shadowtls as an ss proxy with the shadow-tls plugin', () => {
    const out = buildClashYaml([shadowtlsEp]);
    expect(out).toContain('- name: eu-1-shadowtls');
    expect(out).toContain('type: ss');
    expect(out).toContain('2022-blake3-aes-128-gcm'); // inner cipher
    expect(out).toContain('inner-ss-key'); // inner ss key (cipher password)
    expect(out).toContain('plugin: shadow-tls');
    expect(out).toContain('www.microsoft.com'); // handshake host in plugin-opts
    expect(out).toContain('stls-user-pw'); // per-user shadowtls password
    expect(out).toContain('version: 3');
  });

  it('emits a vless reality proxy entry with reality-opts block', () => {
    const out = buildClashYaml([xrayEp]);
    expect(out).toContain('- name: eu-1-xray');
    expect(out).toContain('type: vless');
    expect(out).toContain('uuid: 11111111-2222-3333-4444-555555555555');
    expect(out).toContain('flow: xtls-rprx-vision');
    expect(out).toContain('client-fingerprint: chrome');
    expect(out).toContain('reality-opts:');
    expect(out).toContain('public-key: pubkey-base64url');
    expect(out).toContain('short-id: abc123');
    // SNI must be quoted because of the dots, but bare alnum + dots is allowed
    // by our yamlString, so no quotes needed.
    expect(out).toContain('servername: www.cloudflare.com');
  });

  it('builds a url-test proxy-group listing every emitted proxy', () => {
    const out = buildClashYaml([hysteriaEp, xrayEp]);
    expect(out).toContain('- name: Auto');
    expect(out).toContain('type: url-test');
    expect(out).toMatch(/proxies:\s*\n\s+- eu-1-hysteria\s*\n\s+- eu-1-xray/);
  });

  it('produces a MATCH,DIRECT rule when no endpoints are emitted', () => {
    const out = buildClashYaml([]);
    expect(out).toContain('- MATCH,DIRECT');
    expect(out).not.toContain('- MATCH,Auto');
    // Empty proxies/groups must be valid YAML, `[]` is the safe form.
    expect(out).toMatch(/proxies:\s*\n\s+\[\]/);
    expect(out).toMatch(/proxy-groups:\s*\n\s+\[\]/);
  });

  it('quotes special chars in passwords (e.g. colon, hash)', () => {
    const out = buildClashYaml([{ ...hysteriaEp, password: 'pa:ss#word' }]);
    expect(out).toContain('password: "pa:ss#word"');
  });

  it('quotes node names containing spaces or special chars', () => {
    const out = buildClashYaml([{ ...hysteriaEp, nodeName: 'eu node #1' }]);
    expect(out).toContain('"eu node #1-hysteria"');
  });

  it('output is byte-deterministic for the same input', () => {
    const a = buildClashYaml([hysteriaEp, xrayEp]);
    const b = buildClashYaml([hysteriaEp, xrayEp]);
    expect(a).toBe(b);
  });

  it('output ends with a newline', () => {
    expect(buildClashYaml([hysteriaEp]).endsWith('\n')).toBe(true);
  });

  // ───── Slice 24c part 3a: Trojan subprotocol ─────

  it('emits a trojan proxy entry when subprotocol=trojan', () => {
    const out = buildClashYaml([trojanEp]);
    expect(out).toContain('type: trojan');
    expect(out).toContain('password: 11111111-2222-3333-4444-555555555555');
    expect(out).not.toContain('uuid:'); // Trojan uses password, not uuid
    expect(out).not.toContain('flow:'); // Vision flow VLESS-only
    // REALITY block still emitted
    expect(out).toContain('reality-opts:');
    expect(out).toContain('public-key: pubkey-base64url');
  });

  // ───── VMess + security modes (none / tls) ─────

  it('emits a vmess proxy with alterId/cipher and no reality-opts', () => {
    const out = buildClashYaml([
      { ...xrayEp, subprotocol: 'vmess', securityLayer: 'none', network: 'ws', flow: undefined },
    ]);
    expect(out).toContain('type: vmess');
    expect(out).toContain('alterId: 0');
    expect(out).toContain('cipher: auto');
    expect(out).not.toContain('reality-opts');
  });

  it('security none emits tls: false and no reality-opts', () => {
    const out = buildClashYaml([{ ...xrayEp, securityLayer: 'none' }]);
    expect(out).toContain('tls: false');
    expect(out).not.toContain('reality-opts');
  });

  it('security tls emits tls: true + servername but no reality-opts', () => {
    const out = buildClashYaml([{ ...xrayEp, securityLayer: 'tls' }]);
    expect(out).toContain('tls: true');
    expect(out).toContain('servername: www.cloudflare.com');
    expect(out).not.toContain('reality-opts');
  });

  // ───── Slice 24d: Shadowsocks ─────

  it('emits a shadowsocks (ss) proxy entry with cipher + password + udp', () => {
    const out = buildClashYaml([ssEp]);
    expect(out).toContain('- name: eu-1-shadowsocks');
    expect(out).toContain('type: ss');
    expect(out).toContain('server: n1.example.com');
    expect(out).toContain('port: 8388');
    expect(out).toContain('cipher: 2022-blake3-aes-256-gcm');
    expect(out).toContain('password: cabc78ae-94e3-4a16-936a-133d059acfac');
    expect(out).toContain('udp: true');
    // SS doesn't have TLS / REALITY blocks
    expect(out).not.toContain('tls: true');
    expect(out).not.toContain('reality-opts:');
  });

  it('mixed sub: ss alongside hysteria + vless lands in url-test group', () => {
    const out = buildClashYaml([hysteriaEp, xrayEp, ssEp]);
    expect(out).toMatch(/- eu-1-hysteria/);
    expect(out).toMatch(/- eu-1-xray/);
    expect(out).toMatch(/- eu-1-shadowsocks/);
  });

  // ───── Mieru (issue #29) ─────

  it('emits a mieru proxy entry with the TCP transport and user credentials', () => {
    const out = buildClashYaml([mieruEp]);
    expect(out).toContain('- name: eu-1-mieru');
    expect(out).toContain('type: mieru');
    expect(out).toContain('server: n1.example.com');
    expect(out).toContain('port: 2012');
    expect(out).toContain('transport: TCP');
    expect(out).toContain('username: alice');
    expect(out).toContain('password: cabc78ae-94e3-4a16-936a-133d059acfac');
    // mihomo has no key for either, so emitting them would be inventing config.
    expect(out).not.toContain('mtu');
    expect(out).not.toContain('multiplexing');
  });

  it('puts mieru in the proxy group instead of dropping the node silently', () => {
    // The gap this closes: a user whose only endpoint was mieru got a valid
    // profile with no proxies at all, and a MATCH,DIRECT catch-all, so their
    // traffic went straight out unproxied while the import looked successful.
    const out = buildClashYaml([mieruEp]);
    expect(out).toMatch(/proxies:\n {2}- name: eu-1-mieru/);
    expect(out).toContain('      - eu-1-mieru');
    expect(out.trimEnd().endsWith('- MATCH,Auto')).toBe(true);
  });

  // ───── Slice 24c part 2: transports ─────

  it('emits ws-opts with path + Host header for ws network', () => {
    const out = buildClashYaml([
      { ...xrayEp, network: 'ws' as const, path: '/api', hostHeader: 'cdn.example.com' },
    ]);
    expect(out).toContain('network: ws');
    expect(out).toContain('ws-opts:');
    expect(out).toContain('path: /api');
    expect(out).toContain('Host: cdn.example.com');
  });

  it('writes httpupgrade as ws with v2ray-http-upgrade, the only form mihomo knows (A-133)', () => {
    const out = buildClashYaml([
      { ...xrayEp, network: 'httpupgrade' as const, path: '/u', hostHeader: 'cdn.example.com' },
    ]);
    expect(out).toContain('network: ws');
    expect(out).not.toContain('network: httpupgrade');
    expect(out).not.toContain('httpupgrade-opts');
    expect(out).toContain('ws-opts:');
    expect(out).toContain('path: /u');
    expect(out).toContain('Host: cdn.example.com');
    expect(out).toContain('v2ray-http-upgrade: true');
  });

  it('carries a non-auto XHTTP mode, and no mode key for auto (A-133)', () => {
    const one = buildClashYaml([{ ...xrayEp, network: 'xhttp' as const, xhttpMode: 'stream-one' as const }]);
    expect(one).toContain('mode: stream-one');
    for (const mode of ['auto', undefined] as const) {
      const out = buildClashYaml([{ ...xrayEp, network: 'xhttp' as const, path: '/xh', xhttpMode: mode }]);
      expect(out, String(mode)).not.toMatch(/^\s+mode:/m);
    }
  });

  // A-133: a network mihomo does not know is read as TCP there, so it is left out.
  it('writes xhttp for vless with xhttp-opts, and leaves out what mihomo would dial as TCP', () => {
    const xhttp = buildClashYaml([{ ...xrayEp, network: 'xhttp' as const, path: '/xh', hostHeader: 'cdn.example.com' }]);
    expect(xhttp).toContain('network: xhttp');
    expect(xhttp).toContain('xhttp-opts:');
    expect(xhttp).toContain('path: /xh');
    expect(xhttp).toContain('host: cdn.example.com');

    const unspoken: SubscriptionEndpoint[] = [
      { ...xrayEp, nodeName: 'kcp-vless', network: 'kcp' as const },
      { ...xrayEp, nodeName: 'kcp-vmess', network: 'kcp' as const, subprotocol: 'vmess' as const },
      { ...xrayEp, nodeName: 'kcp-trojan', network: 'kcp' as const, subprotocol: 'trojan' as const },
      { ...xrayEp, nodeName: 'xhttp-vmess', network: 'xhttp' as const, subprotocol: 'vmess' as const },
      { ...xrayEp, nodeName: 'xhttp-trojan', network: 'xhttp' as const, subprotocol: 'trojan' as const },
    ];
    const out = buildClashYaml(unspoken);
    for (const e of unspoken) expect(out, e.nodeName).not.toContain(e.nodeName);
    expect(out).not.toContain('network: kcp');
  });

  it('emits grpc-opts with grpc-service-name for grpc network', () => {
    const out = buildClashYaml([
      { ...xrayEp, network: 'grpc' as const, serviceName: 'GunSvc' },
    ]);
    expect(out).toContain('network: grpc');
    expect(out).toContain('grpc-opts:');
    expect(out).toContain('grpc-service-name: GunSvc');
  });

  it('emits network: tcp on raw (Clash terminology)', () => {
    const out = buildClashYaml([xrayEp]); // network: 'raw'
    expect(out).toContain('network: tcp');
    expect(out).not.toContain('network: raw');
  });

  // ShadowTLS carries TCP, so mihomo's native UDP relay (`udp: true`) has no
  // port to reach: UDP needs UoT declared. Only mihomo is known to take the key
  // (stash and legacy clash do not get it).
  it('lets UDP through the shadowtls proxy on mihomo: udp-over-tcp, not just udp: true', () => {
    const out = buildClashYaml([shadowtlsEp]);
    expect(out).toContain('    udp: true');
    expect(out).toContain('    udp-over-tcp: true');
  });

  it('leaves udp-over-tcp out of the stash and legacy clash dialects', () => {
    for (const dialect of ['stash', 'clash-legacy'] as const) {
      expect(buildClashYaml([shadowtlsEp], { dialect }), dialect).not.toContain('udp-over-tcp');
    }
  });

  // ───── Routing Templates (R1c) ─────

  describe('routingPreset', () => {
    // Every resolver we hand out sees which names this person looks up; the
    // third-party one is Cloudflare, in all three presets (f12-19). The test
    // asserts an absence, so it carries its control: a preset with no DNS at
    // all would pass it, so the split presets must still carry a block, and
    // each its regional resolver.
    it.each(['proxy-all', 'ru-split', 'cn-split'] as const)(
      'names no Google resolver in the %s preset',
      (preset) => {
        const out = buildClashYaml([xrayEp], { routingPreset: preset });
        expect(out).not.toContain('8.8.8.8');
        expect(out).not.toContain('8.8.4.4');
        expect(out).not.toContain('dns.google');
        expect(out).toContain('    - https://1.0.0.1/dns-query');
        if (preset !== 'proxy-all') expect(out).toContain('nameserver:');
        if (preset === 'ru-split') expect(out).toContain('77.88.8.8');
        if (preset === 'cn-split') expect(out).toContain('223.5.5.5');
      },
    );

    it('a frame with its own dns is handed out without ours', () => {
      const frame = readFrame('mihomo', ['iceslab:', '  routing: preset', 'dns:', '  enable: true', '  nameserver:', '    - 9.9.9.9', 'proxies: []', 'rules:', '  - MATCH,DIRECT', ''].join('\n'));
      for (const preset of ['proxy-all', 'ru-split', 'cn-split'] as const) {
        const out = buildClashYaml([xrayEp], { frame, routingPreset: preset });
        expect(out).toContain('    - 9.9.9.9');
        expect(out).not.toContain('1.0.0.1');
        expect(out).not.toContain('1.1.1.1');
      }
    });

    it('proxy-all carries no routing rules and no geo databases', () => {
      expect(buildClashYaml([xrayEp], { routingPreset: 'proxy-all' })).toBe(
        buildClashYaml([xrayEp]),
      );
      const out = buildClashYaml([xrayEp]);
      expect(out).not.toContain('GEOSITE');
      // Nothing in this preset resolves a geo category, so fetching the
      // databases would be download for its own sake.
      expect(out).not.toContain('geox-url');
    });

    it('proxy-all emits a loop-safe DNS block so TUN clients can resolve', () => {
      // Without this the profile imports cleanly and then resolves nothing in
      // TUN mode, which users report as a broken client rather than a broken
      // config. See PROXY_ALL_DNS_LINES for why this replaced the old
      // byte-identical-to-pre-R1 guarantee.
      const out = buildClashYaml([xrayEp]);
      expect(out).toContain('dns:');
      expect(out).toContain('  enable: true');
      expect(out).toContain('  enhanced-mode: fake-ip');

      // The bootstrap resolvers must be plain IPs: they are what resolves the
      // DoH hostnames and the node's own address, neither of which can travel
      // through a tunnel that is not up yet.
      const bootstrap = out.slice(
        out.indexOf('  default-nameserver:'),
        out.indexOf('  nameserver:'),
      );
      expect(bootstrap).toContain('    - 1.1.1.1');
      expect(bootstrap).not.toContain('https://');
      expect(out).toContain('  proxy-server-nameserver:');

      // Everything else is DoH, so the queries this preset does make are not
      // readable by the local network.
      expect(out).toContain('    - https://1.1.1.1/dns-query');

      // No geo policy here: proxy-all has no domain that should stay local.
      expect(out).not.toContain('nameserver-policy');

      // DNS precedes the proxies, as in the split presets.
      expect(out.indexOf('dns:')).toBeLessThan(out.indexOf('proxies:'));
    });

    it('ru-split emits geo block with jsdelivr mirrors and auto-update', () => {
      const out = buildClashYaml([xrayEp], { routingPreset: 'ru-split' });
      expect(out).toContain('geo-auto-update: true');
      expect(out).toContain('geo-update-interval: 72');
      expect(out).toContain(
        'geosite: "https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite.dat"',
      );
      expect(out).toContain(
        'mmdb: "https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/country.mmdb"',
      );
    });

    it('ru-split rules: ads reject first, RU + private direct, MATCH,Auto last', () => {
      const out = buildClashYaml([xrayEp], { routingPreset: 'ru-split' });
      const rules = out
        .slice(out.indexOf('rules:'))
        .split('\n')
        .filter((l) => l.startsWith('  - '))
        .map((l) => l.trim());
      expect(rules[0]).toBe('- GEOSITE,category-ads-all,REJECT');
      expect(rules).toContain('- GEOSITE,category-ru,DIRECT');
      expect(rules).toContain('- GEOSITE,category-gov-ru,DIRECT');
      expect(rules).toContain('- IP-CIDR,10.0.0.0/8,DIRECT,no-resolve');
      expect(rules).toContain('- IP-CIDR6,fc00::/7,DIRECT,no-resolve');
      // GEOIP,RU resolves (no no-resolve) and sits right before the catch-all.
      expect(rules[rules.length - 2]).toBe('- GEOIP,RU,DIRECT');
      expect(rules[rules.length - 1]).toBe('- MATCH,Auto');
    });

    it('ru-split with no proxies keeps MATCH,DIRECT as the catch-all', () => {
      const out = buildClashYaml([], { routingPreset: 'ru-split' });
      expect(out).toContain('- GEOSITE,category-ads-all,REJECT');
      expect(out.trimEnd().endsWith('- MATCH,DIRECT')).toBe(true);
    });

    it('ru-split emits split-DNS block (R2) with the RU nameserver policy', () => {
      const out = buildClashYaml([xrayEp], { routingPreset: 'ru-split' });
      expect(out).toContain('dns:');
      expect(out).toContain('  enable: true');
      expect(out).toContain('  enhanced-mode: fake-ip');
      expect(out).toContain('  fake-ip-range: 198.18.0.1/16');
      // RU domains pinned to Yandex DNS via nameserver-policy.
      expect(out).toContain('    "geosite:category-ru": 77.88.8.8');
      expect(out).toContain('    "geosite:category-gov-ru": 77.88.8.8');
      // General resolvers are DoH; bootstrap nameservers are plain IPs.
      expect(out).toContain('    - https://1.1.1.1/dns-query');
      expect(out).toContain('  default-nameserver:');
      expect(out).toContain('  proxy-server-nameserver:');
      // DNS block sits before proxies, after the geo block.
      expect(out.indexOf('dns:')).toBeGreaterThan(out.indexOf('geox-url:'));
      expect(out.indexOf('dns:')).toBeLessThan(out.indexOf('proxies:'));
    });
  });

  // ───── Routing Templates (H2) - cn-split ─────

  describe('routingPreset cn-split', () => {
    function ruleLines(out: string): string[] {
      return out
        .slice(out.indexOf('rules:'))
        .split('\n')
        .filter((l) => l.startsWith('  - '))
        .map((l) => l.trim());
    }

    it('emits the shared geo block with jsdelivr mirrors and auto-update', () => {
      const out = buildClashYaml([xrayEp], { routingPreset: 'cn-split' });
      expect(out).toContain('geo-auto-update: true');
      expect(out).toContain('geo-update-interval: 72');
      expect(out).toContain(
        'geosite: "https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite.dat"',
      );
    });

    it('rules: ads reject first, one GEOSITE,cn + private direct, GEOIP,CN before catch-all', () => {
      const out = buildClashYaml([xrayEp], { routingPreset: 'cn-split' });
      const rules = ruleLines(out);
      expect(rules[0]).toBe('- GEOSITE,category-ads-all,REJECT');
      expect(rules).toContain('- GEOSITE,cn,DIRECT');
      expect(rules).toContain('- IP-CIDR,10.0.0.0/8,DIRECT,no-resolve');
      expect(rules).toContain('- IP-CIDR6,fc00::/7,DIRECT,no-resolve');
      // GEOIP,CN resolves (no no-resolve) and sits right before the catch-all.
      expect(rules[rules.length - 2]).toBe('- GEOIP,CN,DIRECT');
      expect(rules[rules.length - 1]).toBe('- MATCH,Auto');
      // No RU lines leak in.
      expect(out).not.toContain('GEOSITE,category-ru');
      expect(out).not.toContain('GEOIP,RU');
    });

    it('emits split-DNS block pinned to AliDNS via nameserver-policy', () => {
      const out = buildClashYaml([xrayEp], { routingPreset: 'cn-split' });
      expect(out).toContain('dns:');
      expect(out).toContain('  enhanced-mode: fake-ip');
      // China domains pinned to AliDNS.
      expect(out).toContain('    "geosite:cn": 223.5.5.5');
      expect(out).toContain('    - 223.5.5.5');
      // The DoH general resolvers stay identical to ru-split.
      expect(out).toContain('    - https://1.1.1.1/dns-query');
      // No Yandex resolver.
      expect(out).not.toContain('77.88.8.8');
    });
  });

  // ───── Byte-identity regression guards (H2) ─────

  describe('routingPreset byte-identity (H2 guard)', () => {
    it('proxy-all stays byte-identical to the default build', () => {
      expect(buildClashYaml([xrayEp], { routingPreset: 'proxy-all' })).toBe(
        buildClashYaml([xrayEp]),
      );
    });

    it('ru-split output differs from cn-split', () => {
      expect(buildClashYaml([xrayEp], { routingPreset: 'ru-split' })).not.toBe(
        buildClashYaml([xrayEp], { routingPreset: 'cn-split' }),
      );
    });
  });

  // R3 - operator custom domain lists.
  describe('customDomainLists (R3)', () => {
    function ruleLines(out: string): string[] {
      return out
        .slice(out.indexOf('rules:'))
        .split('\n')
        .filter((l) => l.startsWith('  - '))
        .map((l) => l.trim());
    }

    it('empty lists keep output byte-identical to no lists', () => {
      expect(
        buildClashYaml([xrayEp], { customDomainLists: { direct: [], proxy: [], block: [] } }),
      ).toBe(buildClashYaml([xrayEp]));
    });

    it('undefined lists keep output byte-identical', () => {
      expect(buildClashYaml([xrayEp], { customDomainLists: undefined })).toBe(
        buildClashYaml([xrayEp]),
      );
    });

    it('emits DOMAIN-SUFFIX rules ordered block (REJECT) -> direct (DIRECT) -> proxy (Auto)', () => {
      const out = buildClashYaml([xrayEp], {
        customDomainLists: {
          block: ['ads.example.com'],
          direct: ['example.ru'],
          proxy: ['youtube.com'],
        },
      });
      const rules = ruleLines(out);
      expect(rules[0]).toBe('- DOMAIN-SUFFIX,ads.example.com,REJECT');
      expect(rules[1]).toBe('- DOMAIN-SUFFIX,example.ru,DIRECT');
      expect(rules[2]).toBe('- DOMAIN-SUFFIX,youtube.com,Auto');
      // Catch-all stays last.
      expect(rules[rules.length - 1]).toBe('- MATCH,Auto');
    });

    it('maps xray matcher prefixes to the rule type each one means', () => {
      const out = buildClashYaml([xrayEp], {
        customDomainLists: {
          direct: ['domain:gosuslugi.ru', 'full:exact.ru', 'keyword:shop', 'regexp:.*\\.ru', 'plain.ru'],
          proxy: [],
          block: [],
        },
      });
      const rules = ruleLines(out);
      expect(rules).toContain('- DOMAIN-SUFFIX,gosuslugi.ru,DIRECT');
      expect(rules).toContain('- DOMAIN,exact.ru,DIRECT');
      expect(rules).toContain('- DOMAIN-KEYWORD,shop,DIRECT');
      expect(rules).toContain('- DOMAIN-REGEX,.*\\.ru,DIRECT');
      expect(rules).toContain('- DOMAIN-SUFFIX,plain.ru,DIRECT');
      expect(out).not.toContain('domain:gosuslugi.ru');
    });

    it('drops values with a comma, whitespace or a line break', () => {
      const out = buildClashYaml([xrayEp], {
        customDomainLists: {
          direct: ['good.ru', 'a.ru,b.ru', 'bad domain.ru', 'line\nbreak.ru', 'tab\t.ru', 'keyword:a b'],
          proxy: [],
          block: ['x.ru,REJECT'],
        },
      });
      const rules = ruleLines(out);
      expect(rules).toContain('- DOMAIN-SUFFIX,good.ru,DIRECT');
      expect(out).not.toMatch(/b\.ru|bad domain|break|tab|a b|x\.ru/);
      expect(rules.filter((r) => r.startsWith('- DOMAIN'))).toHaveLength(1);
    });

    it('drops the proxy bucket when no proxy exists (catch-all stays MATCH,DIRECT)', () => {
      const out = buildClashYaml([], {
        customDomainLists: { direct: ['example.ru'], proxy: ['youtube.com'], block: [] },
      });
      const rules = ruleLines(out);
      expect(rules).toContain('- DOMAIN-SUFFIX,example.ru,DIRECT');
      expect(out).not.toContain('youtube.com');
      expect(rules[rules.length - 1]).toBe('- MATCH,DIRECT');
    });

    it('custom-domain lines sit ahead of ru-split lines and before the catch-all', () => {
      const out = buildClashYaml([xrayEp], {
        routingPreset: 'ru-split',
        customDomainLists: { direct: ['example.ru'], proxy: [], block: [] },
      });
      const rules = ruleLines(out);
      // Custom domain line is first, ru-split block follows, MATCH,Auto last.
      expect(rules[0]).toBe('- DOMAIN-SUFFIX,example.ru,DIRECT');
      expect(rules).toContain('- GEOSITE,category-ads-all,REJECT');
      expect(rules[rules.length - 1]).toBe('- MATCH,Auto');
    });
  });
  // Milestone 10.5: the databases from the panel itself (GEO_SELF_HOST).
  describe('the panel serves the geo databases (GEO_SELF_HOST)', () => {
    const RU_TAGS = ['category-ads-all', 'category-ru', 'category-gov-ru', 'ru'];
    const geo = (over: Partial<SelfHostedGeo> = {}): SelfHostedGeo => ({
      baseUrl: 'https://panel.example.com/geo/tok',
      tags: { geosite: new Set(RU_TAGS), geoip: new Set(RU_TAGS) },
      srs: true,
      ...over,
    });
    const base = buildClashYaml([xrayEp], { routingPreset: 'ru-split' });

    it('no geo (the flag off): the output is the base, byte for byte', () => {
      expect(buildClashYaml([xrayEp], { routingPreset: 'ru-split', geo: null })).toBe(base);
      expect(buildClashYaml([xrayEp], { routingPreset: 'ru-split', geo: undefined })).toBe(base);
    });

    it('geox-url points at the panel, geodata-mode on, no country.mmdb, the rest unchanged', () => {
      const out = buildClashYaml([xrayEp], { routingPreset: 'ru-split', geo: geo() });
      expect(out).toContain('geodata-mode: true');
      expect(out).toContain('  geosite: "https://panel.example.com/geo/tok/geosite.dat"');
      expect(out).toContain('  geoip: "https://panel.example.com/geo/tok/geoip.dat"');
      expect(out).not.toContain('mmdb');
      expect(out).not.toContain('jsdelivr');
      // Only the geo block differs: the rules and the DNS are the base's.
      const strip = (t: string) => t.slice(t.indexOf('dns:'));
      expect(strip(out)).toBe(strip(base));
    });

    it('a tag the panel set lacks: the base addresses stay, whole', () => {
      const out = buildClashYaml([xrayEp], {
        routingPreset: 'ru-split',
        geo: geo({ tags: { geosite: new Set(RU_TAGS.filter((t) => t !== 'category-gov-ru')), geoip: new Set(RU_TAGS) } }),
      });
      expect(out).toBe(base);
    });

    it('a geoip tag the panel set lacks: the base addresses stay, whole', () => {
      expect(buildClashYaml([xrayEp], { routingPreset: 'ru-split', geo: geo({ tags: { geosite: new Set(RU_TAGS), geoip: new Set(['cn']) } }) })).toBe(base);
    });

    it('a set the panel does not serve: the base addresses stay', () => {
      expect(buildClashYaml([xrayEp], { routingPreset: 'ru-split', geo: geo({ tags: { geosite: new Set(RU_TAGS), geoip: null } }) })).toBe(base);
      expect(buildClashYaml([xrayEp], { routingPreset: 'ru-split', geo: geo({ tags: { geosite: null, geoip: null } }) })).toBe(base);
    });

    it('no sing-box on the panel does not matter to clash: the databases are .dat', () => {
      const out = buildClashYaml([xrayEp], { routingPreset: 'ru-split', geo: geo({ srs: false }) });
      expect(out).toContain('/geo/tok/geosite.dat');
    });

    it('a preset that names no geo database gets no geo block either way', () => {
      expect(buildClashYaml([xrayEp], { geo: geo() })).toBe(buildClashYaml([xrayEp]));
    });

    it('a template that sets geox-url itself is not touched', () => {
      const frame = readFrame('mihomo', 'geox-url:\n  geosite: "https://own.example/geosite.dat"\niceslab: {}\nproxies: []\nproxy-groups: []\nrules: []\n');
      const out = buildClashYaml([xrayEp], { routingPreset: 'ru-split', frame, geo: geo() });
      expect(out).toContain('https://own.example/geosite.dat');
      expect(out).not.toContain('panel.example.com');
    });
  });
});

// Stage 19.5: the DNS rules in nameserver-policy, through the target group.
describe('buildClashYaml DNS rules (stage 19.5)', () => {
  const rule = (server: string, ...match: string[]): DnsRule => ({ match, server, note: '' });
  const RULES = [rule('tcp://10.0.0.1', 'domain:corp.example', 'full:one.example', 'geosite:category-ads-all'), rule('10.0.0.2', 'bare.example')];
  type Dns = { dns: { 'nameserver-policy'?: Record<string, string>; nameserver: string[]; 'enhanced-mode': string } };
  const policy = (yaml: string) => (parseYaml(yaml) as Dns).dns['nameserver-policy'];
  const PRESETS = ['proxy-all', 'ru-split', 'cn-split'] as const;

  it.each(PRESETS)('%s: one entry per name, server by kind, the target group as suffix', (preset) => {
    const out = buildClashYaml([xrayEp], { routingPreset: preset, dnsRules: RULES });
    expect(policy(out)).toMatchObject({
      '+.corp.example': 'tcp://10.0.0.1#Auto',
      'one.example': 'tcp://10.0.0.1#Auto',
      'geosite:category-ads-all': 'tcp://10.0.0.1#Auto',
      '+.bare.example': '10.0.0.2#Auto',
    });
  });

  it('an own preset gets the section, which it had none of', () => {
    const own = [{ match: ['geosite:google'], action: 'direct', note: '' }] as const;
    expect(policy(buildClashYaml([xrayEp], { ownPresetRules: own }))).toBeUndefined();
    expect(policy(buildClashYaml([xrayEp], { ownPresetRules: own, dnsRules: RULES }))).toMatchObject({ '+.corp.example': 'tcp://10.0.0.1#Auto' });
  });

  it('proxy-all and own: the block is the old lines plus the section, nothing moved', () => {
    const plain = buildClashYaml([xrayEp], { routingPreset: 'proxy-all' });
    const out = buildClashYaml([xrayEp], { routingPreset: 'proxy-all', dnsRules: [rule('10.0.0.2', 'full:a.example')] });
    expect(out).toBe(plain.replace('    - https://1.0.0.1/dns-query\n', '    - https://1.0.0.1/dns-query\n  nameserver-policy:\n    "a.example": "10.0.0.2#Auto"\n'));
  });

  it('ru-split: the operator entries go with the built-in ones; the same name replaces the built-in', () => {
    const out = buildClashYaml([xrayEp], {
      routingPreset: 'ru-split',
      dnsRules: [rule('tcp://10.0.0.1', 'geosite:category-ru', 'domain:corp.example')],
    });
    const pol = policy(out)!;
    expect(pol).toEqual({
      'geosite:category-ru': 'tcp://10.0.0.1#Auto',
      '+.corp.example': 'tcp://10.0.0.1#Auto',
      'geosite:category-gov-ru': '77.88.8.8',
    });
    expect(out.match(/geosite:category-ru"/g)).toHaveLength(1);
    // Theirs first, the built-in left after.
    expect(Object.keys(pol)).toEqual(['geosite:category-ru', '+.corp.example', 'geosite:category-gov-ru']);
  });

  it('cn-split: an entry for another name leaves the built-in one', () => {
    expect(policy(buildClashYaml([xrayEp], { routingPreset: 'cn-split', dnsRules: [rule('10.0.0.2', 'full:a.example')] }))).toEqual({
      'a.example': '10.0.0.2#Auto',
      'geosite:cn': '223.5.5.5',
    });
  });

  it('the first rule wins for a name met twice', () => {
    const pol = policy(buildClashYaml([xrayEp], { dnsRules: [rule('10.0.0.1', 'domain:x.example'), rule('10.0.0.2', 'x.example')] }));
    expect(pol).toEqual({ '+.x.example': '10.0.0.1#Auto' });
  });

  it('a frame with its own dns is handed out without the entries', () => {
    const frame = readFrame('mihomo', ['iceslab:', '  routing: preset', 'dns:', '  enable: true', '  nameserver:', '    - 9.9.9.9', 'proxies: []', 'proxy-groups:', '  - name: G', '    type: select', 'rules:', '  - MATCH,DIRECT', ''].join('\n'));
    for (const preset of PRESETS) {
      const out = buildClashYaml([xrayEp], { frame, routingPreset: preset, dnsRules: RULES });
      expect(out).toBe(buildClashYaml([xrayEp], { frame, routingPreset: preset }));
      expect(out).not.toContain('nameserver-policy');
    }
  });

  it('a frame with no group that holds a node gets no entries', () => {
    const frame = readFrame('mihomo', ['iceslab:', '  routing: preset', 'proxies: []', 'proxy-groups:', '  - name: Empty', '    type: select', '    iceslab:', '      include-proxies: false', 'rules:', '  - MATCH,DIRECT', ''].join('\n'));
    for (const preset of PRESETS) {
      expect(buildClashYaml([xrayEp], { frame, routingPreset: preset, dnsRules: RULES })).toBe(buildClashYaml([xrayEp], { frame, routingPreset: preset }));
    }
    expect(buildClashYaml([], { dnsRules: RULES })).toBe(buildClashYaml([]));
  });

  it('the suffix names the first group with a node, and is left off a name that is not plain ASCII', () => {
    const framed = (name: string) =>
      readFrame('mihomo', ['iceslab:', '  routing: preset', 'proxies: []', 'proxy-groups:', `  - name: ${JSON.stringify(name)}`, '    type: select', 'rules:', '  - MATCH,DIRECT', ''].join('\n'));
    const one = [rule('tcp://10.0.0.1', 'full:a.example')];
    expect(policy(buildClashYaml([xrayEp], { frame: framed('my_group-2'), dnsRules: one }))).toEqual({ 'a.example': 'tcp://10.0.0.1#my_group-2' });
    for (const name of ['Моя группа', '🚀 Proxy', 'with space']) {
      expect(policy(buildClashYaml([xrayEp], { frame: framed(name), dnsRules: one }))).toEqual({ 'a.example': 'tcp://10.0.0.1' });
    }
  });

  it('no rules: the output is what it was', () => {
    for (const preset of PRESETS) {
      expect(buildClashYaml([xrayEp], { routingPreset: preset, dnsRules: [] })).toBe(buildClashYaml([xrayEp], { routingPreset: preset }));
    }
  });

  it('the output with rules is YAML and keeps fake-ip', () => {
    const doc = parseYaml(buildClashYaml([xrayEp, hysteriaEp], { routingPreset: 'ru-split', dnsRules: RULES })) as Dns;
    expect(doc.dns['enhanced-mode']).toBe('fake-ip');
    expect(doc.dns.nameserver).toEqual(['https://1.1.1.1/dns-query', 'https://1.0.0.1/dns-query']);
  });

  describe('iceslab: { dns: merge } (19.8)', () => {
    const tpl = (dns: string[], mark = 'dns: merge') =>
      readFrame('mihomo', ['iceslab:', '  routing: preset', ...(mark ? [`  ${mark}`] : []), ...dns, 'proxies: []', 'proxy-groups:', '  - name: G', '    type: select', 'rules:', '  - MATCH,DIRECT', ''].join('\n'));
    const OWN_DNS = ['dns:', '  enable: true', '  nameserver:', '    - 9.9.9.9', '  nameserver-policy:', '    "+.own.example": 9.9.9.9', '    "+.CORP.example": 8.8.8.8'];
    type Doc = { dns: { enable: boolean; nameserver: string[]; 'nameserver-policy'?: Record<string, unknown> }; rules: string[] };
    const doc = (y: string) => parseYaml(y) as Doc;

    it('the entries join the template\'s nameserver-policy, theirs first; the same name is the operator\'s; the rest of dns stays', () => {
      const out = buildClashYaml([xrayEp], { frame: tpl(OWN_DNS), dnsRules: RULES });
      const d = doc(out).dns;
      expect(d.enable).toBe(true);
      expect(d.nameserver).toEqual(['9.9.9.9']);
      expect(d['nameserver-policy']).toEqual({
        '+.corp.example': 'tcp://10.0.0.1#G',
        'one.example': 'tcp://10.0.0.1#G',
        'geosite:category-ads-all': 'tcp://10.0.0.1#G',
        '+.bare.example': '10.0.0.2#G',
        '+.own.example': '9.9.9.9',
      });
      expect(Object.keys(d['nameserver-policy']!).at(-1)).toBe('+.own.example');
      expect(out).not.toContain('iceslab');
    });

    it('a template with a dns and no policy: the section is made; a value that is a list stays', () => {
      const d = doc(buildClashYaml([xrayEp], { frame: tpl(['dns:', '  enable: true']), dnsRules: RULES })).dns;
      expect(d.enable).toBe(true);
      expect(Object.keys(d['nameserver-policy']!)).toHaveLength(4);
      const listed = doc(buildClashYaml([xrayEp], { frame: tpl(['dns:', '  nameserver-policy:', '    "+.x.example": [1.1.1.1, 8.8.8.8]']), dnsRules: RULES })).dns;
      expect(listed['nameserver-policy']!['+.x.example']).toEqual(['1.1.1.1', '8.8.8.8']);
      expect(listed['nameserver-policy']!['one.example']).toBe('tcp://10.0.0.1#G');
    });

    it('without the mark the output does not change, whatever the rules are', () => {
      const frame = tpl(OWN_DNS, '');
      expect(buildClashYaml([xrayEp], { frame, dnsRules: RULES })).toBe(buildClashYaml([xrayEp], { frame }));
    });

    it('a dns that is not a map, or a policy that is not a map: as written', () => {
      for (const dns of [['dns: off'], ['dns:', '  - a'], ['dns:', '  nameserver-policy:', '    - a'], ['dns:', '  nameserver-policy: none']]) {
        const frame = tpl(dns);
        const unmarked = tpl(dns, '');
        expect(buildClashYaml([xrayEp], { frame, dnsRules: RULES }), dns.join('|')).toBe(buildClashYaml([xrayEp], { frame: unmarked, dnsRules: RULES }));
      }
    });

    it('no rules, no group with a node, no dns of its own: as written', () => {
      const frame = tpl(OWN_DNS);
      const unmarked = tpl(OWN_DNS, '');
      expect(buildClashYaml([xrayEp], { frame, dnsRules: [] })).toBe(buildClashYaml([xrayEp], { frame: unmarked }));
      expect(buildClashYaml([], { frame, dnsRules: RULES })).toBe(buildClashYaml([], { frame: unmarked }));
      const none = readFrame('mihomo', ['iceslab:', '  routing: preset', '  dns: merge', 'proxies: []', 'proxy-groups:', '  - name: G', '    type: select', 'rules:', '  - MATCH,DIRECT', ''].join('\n'));
      // The mark with no dns of the template's own is the ordinary path: the panel's block gets the entries.
      const unmarkedNone = readFrame('mihomo', ['iceslab:', '  routing: preset', 'proxies: []', 'proxy-groups:', '  - name: G', '    type: select', 'rules:', '  - MATCH,DIRECT', ''].join('\n'));
      expect(buildClashYaml([xrayEp], { frame: none, dnsRules: RULES })).toBe(buildClashYaml([xrayEp], { frame: unmarkedNone, dnsRules: RULES }));
    });

    it('the mark without `routing: preset` does nothing', () => {
      const frame = readFrame('mihomo', ['iceslab:', '  dns: merge', ...OWN_DNS, 'proxies: []', 'proxy-groups:', '  - name: G', '    type: select', 'rules:', '  - MATCH,DIRECT', ''].join('\n'));
      expect(buildClashYaml([xrayEp], { frame, dnsRules: RULES })).not.toContain('one.example');
    });
  });
});

describe('buildClashYaml IPv6 server', () => {
  it('quotes an IPv6 literal and the document parses to the bare address', async () => {
    const { parse } = await import('yaml');
    const out = buildClashYaml([{ ...hysteriaEp, host: '2001:db8::1' }, { ...ssEp, host: '2001:db8::1' }, { ...xrayEp, host: '2001:db8::1' }]);
    expect(out).toContain('server: "2001:db8::1"');
    const doc = parse(out) as { proxies: { server: string }[] };
    expect(doc.proxies.map((p) => p.server)).toEqual(['2001:db8::1', '2001:db8::1', '2001:db8::1']);
  });
  it('leaves a name unquoted as before', () => {
    expect(buildClashYaml([hysteriaEp])).toContain('server: n1.example.com\n');
  });
});
