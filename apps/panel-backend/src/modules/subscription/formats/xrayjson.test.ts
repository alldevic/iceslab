import { describe, expect, it } from 'vitest';
import { buildXrayJson, buildXrayJsonArray, withVlessRouteTag } from './xrayjson.js';
import type { SubscriptionEndpoint } from '../subscription.formats.js';
// An outbound tag is the endpoint's identity, not its name, so the expected
// value is asked of the same function the formatter asks. Spelling the tag out
// as a literal is what these assertions used to do, and it is exactly how a tag
// silently became a display string.
import { endpointTag } from '../endpoint-identity.js';
import { expandCascadeEntry } from '../cascade-entries.js';
import { readFrame } from '../subscription.frames.js';
import type { PresetGeoInline } from '../../geo-sets/geo-preset-inline.js';
import type { DeviceRouteRule } from '../../routing-presets/routing-presets.builtins.js';

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
  uri: 'vless://...',
};

const xrayEp2: SubscriptionEndpoint = {
  ...xrayEp,
  nodeName: 'us-2',
  host: 'n2.example.com',
  uri: 'vless://...2',
};

const hy2Ep: SubscriptionEndpoint = {
  protocol: 'hysteria',
  nodeName: 'hy-de',
  host: 'hy.example.com',
  port: 443,
  password: 'hy-secret',
  obfsPassword: 'salt',
  upMbps: 100,
  downMbps: 300,
  uri: 'hysteria2://...',
};

// A protocol the array does NOT emit (not xray, not hysteria), to prove the
// filter still skips everything else.
const naiveEp: SubscriptionEndpoint = {
  protocol: 'naive',
  nodeName: 'nv-1',
  host: 'nv.example.com',
  port: 443,
  username: 'u',
  password: 'p',
  uri: 'naive+https://...',
};

const hysteriaEp: SubscriptionEndpoint = {
  protocol: 'hysteria',
  nodeName: 'eu-1',
  host: 'n1.example.com',
  port: 443,
  password: 'hy',
  uri: 'hysteria2://...',
};

/**
 * The xray config as these tests READ it.
 *
 * Only what the assertions touch, named once instead of `any` forty-four times.
 * The repetition was the problem: each `as any` is an admission that nothing is
 * checked, and forty-four of them meant a renamed key (`vnexr`, `realitySetings`)
 * read as undefined and failed somewhere unrelated, or quietly passed a
 * `toBeUndefined`.
 *
 * NOT a description of xray's schema, which is enormous: a description of what
 * OUR builder emits. Every `?` below says "this outbound does not carry that".
 */
interface XrayUser {
  id?: string;
  encryption?: string;
  flow?: string;
  security?: string;
  alterId?: number;
}

interface XrayOutbound {
  tag?: string;
  protocol?: string;
  settings?: {
    vnext?: { address: string; port: number; users: XrayUser[] }[];
    servers?: Record<string, unknown>[];
    fragment?: Record<string, unknown>;
  };
  streamSettings?: {
    network?: string;
    security?: string;
    realitySettings?: Record<string, unknown>;
    tlsSettings?: Record<string, unknown>;
    xhttpSettings?: Record<string, unknown>;
    hysteriaSettings?: Record<string, unknown>;
    sockopt?: Record<string, unknown>;
  };
  proxySettings?: Record<string, unknown>;
  mux?: Record<string, unknown>;
}

interface XrayConfig {
  remarks?: string;
  log?: Record<string, unknown>;
  inbounds: {
    protocol: string;
    port: number;
    listen: string;
    settings: { udp?: boolean };
  }[];
  outbounds: XrayOutbound[];
  routing: {
    domainStrategy?: string;
    rules: Record<string, unknown>[];
    balancers?: Record<string, unknown>[];
  };
  observatory?: Record<string, unknown>;
}

function parse(out: string): XrayConfig {
  return JSON.parse(out) as XrayConfig;
}

/** The array format: the same config per server, each carrying the label the
 *  client shows in its list. Its own helper because the single format has no
 *  `remarks` and reading one off it should not compile. */
interface XrayConfigEntry extends XrayConfig {
  remarks?: string;
}

function parseArray(out: string): XrayConfigEntry[] {
  return JSON.parse(out) as XrayConfigEntry[];
}

describe('split DNS names no Google resolver, asks the far one over DoH (f12-18, f12-19)', () => {
  it.each(['ru-split', 'cn-split'] as const)('%s', (preset) => {
    const out = buildXrayJson([xrayEp], { routingPreset: preset });
    const dns = JSON.parse(out).dns;
    const text = JSON.stringify(dns);
    expect(text).not.toContain('8.8.8.8');
    expect(text).not.toContain('8.8.4.4');
    expect(text).not.toContain('dns.google');
    // Controls: an absence passes on an empty block, so the regional resolver
    // must still be there, plain by address and reached direct; the far one is
    // DoH so the tunnel-side resolver does not rely on the client relaying UDP.
    expect(dns.servers[0]).toMatchObject({ address: preset === 'ru-split' ? '77.88.8.8' : '223.5.5.5' });
    expect(dns.servers[dns.servers.length - 1]).toBe('https://1.1.1.1/dns-query');
  });
});

// A-236: the operator's frame with a `dns` of its own, and its own domainStrategy,
// are handed out as written.
describe('an operator frame keeps its own dns and domainStrategy (f12-17, f12-19)', () => {
  const own = {
    iceslab: { routing: 'preset' },
    dns: { servers: ['9.9.9.9'] },
    outbounds: [{ tag: 'direct', protocol: 'freedom' }],
    routing: { domainStrategy: 'IPIfNonMatch', rules: [] },
  };
  it('flat: the frame dns is untouched, no queryStrategy is added, its domainStrategy stands', () => {
    const frame = readFrame('xray-json', JSON.stringify(own));
    const cfg = parse(buildXrayJson([xrayEp], { frame, routingPreset: 'ru-split' }));
    expect(cfg.dns).toEqual({ servers: ['9.9.9.9'] });
    expect(cfg.routing.domainStrategy).toBe('IPIfNonMatch');
  });
  it('array: the same per element', () => {
    const frame = readFrame('xray-json-array', JSON.stringify(own));
    for (const cfg of JSON.parse(buildXrayJsonArray([xrayEp, xrayEp2], { frame, routingPreset: 'ru-split' }))) {
      expect(cfg.dns).toEqual({ servers: ['9.9.9.9'] });
      expect(cfg.routing.domainStrategy).toBe('IPIfNonMatch');
    }
  });
  it('a frame without its own domainStrategy gets IPOnDemand under a split preset, AsIs under proxy-all', () => {
    const frame = readFrame('xray-json', JSON.stringify({ ...own, dns: undefined, routing: { rules: [] } }));
    expect(parse(buildXrayJson([xrayEp], { frame, routingPreset: 'ru-split' })).routing.domainStrategy).toBe('IPOnDemand');
    expect(parse(buildXrayJson([xrayEp], { frame, routingPreset: 'proxy-all' })).routing.domainStrategy).toBe('AsIs');
  });
});

// The single-config document had no `remarks`, so every client that imports it
// as one entry showed it nameless (v2rayNG takes the entry name from this field).
// The router form stays without it: XKeen consumes this as confdir fragments,
// where a stray top-level key is noise, not a name.
describe('the single-config document names itself', () => {
  it('carries remarks as its first key when the caller supplies one', () => {
    const cfg = JSON.parse(buildXrayJson([xrayEp], { remarks: 'OneginVPN' }));
    expect(cfg.remarks).toBe('OneginVPN');
    expect(Object.keys(cfg)[0]).toBe('remarks');
  });

  it('CONTROL: without one the document is byte-identical', () => {
    expect(buildXrayJson([xrayEp], { remarks: undefined })).toBe(buildXrayJson([xrayEp]));
    expect(JSON.parse(buildXrayJson([xrayEp])).remarks).toBeUndefined();
  });

  it('CONTROL: the router form stays nameless', () => {
    const cfg = JSON.parse(buildXrayJson([xrayEp], { forRouter: true, remarks: 'OneginVPN' }));
    expect(cfg.remarks).toBeUndefined();
    expect(cfg.inbounds).toBeUndefined();
  });

  it('the operator frame\'s own remarks wins over the computed name', () => {
    const frame = readFrame('xray-json', JSON.stringify({
      iceslab: { routing: 'preset' },
      remarks: 'Mine',
      outbounds: [{ tag: 'direct', protocol: 'freedom' }],
      routing: { rules: [] },
    }));
    expect(parse(buildXrayJson([xrayEp], { frame, remarks: 'OneginVPN' })).remarks).toBe('Mine');
  });

  it('the array is unchanged: each element keeps its own server name', () => {
    const a = buildXrayJsonArray([xrayEp, xrayEp2], {});
    expect(buildXrayJsonArray([xrayEp, xrayEp2], { remarks: 'OneginVPN' } as never)).toBe(a);
  });
});

describe('buildXrayJson', () => {
  it('produces valid JSON with trailing newline', () => {
    const out = buildXrayJson([xrayEp]);
    expect(out.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('emits a SOCKS5 inbound on 127.0.0.1:10808 with udp enabled', () => {
    const cfg = parse(buildXrayJson([xrayEp]));
    const socks = cfg.inbounds.find((i) => i.protocol === 'socks');
    expect(socks.port).toBe(10808);
    expect(socks.listen).toBe('127.0.0.1');
    expect(socks.settings.udp).toBe(true);
  });

  // Happ in system-proxy mode takes its port from an `http` inbound; with SOCKS
  // alone it binds nothing and the browser answers ERR_PROXY_CONNECTION_FAILED.
  it('emits an HTTP inbound on 127.0.0.1:10809 beside the SOCKS one (f12-22)', () => {
    const wants = (cfg: { inbounds: { protocol: string }[] }) => {
      expect(cfg.inbounds.map((i) => i.protocol)).toEqual(['socks', 'http']);
      const http = cfg.inbounds.find((i) => i.protocol === 'http');
      expect(http).toMatchObject({ tag: 'http-in', port: 10809, listen: '127.0.0.1' });
    };
    wants(parse(buildXrayJson([xrayEp])));
    for (const cfg of JSON.parse(buildXrayJsonArray([xrayEp, xrayEp2]))) wants(cfg);
  });

  it('the router variant still binds no inbound at all (f12-22)', () => {
    expect(parse(buildXrayJson([xrayEp], { forRouter: true })).inbounds).toBeUndefined();
    expect(parse(buildXrayJson([xrayEp], { forRouter: true, routingPreset: 'ru-split' })).inbounds).toBeUndefined();
  });

  it('emits a vless+REALITY outbound with v24.9.30 raw network', () => {
    const cfg = parse(buildXrayJson([xrayEp]));
    const v = cfg.outbounds.find((o) => o.protocol === 'vless');
    expect(v.tag).toBe(endpointTag(xrayEp));
    const user = v.settings.vnext[0].users[0];
    expect(user.id).toBe('11111111-2222-3333-4444-555555555555');
    expect(user.flow).toBe('xtls-rprx-vision');
    expect(user.encryption).toBe('none');
    expect(v.streamSettings.network).toBe('raw');
    expect(v.streamSettings.security).toBe('reality');
    expect(v.streamSettings.realitySettings.publicKey).toBe('pubkey-base64url');
    expect(v.streamSettings.realitySettings.shortId).toBe('abc123');
    expect(v.streamSettings.realitySettings.serverName).toBe('www.cloudflare.com');
    expect(v.streamSettings.realitySettings.fingerprint).toBe('chrome');
  });

  it('emits a vmess outbound (security auto, alterId 0) with no reality', () => {
    const cfg = parse(
      buildXrayJson([
        { ...xrayEp, subprotocol: 'vmess', securityLayer: 'none', network: 'ws', flow: undefined },
      ]),
    );
    const v = cfg.outbounds.find((o) => o.protocol === 'vmess');
    expect(v).toBeDefined();
    const user = v.settings.vnext[0].users[0];
    expect(user.id).toBe('11111111-2222-3333-4444-555555555555');
    expect(user.security).toBe('auto');
    expect(user.alterId).toBe(0);
    expect(v.streamSettings.security).toBe('none');
    expect(v.streamSettings.realitySettings).toBeUndefined();
  });

  it('emits a trojan outbound (servers/password), not a vless one', () => {
    const cfg = parse(buildXrayJson([{ ...xrayEp, subprotocol: 'trojan' }]));
    const t = cfg.outbounds.find((o) => o.protocol === 'trojan');
    expect(t).toBeDefined();
    expect(t.settings.servers[0].password).toBe('11111111-2222-3333-4444-555555555555');
    expect(cfg.outbounds.find((o) => o.protocol === 'vless')).toBeUndefined();
  });

  it('security tls emits tlsSettings, not realitySettings', () => {
    const cfg = parse(buildXrayJson([{ ...xrayEp, securityLayer: 'tls' }]));
    const v = cfg.outbounds.find((o) => o.protocol === 'vless');
    expect(v.streamSettings.security).toBe('tls');
    expect(v.streamSettings.tlsSettings.serverName).toBe('www.cloudflare.com');
    expect(v.streamSettings.realitySettings).toBeUndefined();
  });

  it('always includes freedom (direct) and blackhole (block) outbounds', () => {
    const cfg = parse(buildXrayJson([xrayEp]));
    expect(cfg.outbounds.find((o) => o.protocol === 'freedom')).toBeDefined();
    expect(cfg.outbounds.find((o) => o.protocol === 'blackhole')).toBeDefined();
  });

  it('sets a catch-all route to the first proxy when xray endpoints exist', () => {
    const second: SubscriptionEndpoint = { ...xrayEp, nodeName: 'us-1' };
    const cfg = parse(buildXrayJson([xrayEp, second]));
    expect(cfg.routing.rules[0].outboundTag).toBe(endpointTag(xrayEp));
    expect(cfg.routing.rules[0].network).toBe('tcp,udp');
  });

  it('falls back to routing through direct when no xray endpoint is present', () => {
    const cfg = parse(buildXrayJson([hysteriaEp]));
    expect(cfg.routing.rules[0].outboundTag).toBe('direct');
    // No vless outbound emitted.
    expect(cfg.outbounds.find((o) => o.protocol === 'vless')).toBeUndefined();
  });

  it('skips non-xray endpoints silently', () => {
    const out = buildXrayJson([hysteriaEp, xrayEp]);
    expect(out).not.toContain('hy-secret');
    expect(out).not.toContain('hysteria2');
    expect(out).toContain(endpointTag(xrayEp));
  });

  it('output is byte-deterministic for the same input', () => {
    expect(buildXrayJson([xrayEp])).toBe(buildXrayJson([xrayEp]));
  });

  // Routing Templates (R1a).
  describe('routingPreset', () => {
    it('default proxy-all output is byte-identical to pre-R1 (no preset rules, AsIs)', () => {
      expect(buildXrayJson([xrayEp], { routingPreset: 'proxy-all' })).toBe(
        buildXrayJson([xrayEp]),
      );
      const cfg = parse(buildXrayJson([xrayEp]));
      expect(cfg.routing.domainStrategy).toBe('AsIs');
      expect(cfg.routing.rules).toHaveLength(1);
      expect(JSON.stringify(cfg.routing.rules)).not.toContain('geosite');
    });

    it('ru-split prepends block/direct rules ahead of the catch-all', () => {
      const cfg = parse(buildXrayJson([xrayEp], { routingPreset: 'ru-split' }));
      const rules = cfg.routing.rules;
      expect(rules).toHaveLength(4);
      expect(rules[0].domain).toEqual(['geosite:category-ads-all']);
      expect(rules[0].outboundTag).toBe('block');
      expect(rules[1].domain).toEqual([
        'geosite:category-ru',
        'geosite:category-gov-ru',
      ]);
      expect(rules[1].outboundTag).toBe('direct');
      expect(rules[2].ip).toEqual(['geoip:private', 'geoip:ru']);
      expect(rules[2].outboundTag).toBe('direct');
      // Catch-all stays last so unmatched traffic still tunnels.
      expect(rules[3].network).toBe('tcp,udp');
      expect(rules[3].outboundTag).toBe(endpointTag(xrayEp));
    });

    it('ru-split switches domainStrategy to IPOnDemand', () => {
      const cfg = parse(buildXrayJson([xrayEp], { routingPreset: 'ru-split' }));
      expect(cfg.routing.domainStrategy).toBe('IPOnDemand');
    });

    it('proxy-all emits no dns block; ru-split adds split DNS (R2)', () => {
      const plain = parse(buildXrayJson([xrayEp]));
      expect(plain.dns).toBeUndefined();

      const cfg = parse(buildXrayJson([xrayEp], { routingPreset: 'ru-split' }));
      expect(cfg.dns.servers).toHaveLength(2);
      // RU resolver first: object form, scoped to RU geosites, no fallback.
      expect(cfg.dns.servers[0]).toEqual({
        address: '77.88.8.8',
        domains: ['geosite:category-ru', 'geosite:category-gov-ru'],
        skipFallback: true,
      });
      // General resolver second: Cloudflare over DoH by IP literal (no bootstrap).
      expect(cfg.dns.servers[1]).toBe('https://1.1.1.1/dns-query');
    });

    it('ru-split composes with bundle=balancer (preset rules first, balancer catch-all last)', () => {
      const second: SubscriptionEndpoint = { ...xrayEp, nodeName: 'us-1' };
      const cfg = parse(
        buildXrayJson([xrayEp, second], {
          bundle: 'balancer',
          routingPreset: 'ru-split',
        }),
      );
      const rules = cfg.routing.rules;
      expect(rules).toHaveLength(4);
      expect(rules[3].balancerTag).toBe('balancer-auto');
      expect(cfg.observatory).toBeDefined();
    });
  });

  // Routing Templates (H2) - cn-split, the China-direct mirror of ru-split.
  describe('routingPreset cn-split', () => {
    it('prepends block/direct rules (one CN domain category) ahead of the catch-all', () => {
      const cfg = parse(buildXrayJson([xrayEp], { routingPreset: 'cn-split' }));
      const rules = cfg.routing.rules;
      expect(rules).toHaveLength(4);
      expect(rules[0].domain).toEqual(['geosite:category-ads-all']);
      expect(rules[0].outboundTag).toBe('block');
      // China is one comprehensive category, so a single domain rule (not two).
      expect(rules[1].domain).toEqual(['geosite:cn']);
      expect(rules[1].outboundTag).toBe('direct');
      expect(rules[2].ip).toEqual(['geoip:private', 'geoip:cn']);
      expect(rules[2].outboundTag).toBe('direct');
      // Catch-all stays last so unmatched traffic still tunnels.
      expect(rules[3].network).toBe('tcp,udp');
      expect(rules[3].outboundTag).toBe(endpointTag(xrayEp));
    });

    it('switches domainStrategy to IPOnDemand', () => {
      const cfg = parse(buildXrayJson([xrayEp], { routingPreset: 'cn-split' }));
      expect(cfg.routing.domainStrategy).toBe('IPOnDemand');
    });

    it('adds AliDNS split DNS (223.5.5.5 scoped to geosite:cn, no fallback)', () => {
      const cfg = parse(buildXrayJson([xrayEp], { routingPreset: 'cn-split' }));
      expect(cfg.dns.servers).toHaveLength(2);
      expect(cfg.dns.servers[0]).toEqual({
        address: '223.5.5.5',
        domains: ['geosite:cn'],
        skipFallback: true,
      });
      expect(cfg.dns.servers[1]).toBe('https://1.1.1.1/dns-query');
    });

    it('does not leak RU categories or the Yandex resolver', () => {
      const out = buildXrayJson([xrayEp], { routingPreset: 'cn-split' });
      expect(out).not.toContain('category-ru');
      expect(out).not.toContain('geoip:ru');
      expect(out).not.toContain('77.88.8.8');
    });
  });

  // Byte-identity regression guards: adding cn-split must not perturb the
  // existing presets.
  describe('routingPreset byte-identity (H2 guard)', () => {
    it('proxy-all stays byte-identical to the default build', () => {
      expect(buildXrayJson([xrayEp], { routingPreset: 'proxy-all' })).toBe(
        buildXrayJson([xrayEp]),
      );
    });

    it('ru-split output is independent of cn-split (different bytes)', () => {
      expect(buildXrayJson([xrayEp], { routingPreset: 'ru-split' })).not.toBe(
        buildXrayJson([xrayEp], { routingPreset: 'cn-split' }),
      );
    });
  });

  // TLS-fragment.
  describe('tlsFragment', () => {
    it('OFF (default / explicit false) is byte-identical to current output', () => {
      expect(buildXrayJson([xrayEp], { tlsFragment: false })).toBe(
        buildXrayJson([xrayEp]),
      );
      const cfg = parse(buildXrayJson([xrayEp]));
      // No fragment outbound, no dialerProxy on the proxy outbound.
      expect(cfg.outbounds.find((o) => o.tag === 'fragment')).toBeUndefined();
      const v = cfg.outbounds.find((o) => o.protocol === 'vless');
      expect(v.streamSettings.sockopt).toBeUndefined();
    });

    it('ON emits a freedom outbound tagged "fragment" with the fragment object', () => {
      const cfg = parse(buildXrayJson([xrayEp], { tlsFragment: true }));
      const frag = cfg.outbounds.find((o) => o.tag === 'fragment');
      expect(frag).toBeDefined();
      expect(frag.protocol).toBe('freedom');
      expect(frag.settings.fragment).toEqual({
        packets: 'tlshello',
        length: '100-200',
        interval: '10-20',
      });
    });

    it('ON sets sockopt.dialerProxy="fragment" on the proxy outbound (existing stream fields preserved)', () => {
      const cfg = parse(buildXrayJson([xrayEp], { tlsFragment: true }));
      const v = cfg.outbounds.find((o) => o.protocol === 'vless');
      expect(v.streamSettings.sockopt.dialerProxy).toBe('fragment');
      // The REALITY stream settings are untouched.
      expect(v.streamSettings.security).toBe('reality');
      expect(v.streamSettings.realitySettings.serverName).toBe('www.cloudflare.com');
      // The fragment outbound itself carries no dialerProxy (it IS the dialer).
      const frag = cfg.outbounds.find((o) => o.tag === 'fragment');
      expect(frag.streamSettings).toBeUndefined();
    });

    it('ON does NOT touch the direct/block outbounds', () => {
      const cfg = parse(buildXrayJson([xrayEp], { tlsFragment: true }));
      const direct = cfg.outbounds.find((o) => o.tag === 'direct');
      const block = cfg.outbounds.find((o) => o.tag === 'block');
      expect(direct.streamSettings).toBeUndefined();
      expect(block.streamSettings).toBeUndefined();
    });

    it('a node named "fragment" does not collide: the proxy tag is not a name at all', () => {
      const named: SubscriptionEndpoint = { ...xrayEp, nodeName: 'fragment' };
      const cfg = parse(buildXrayJson([named], { tlsFragment: true }));
      const v = cfg.outbounds.find((o) => o.protocol === 'vless');
      expect(v.tag).toBe(endpointTag(named));
      // No proxy tag equals "fragment", so the dialer keeps the canonical tag.
      expect(v.streamSettings.sockopt.dialerProxy).toBe('fragment');
      const frag = cfg.outbounds.find((o) => o.tag === 'fragment');
      expect(frag).toBeDefined();
      expect(frag.protocol).toBe('freedom');
      // Every outbound tag stays unique.
      const tags = cfg.outbounds.map((o) => o.tag);
      expect(new Set(tags).size).toBe(tags.length);
    });

    it('no xray endpoints: nothing fragment-related is emitted', () => {
      const cfg = parse(buildXrayJson([hysteriaEp], { tlsFragment: true }));
      expect(cfg.outbounds.find((o) => o.tag === 'fragment')).toBeUndefined();
    });

    it('composes with the ru-split routing preset (fragment outbound + split rules, unique tags)', () => {
      const cfg = parse(
        buildXrayJson([xrayEp], { tlsFragment: true, routingPreset: 'ru-split' }),
      );
      // Fragment outbound present + proxy dials through it.
      const frag = cfg.outbounds.find((o) => o.tag === 'fragment');
      expect(frag).toBeDefined();
      const v = cfg.outbounds.find((o) => o.protocol === 'vless');
      expect(v.streamSettings.sockopt.dialerProxy).toBe('fragment');
      // ru-split rules + split DNS still present.
      expect(cfg.routing.domainStrategy).toBe('IPOnDemand');
      expect(cfg.routing.rules[0].outboundTag).toBe('block');
      expect(cfg.dns.servers).toHaveLength(2);
      // Every outbound tag is unique.
      const tags = cfg.outbounds.map((o) => o.tag);
      expect(new Set(tags).size).toBe(tags.length);
    });
  });

  // XKeen / router target (?format=xkeen).
  describe('forRouter (xkeen)', () => {
    it('omits log and the client inbound, keeps outbounds + routing', () => {
      const cfg = parse(buildXrayJson([xrayEp], { forRouter: true }));
      expect(cfg.log).toBeUndefined();
      expect(cfg.inbounds).toBeUndefined();
      // proxy + freedom + blackhole still present for routing rules to reference.
      expect(cfg.outbounds.find((o) => o.protocol === 'vless')).toBeDefined();
      expect(cfg.outbounds.find((o) => o.protocol === 'freedom')).toBeDefined();
      expect(cfg.outbounds.find((o) => o.protocol === 'blackhole')).toBeDefined();
      expect(cfg.routing.rules[0].outboundTag).toBe(endpointTag(xrayEp));
    });

    it('still emits split-DNS + ru-split rules when the preset is ru-split', () => {
      const cfg = parse(buildXrayJson([xrayEp], { forRouter: true, routingPreset: 'ru-split' }));
      expect(cfg.inbounds).toBeUndefined();
      expect(cfg.dns.servers).toHaveLength(2);
      expect(cfg.routing.rules[0].outboundTag).toBe('block');
    });

    it('desktop (client) form is unchanged: keeps log + inbound', () => {
      const cfg = parse(buildXrayJson([xrayEp]));
      expect(cfg.log).toBeDefined();
      expect(cfg.inbounds).toHaveLength(2);
    });
  });

  // R3-b - raw custom routing rules.
  describe('customRules (R3-b)', () => {
    it('prepends custom rules ahead of preset rules and the catch-all', () => {
      const custom = [{ type: 'field', domain: ['my.corp'], outboundTag: 'direct' }];
      const cfg = parse(buildXrayJson([xrayEp], { customRules: custom, routingPreset: 'ru-split' }));
      const rules = cfg.routing.rules;
      expect(rules[0]).toEqual(custom[0]); // custom rule wins (first)
      expect(rules[rules.length - 1].outboundTag).toBe(endpointTag(xrayEp)); // catch-all stays last
      // the ru-split block still sits between custom and catch-all
      expect(JSON.stringify(rules)).toContain('geosite:category-ru');
    });

    it('empty / absent custom rules keep output byte-identical', () => {
      expect(buildXrayJson([xrayEp], { customRules: [] })).toBe(buildXrayJson([xrayEp]));
    });
  });

  // R3 - operator custom domain lists.
  describe('customDomainLists (R3)', () => {
    it('empty lists keep output byte-identical to no lists', () => {
      expect(
        buildXrayJson([xrayEp], { customDomainLists: { direct: [], proxy: [], block: [] } }),
      ).toBe(buildXrayJson([xrayEp]));
    });

    it('undefined lists keep output byte-identical', () => {
      expect(buildXrayJson([xrayEp], { customDomainLists: undefined })).toBe(
        buildXrayJson([xrayEp]),
      );
    });

    it('emits one field rule per non-empty bucket, ordered block -> direct -> proxy', () => {
      const cfg = parse(
        buildXrayJson([xrayEp], {
          customDomainLists: {
            block: ['ads.example.com'],
            direct: ['example.ru', 'domain:gosuslugi.ru'],
            proxy: ['youtube.com'],
          },
        }),
      );
      const rules = cfg.routing.rules;
      // block first, then direct, then proxy, then the catch-all.
      expect(rules[0]).toEqual({ type: 'field', domain: ['ads.example.com'], outboundTag: 'block' });
      expect(rules[1]).toEqual({
        type: 'field',
        domain: ['example.ru', 'domain:gosuslugi.ru'],
        outboundTag: 'direct',
      });
      expect(rules[2]).toEqual({ type: 'field', domain: ['youtube.com'], outboundTag: endpointTag(xrayEp) });
      // Catch-all stays last.
      expect(rules[rules.length - 1].outboundTag).toBe(endpointTag(xrayEp));
      expect(rules[rules.length - 1].network).toBe('tcp,udp');
    });

    it('hands every matcher prefix to xray as written, in both renderings', () => {
      const lists = {
        block: [],
        direct: ['full:exact.ru', 'keyword:shop', 'regexp:.*\\.ru', 'domain:gosuslugi.ru'],
        proxy: [],
      };
      const single = parse(buildXrayJson([xrayEp], { customDomainLists: lists }));
      expect(single.routing.rules[0]).toEqual({ type: 'field', domain: lists.direct, outboundTag: 'direct' });
      const array = parseArray(buildXrayJsonArray([xrayEp], { customDomainLists: lists }))[0];
      expect(array.routing.rules.find((r) => r.outboundTag === 'direct')?.domain).toEqual(lists.direct);
    });

    it('only emits buckets that have entries (proxy-only)', () => {
      const cfg = parse(
        buildXrayJson([xrayEp], {
          customDomainLists: { direct: [], proxy: ['youtube.com'], block: [] },
        }),
      );
      const rules = cfg.routing.rules;
      // proxy rule then catch-all (no block/direct rules).
      expect(rules).toHaveLength(2);
      expect(rules[0]).toEqual({ type: 'field', domain: ['youtube.com'], outboundTag: endpointTag(xrayEp) });
    });

    it('drops the proxy bucket when no xray endpoint exists (no valid proxy tag)', () => {
      const cfg = parse(
        buildXrayJson([hysteriaEp], {
          customDomainLists: { direct: ['example.ru'], proxy: ['youtube.com'], block: [] },
        }),
      );
      const rules = cfg.routing.rules;
      // direct rule survives; proxy rule is dropped (no proxy tag to target).
      expect(rules[0]).toEqual({ type: 'field', domain: ['example.ru'], outboundTag: 'direct' });
      expect(JSON.stringify(rules)).not.toContain('youtube.com');
    });

    it('slots between raw custom rules and the preset rules (raw > lists > preset)', () => {
      const custom = [{ type: 'field', domain: ['my.corp'], outboundTag: 'direct' }];
      const cfg = parse(
        buildXrayJson([xrayEp], {
          customRules: custom,
          customDomainLists: { direct: ['example.ru'], proxy: [], block: [] },
          routingPreset: 'ru-split',
        }),
      );
      const rules = cfg.routing.rules;
      // Order: raw custom rule, then domain-list rule, then ru-split block, then catch-all.
      expect(rules[0]).toEqual(custom[0]);
      expect(rules[1]).toEqual({ type: 'field', domain: ['example.ru'], outboundTag: 'direct' });
      expect(rules[2].domain).toEqual(['geosite:category-ads-all']);
      expect(rules[rules.length - 1].outboundTag).toBe(endpointTag(xrayEp));
    });

    it('does not change domainStrategy for proxy-all (domain rules work under AsIs)', () => {
      const cfg = parse(
        buildXrayJson([xrayEp], {
          customDomainLists: { direct: ['example.ru'], proxy: [], block: [] },
        }),
      );
      expect(cfg.routing.domainStrategy).toBe('AsIs');
    });
  });
});

// T1 - A1 array format. The migration blocker: Happ reads the single-config
// buildXrayJson as ONE server; this array is N standalone configs it reads as N
// servers. buildXrayJson must stay untouched (still needed for the balancer).
describe('buildXrayJsonArray (T1)', () => {
  it('produces a top-level JSON array with a trailing newline', () => {
    const out = buildXrayJsonArray([xrayEp, xrayEp2]);
    expect(out.endsWith('\n')).toBe(true);
    const arr = parse(out);
    expect(Array.isArray(arr)).toBe(true);
  });

  it('emits one standalone config per xray endpoint', () => {
    const arr = parseArray(buildXrayJsonArray([xrayEp, xrayEp2]));
    expect(arr).toHaveLength(2);
    expect(arr[0].remarks).toBe('eu-1');
    expect(arr[1].remarks).toBe('us-2');
  });

  it('each element is a full config: own socks inbound + proxy/direct/block outbounds', () => {
    const arr = parseArray(buildXrayJsonArray([xrayEp]));
    const cfg = arr[0];
    expect(cfg.inbounds.map((i) => i.protocol)).toEqual(['socks', 'http']);
    expect(cfg.inbounds[0].port).toBe(10808);
    const tags = cfg.outbounds.map((o) => o.tag);
    expect(tags).toEqual([endpointTag(xrayEp), 'direct', 'block']);
  });

  it('per-config routing: bittorrent -> direct, catch-all -> that proxy', () => {
    const arr = parseArray(buildXrayJsonArray([xrayEp, xrayEp2]));
    // config[1] routes to ITS OWN proxy, not the first one.
    const rules = arr[1].routing.rules;
    expect(rules[0]).toEqual({ type: 'field', protocol: ['bittorrent'], outboundTag: 'direct' });
    expect(rules[1]).toEqual({ type: 'field', network: 'tcp,udp', outboundTag: endpointTag(xrayEp2) });
  });

  it('reuses buildProxyOutbound: the proxy carries REALITY + the endpoint uuid', () => {
    const arr = parseArray(buildXrayJsonArray([xrayEp]));
    const v = arr[0].outbounds.find((o) => o.protocol === 'vless');
    expect(v.streamSettings.security).toBe('reality');
    expect(v.streamSettings.realitySettings.serverName).toBe('www.cloudflare.com');
    expect(v.settings.vnext[0].users[0].id).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('skips protocols the array does not emit (not xray, not hysteria)', () => {
    expect(parseArray(buildXrayJsonArray([naiveEp]))).toEqual([]);
    expect(parseArray(buildXrayJsonArray([naiveEp, xrayEp]))).toHaveLength(1);
  });
});

// A4: route-profiles (explicit cascade exit selection).
describe('withVlessRouteTag', () => {
  it('rewrites only the 3rd group with a big-endian uint16, zero-padded', () => {
    expect(withVlessRouteTag('11111111-2222-3333-4444-555555555555', 1)).toBe(
      '11111111-2222-0001-4444-555555555555',
    );
    expect(withVlessRouteTag('11111111-2222-3333-4444-555555555555', 14)).toBe(
      '11111111-2222-000e-4444-555555555555',
    );
    expect(withVlessRouteTag('11111111-2222-3333-4444-555555555555', 14514)).toBe(
      '11111111-2222-38b2-4444-555555555555',
    );
  });
  it('leaves a malformed uuid untouched', () => {
    expect(withVlessRouteTag('not-a-uuid', 1)).toBe('not-a-uuid');
  });
});

describe('buildXrayJsonArray A4 profile expansion', () => {
  const entryEp: SubscriptionEndpoint = {
    ...xrayEp,
    nodeName: 'ru-entry',
    // Plain profiles for two exits: tag = routeTag(0, index) = index+1.
    cascadeExits: [
      { label: 'de-exit', tag: 1 },
      { label: 'nl-exit', tag: 2 },
    ],
  };
  // A-262: the routes are expanded once before any format (generateSubscription);
  // handed in as there, through the one rule.
  const expandedArray = (eps: SubscriptionEndpoint[]) => buildXrayJsonArray(eps.flatMap(expandCascadeEntry));

  it('expands one entry endpoint into one config per profile, labelled by profile', () => {
    const arr = parseArray(expandedArray([entryEp]));
    expect(arr).toHaveLength(2);
    expect(arr.map((c) => c.remarks)).toEqual(['de-exit', 'nl-exit']);
  });

  it('encodes the profile tag into UUID bytes 7-8 so the node vlessRoute rule pins it', () => {
    const arr = parseArray(expandedArray([entryEp]));
    const uuidOf = (c) =>
      c.outbounds.find((o) => o.protocol === 'vless').settings.vnext[0].users[0].id;
    expect(uuidOf(arr[0])).toBe('11111111-2222-0001-4444-555555555555');
    expect(uuidOf(arr[1])).toBe('11111111-2222-0002-4444-555555555555');
  });

  it('ad-split profile: a policy-band tag (257) encodes as bytes 0101', () => {
    // routeTag(1, 0) = 1*256 + 0 + 1 = 257 = 0x0101. The "CH В· Р‘РµР· СЂРµРєР»Р°РјС‹" profile.
    const arr = parse(
      expandedArray([{ ...entryEp, cascadeExits: [{ label: 'de-exit В· Р‘РµР· СЂРµРєР»Р°РјС‹', tag: 257 }] }]),
    );
    expect(arr).toHaveLength(1);
    expect(arr[0].remarks).toBe('de-exit В· Р‘РµР· СЂРµРєР»Р°РјС‹');
    expect(arr[0].outbounds.find((o) => o.protocol === 'vless').settings.vnext[0].users[0].id)
      .toBe('11111111-2222-0101-4444-555555555555');
  });

  it('all profile configs still dial the same entry host', () => {
    const arr = parseArray(expandedArray([entryEp]));
    const hostOf = (c) =>
      c.outbounds.find((o) => o.protocol === 'vless').settings.vnext[0].address;
    expect(hostOf(arr[0])).toBe('n1.example.com');
    expect(hostOf(arr[1])).toBe('n1.example.com');
  });

  it('takes the profile label as given, whatever the host is called', () => {
    // This format used to append the host remark itself, and so did the plain
    // one, each blind to the other and to whether anything actually collided.
    // Labels are made unique once for the whole subscription now
    // (disambiguateCascadeLabels in subscription.service), so a format that
    // still decorated them would double the suffix.
    for (const hostRemark of ['Default', 'test 2']) {
      expect(
        parseArray(expandedArray([{ ...entryEp, hostRemark }])).map((c) => c.remarks),
      ).toEqual(['de-exit', 'nl-exit']);
    }
  });

  it('an xray endpoint with no profiles stays a single unmodified config', () => {
    const arr = parseArray(expandedArray([xrayEp]));
    expect(arr).toHaveLength(1);
    expect(arr[0].remarks).toBe('eu-1');
    const uuid = arr[0].outbounds.find((o) => o.protocol === 'vless').settings.vnext[0]
      .users[0].id;
    expect(uuid).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('an empty exit list falls back to a single config', () => {
    const arr = parseArray(expandedArray([{ ...xrayEp, cascadeExits: [] }]));
    expect(arr).toHaveLength(1);
    expect(arr[0].remarks).toBe('eu-1');
  });
});

// hy2 in the array (FIELD-PENDING, see buildHysteriaOutbound). Structure is
// tested here; the exact hysteriaSettings shape is verified against the СЌС‚Р°Р»РѕРЅ
// and a live hy2 node before sign-off.
describe('buildXrayJsonArray hysteria (hy2)', () => {
  it('emits a hysteria config in xray-core outbound shape', () => {
    const cfg = parseArray(buildXrayJsonArray([hy2Ep]))[0];
    expect(cfg.remarks).toBe('hy-de');
    const out = cfg.outbounds.find((o) => o.protocol === 'hysteria');
    expect(out.tag).toBe(endpointTag(hy2Ep));
    expect(out.settings).toEqual({ version: 2, address: 'hy.example.com', port: 443 });
    expect(out.streamSettings.network).toBe('hysteria');
    expect(out.streamSettings.hysteriaSettings.version).toBe(2);
    expect(out.streamSettings.hysteriaSettings.auth).toBe('hy-secret');
  });

  it('maps Brutal bandwidth to unit-suffixed up/down', () => {
    const out = parseArray(buildXrayJsonArray([hy2Ep]))[0].outbounds.find(
      (o) => o.protocol === 'hysteria',
    );
    expect(out.streamSettings.hysteriaSettings.up).toBe('100mbps');
    expect(out.streamSettings.hysteriaSettings.down).toBe('300mbps');
  });

  it('emits obfs as Salamander in finalmask.udp, where xray-core reads it', () => {
    const out = JSON.stringify(JSON.parse(buildXrayJsonArray([hy2Ep])));
    expect(out).toContain('{"udp":[{"type":"salamander","settings":{"password":"salt"}}]');
  });

  it('catch-all routes to the hy2 tag', () => {
    const rules = parseArray(buildXrayJsonArray([hy2Ep]))[0].routing.rules;
    expect(rules[rules.length - 1]).toEqual({
      type: 'field',
      network: 'tcp,udp',
      outboundTag: endpointTag(hy2Ep),
    });
  });

  it('mixed xray + hy2 keeps endpoint order, one config each', () => {
    const arr = parseArray(buildXrayJsonArray([xrayEp, hy2Ep]));
    expect(arr.map((c) => c.remarks)).toEqual(['eu-1', 'hy-de']);
    expect(arr[0].outbounds.find((o) => o.protocol === 'vless')).toBeDefined();
    expect(arr[1].outbounds.find((o) => o.protocol === 'hysteria')).toBeDefined();
  });
});

// T2 - the array carries the same routing surface as the single-config builder,
// but every proxy target is THIS config's own proxy.
describe('buildXrayJsonArray routing (T2)', () => {
  it('applies the ru-split preset per config: split rules, split DNS, IPOnDemand', () => {
    const arr = parseArray(buildXrayJsonArray([xrayEp, xrayEp2], { routingPreset: 'ru-split' }));
    for (const [i, cfg] of arr.entries()) {
      const ownTag = i === 0 ? endpointTag(xrayEp) : endpointTag(xrayEp2);
      expect(cfg.routing.domainStrategy).toBe('IPOnDemand');
      expect(cfg.dns.servers[0].address).toBe('77.88.8.8');
      const rules = cfg.routing.rules;
      // block/direct split rules present, then bittorrent, then catch-all to OWN proxy.
      expect(rules[0].domain).toEqual(['geosite:category-ads-all']);
      expect(rules[rules.length - 1]).toEqual({
        type: 'field',
        network: 'tcp,udp',
        outboundTag: ownTag,
      });
    }
  });

  it('proxy-all: no split DNS, AsIs, just bittorrent + catch-all', () => {
    const cfg = parseArray(buildXrayJsonArray([xrayEp]))[0];
    expect(cfg.dns).toBeUndefined();
    expect(cfg.routing.domainStrategy).toBe('AsIs');
    expect(cfg.routing.rules).toHaveLength(2);
  });

  it('custom domain lists target THIS config proxy, not a shared first', () => {
    const arr = parse(
      buildXrayJsonArray([xrayEp, xrayEp2], {
        customDomainLists: { block: [], direct: [], proxy: ['youtube.com'] },
      }),
    );
    // config[1]'s proxy rule points at us-2-xray, not eu-1-xray.
    const proxyRule = arr[1].routing.rules.find((r) => r.domain?.includes('youtube.com'));
    expect(proxyRule.outboundTag).toBe(endpointTag(xrayEp2));
  });

  it('prepends raw customRules ahead of everything per config', () => {
    const custom = [{ type: 'field', domain: ['my.corp'], outboundTag: 'direct' }];
    const cfg = parseArray(buildXrayJsonArray([xrayEp], { customRules: custom }))[0];
    expect(cfg.routing.rules[0]).toEqual(custom[0]);
  });

  it('tlsFragment: each config gets its own fragment outbound + proxy dials through it', () => {
    const arr = parseArray(buildXrayJsonArray([xrayEp, xrayEp2], { tlsFragment: true }));
    for (const cfg of arr) {
      const frag = cfg.outbounds.find((o) => o.tag === 'fragment');
      expect(frag).toBeDefined();
      expect(frag.settings.fragment).toEqual({
        packets: 'tlshello',
        length: '100-200',
        interval: '10-20',
      });
      const v = cfg.outbounds.find((o) => o.protocol === 'vless');
      expect(v.streamSettings.sockopt.dialerProxy).toBe('fragment');
    }
  });

  it('carries the endpoint transport into the array proxy (xhttp)', () => {
    const xhttpEp: SubscriptionEndpoint = {
      ...xrayEp,
      network: 'xhttp',
      path: '/dl',
      hostHeader: 'cdn.example.com',
    };
    const v = parseArray(buildXrayJsonArray([xhttpEp]))[0].outbounds.find(
      (o) => o.protocol === 'vless',
    );
    expect(v.streamSettings.network).toBe('xhttp');
    expect(v.streamSettings.xhttpSettings.path).toBe('/dl');
    expect(v.streamSettings.xhttpSettings.mode).toBe('auto');
  });
});

/**
 * hysteria2 in xray-core: Salamander in finalmask.udp, the bandwidth in
 * finalmask.quicParams beside the deprecated up/down, and an endpoint xray
 * cannot trust left out (allowInsecure no longer exists in this core).
 */
describe('buildXrayJsonArray: hysteria2 an xray client can reach', () => {
  type Out = { protocol?: string; streamSettings?: { finalmask?: Record<string, unknown>; hysteriaSettings?: Record<string, unknown> } };
  const hyOut = (eps: SubscriptionEndpoint[]): Out | undefined => {
    const configs = JSON.parse(buildXrayJsonArray(eps)) as { outbounds: Out[] }[];
    return configs.flatMap((c) => c.outbounds).find((o) => o.protocol === 'hysteria');
  };

  it('obfs and Brutal reach the places the core reads them', () => {
    const out = hyOut([{ ...hysteriaEp, obfsPassword: 'salt', upMbps: 100, downMbps: 200 } as SubscriptionEndpoint]);
    expect(out?.streamSettings?.finalmask).toEqual({
      udp: [{ type: 'salamander', settings: { password: 'salt' } }],
      quicParams: { congestion: 'brutal', brutalUp: '100mbps', brutalDown: '200mbps' },
    });
    expect(out?.streamSettings?.hysteriaSettings).toMatchObject({ up: '100mbps', down: '200mbps' });
  });

  it('no obfs and no bandwidth: no finalmask at all', () => {
    expect(hyOut([hysteriaEp])?.streamSettings?.finalmask).toBeUndefined();
  });

  it('a sing-box hysteria2 with no pin is left out, a pinned one stays', () => {
    expect(hyOut([{ ...hysteriaEp, engine: 'singbox' } as SubscriptionEndpoint])).toBeUndefined();
    const pinned = {
      ...hysteriaEp,
      engine: 'singbox',
      tlsPin: { serverName: 'n1.example.com', certSha256: 'ab'.repeat(32), certPem: '' },
    } as SubscriptionEndpoint;
    expect(hyOut([pinned])).toBeDefined();
  });
});

// Milestone 12.5 (f12-21): the split presets carry the region's lists themselves,
// for the clients that trim their geo files to the tags of their own profile.
describe('the split presets embed the region\'s lists (f12-21)', () => {
  const RU: PresetGeoInline = {
    domains: {
      'category-ru': ['domain:yandex.ru', 'full:www.example.ru', 'keyword:ruword'],
      'category-gov-ru': ['domain:gosuslugi.ru', 'domain:yandex.ru'],
    },
    cidrs: { ru: ['5.3.0.0/16', '77.88.0.0/16'] },
  };
  const CN: PresetGeoInline = { domains: { cn: ['domain:baidu.com'] }, cidrs: { cn: ['1.0.1.0/24'] } };
  const text = (o: unknown) => JSON.stringify(o);
  const noRegionRef = (s: string) => {
    expect(s).not.toContain('geosite:');
    expect(s).not.toMatch(/geoip:(?!$)/);
  };

  it('ru-split: the lists replace the names in the rules, the private ranges are literals, ads are not blocked', () => {
    const cfg = parse(buildXrayJson([xrayEp], { routingPreset: 'ru-split', presetGeoInline: RU }));
    const rules = cfg.routing.rules;
    expect(rules).toHaveLength(3);
    expect(rules[0]).toEqual({
      type: 'field',
      domain: ['domain:yandex.ru', 'full:www.example.ru', 'keyword:ruword', 'domain:gosuslugi.ru'],
      outboundTag: 'direct',
    });
    const ip = rules[1]!.ip as string[];
    expect(ip).toEqual(expect.arrayContaining(['10.0.0.0/8', '192.168.0.0/16', '5.3.0.0/16', '77.88.0.0/16']));
    expect(ip.slice(-2)).toEqual(['5.3.0.0/16', '77.88.0.0/16']);
    expect(rules[1]!.outboundTag).toBe('direct');
    expect(rules[2]!.outboundTag).toBe(endpointTag(xrayEp));
    expect(text(cfg.routing.rules)).not.toContain('block');
    noRegionRef(text(cfg.routing.rules));
    expect(cfg.routing.domainStrategy).toBe('IPOnDemand');
  });

  it('ru-split: the regional DNS server is scoped by the same domains, the rest of the block is as before', () => {
    const base = JSON.parse(buildXrayJson([xrayEp], { routingPreset: 'ru-split' })).dns;
    const dns = JSON.parse(buildXrayJson([xrayEp], { routingPreset: 'ru-split', presetGeoInline: RU })).dns;
    expect(dns.servers[0]).toEqual({
      address: '77.88.8.8',
      domains: ['domain:yandex.ru', 'full:www.example.ru', 'keyword:ruword', 'domain:gosuslugi.ru'],
      skipFallback: true,
    });
    expect(dns.servers[1]).toBe(base.servers[1]);
    expect(dns.queryStrategy).toBe(base.queryStrategy);
    noRegionRef(text(dns));
  });

  it('an own preset: IPOnDemand with an address rule, IPIfNonMatch with domain rules only (17.6)', () => {
    const strategy = (rules: DeviceRouteRule[]) =>
      parse(buildXrayJson([xrayEp], { ownPresetRules: rules })).routing.domainStrategy;
    expect(strategy([{ match: ['geoip:ru'], action: 'direct', note: '' }])).toBe('IPOnDemand');
    expect(strategy([{ match: ['10.0.0.0/8'], action: 'direct', note: '' }])).toBe('IPOnDemand');
    expect(strategy([{ match: ['geosite:category-ru'], action: 'direct', note: '' }])).toBe('IPIfNonMatch');
  });

  it('cn-split is issued as the base, with the data handed in or without (12.5 decision)', () => {
    const base = buildXrayJson([xrayEp], { routingPreset: 'cn-split' });
    expect(buildXrayJson([xrayEp], { routingPreset: 'cn-split', presetGeoInline: CN })).toBe(base);
    expect(text(JSON.parse(base).routing.rules)).toContain('geosite:cn');
  });

  it('the array form: every element carries the lists', () => {
    const out = parseArray(buildXrayJsonArray([xrayEp, xrayEp2], { routingPreset: 'ru-split', presetGeoInline: RU }));
    expect(out).toHaveLength(2);
    for (const cfg of out) {
      noRegionRef(text(cfg.routing.rules) + text((cfg as unknown as { dns: unknown }).dns));
      expect(cfg.routing.rules[0]!.domain).toContain('domain:yandex.ru');
      expect(text(cfg.routing.rules)).not.toContain('block');
    }
  });

  it('no data, or data that misses a category of the preset: the document is the base\'s', () => {
    const base = buildXrayJson([xrayEp], { routingPreset: 'ru-split' });
    expect(buildXrayJson([xrayEp], { routingPreset: 'ru-split', presetGeoInline: undefined })).toBe(base);
    const half: PresetGeoInline = { domains: { 'category-ru': ['domain:yandex.ru'] }, cidrs: { ru: ['5.3.0.0/16'] } };
    expect(buildXrayJson([xrayEp], { routingPreset: 'ru-split', presetGeoInline: half })).toBe(base);
    expect(buildXrayJson([xrayEp], { routingPreset: 'ru-split', presetGeoInline: { ...RU, cidrs: { ru: [] } } })).toBe(base);
    expect(buildXrayJson([xrayEp], { routingPreset: 'ru-split', presetGeoInline: CN })).toBe(base);
    expect(text(JSON.parse(base).routing.rules)).toContain('geosite:category-ads-all');
  });

  it('proxy-all, the router form and an operator\'s own preset are not touched', () => {
    const same = (o: Parameters<typeof buildXrayJson>[1]) =>
      expect(buildXrayJson([xrayEp], { ...o, presetGeoInline: RU })).toBe(buildXrayJson([xrayEp], o));
    same({ routingPreset: 'proxy-all' });
    same({ routingPreset: 'ru-split', forRouter: true });
    same({ routingPreset: 'ru-split', ownPresetRules: [{ match: ['geosite:category-ru'], action: 'direct', note: '' }] });
    expect(
      buildXrayJsonArray([xrayEp], { routingPreset: 'ru-split', ownPresetRules: [{ match: ['geoip:ru'], action: 'direct', note: '' }], presetGeoInline: RU }),
    ).toBe(buildXrayJsonArray([xrayEp], { routingPreset: 'ru-split', ownPresetRules: [{ match: ['geoip:ru'], action: 'direct', note: '' }] }));
  });

  it('a frame with its own dns keeps it; the rules still carry the lists', () => {
    const frame = readFrame(
      'xray-json',
      JSON.stringify({ iceslab: { routing: 'preset' }, dns: { servers: ['9.9.9.9'] }, outbounds: [{ tag: 'direct', protocol: 'freedom' }], routing: { rules: [] } }),
    );
    const cfg = parse(buildXrayJson([xrayEp], { frame, routingPreset: 'ru-split', presetGeoInline: RU }));
    expect((cfg as unknown as { dns: unknown }).dns).toEqual({ servers: ['9.9.9.9'] });
    expect(text(cfg.routing.rules)).toContain('domain:yandex.ru');
  });
});

describe('buildXrayJson IPv6 address', () => {
  it('the vnext address is the bare address', () => {
    expect(buildXrayJson([{ ...xrayEp, host: '2001:db8::1' }])).toContain('"address": "2001:db8::1"');
  });
});

// Stage 19.4: the operator's "names -> DNS server" rules in the xray formats.
describe('DNS rules (19.4)', () => {
  const rule = (server: string, ...match: string[]) => ({ match, server, note: '' });
  const CORP = [rule('tcp://10.0.0.2', 'corp.example', 'geosite:category-ads-all')];
  const DEFAULT_SERVER = 'https://1.1.1.1/dns-query';
  const text = (o: unknown) => JSON.stringify(o);
  const RU: PresetGeoInline = {
    domains: { 'category-ru': ['domain:yandex.ru'], 'category-gov-ru': ['domain:gosuslugi.ru'] },
    cidrs: { ru: ['5.3.0.0/16'] },
  };
  const PRESET_FRAME = (extra: Record<string, unknown> = {}) =>
    readFrame(
      'xray-json',
      JSON.stringify({
        iceslab: { routing: 'preset' },
        outbounds: [{ tag: 'direct', protocol: 'freedom' }, { tag: 'block', protocol: 'blackhole' }],
        routing: { rules: [] },
        ...extra,
      }),
    );
  type Dns = { queryStrategy?: string; servers: unknown[] };
  const dnsOf = (c: XrayConfig) => (c as unknown as { dns?: Dns }).dns;
  const tags = (c: XrayConfig) => c.outbounds.map((o) => o.tag);
  const OWN: DeviceRouteRule[] = [{ match: ['geosite:google'], action: 'direct', note: '' }];
  const corpServer = { address: 'tcp://10.0.0.2', domains: ['domain:corp.example', 'geosite:category-ads-all'], skipFallback: true };

  it('own preset without rules: no dns, no dns outbound, no port 53 rule (as before)', () => {
    const cfg = parse(buildXrayJson([xrayEp], { ownPresetRules: OWN, dnsRules: [] }));
    expect(dnsOf(cfg)).toBeUndefined();
    expect(tags(cfg)).not.toContain('dns-out');
    expect(text(cfg.routing.rules)).not.toContain('"port":"53"');
  });

  it('own preset with a rule: the rule server, then the default server; the pin first, then port 53 to the dns outbound', () => {
    const cfg = parse(buildXrayJson([xrayEp], { ownPresetRules: OWN, dnsRules: CORP }));
    expect(dnsOf(cfg)).toEqual({ queryStrategy: 'UseIPv4', servers: [corpServer, DEFAULT_SERVER] });
    const p = endpointTag(xrayEp);
    expect(cfg.routing.rules[0]).toEqual({ type: 'field', ip: ['10.0.0.2'], outboundTag: p });
    expect(cfg.routing.rules[1]).toEqual({ type: 'field', port: '53', outboundTag: 'dns-out' });
    expect(cfg.routing.rules[2]).toMatchObject({ domain: ['geosite:google'], outboundTag: 'direct' });
    expect(tags(cfg)).toEqual([p, 'direct', 'block', 'dns-out']);
    expect(cfg.outbounds[3]).toEqual({ tag: 'dns-out', protocol: 'dns' });
    // dns follows log; the strategy for the document's domains is not changed by it.
    expect(Object.keys(cfg).indexOf('dns')).toBe(Object.keys(cfg).indexOf('log') + 1);
    expect(cfg.routing.domainStrategy).toBe('IPIfNonMatch');
  });

  it('proxy-all (a built-in without split DNS) gets the section too, with panel-wide rules', () => {
    const cfg = parse(buildXrayJson([xrayEp], { routingPreset: 'proxy-all', dnsRules: CORP }));
    expect(dnsOf(cfg)!.servers).toEqual([corpServer, DEFAULT_SERVER]);
    expect(cfg.routing.domainStrategy).toBe('AsIs');
  });

  it('ru-split: the operator rule stands before the regional server, then the fallback; an overlapping name is the operator\'s', () => {
    const rules = [rule('tcp://10.0.0.2', 'geosite:category-ru', 'corp.example')];
    const cfg = parse(buildXrayJson([xrayEp], { routingPreset: 'ru-split', dnsRules: rules }));
    const d = dnsOf(cfg)!;
    expect(d.servers).toEqual([
      { address: 'tcp://10.0.0.2', domains: ['geosite:category-ru', 'domain:corp.example'], skipFallback: true },
      { address: '77.88.8.8', domains: ['geosite:category-ru', 'geosite:category-gov-ru'], skipFallback: true },
      DEFAULT_SERVER,
    ]);
    expect(d.queryStrategy).toBe('UseIPv4');
    expect(cfg.routing.domainStrategy).toBe('IPOnDemand');
    expect(cfg.routing.rules[0]).toMatchObject({ ip: ['10.0.0.2'] });
    // the inlined region's lists feed the regional server only, the operator's names stay as written
    const inlined = parse(buildXrayJson([xrayEp], { routingPreset: 'ru-split', dnsRules: rules, presetGeoInline: RU }));
    expect((dnsOf(inlined)!.servers[0] as { domains: string[] }).domains).toEqual(['geosite:category-ru', 'domain:corp.example']);
  });

  it('cn-split likewise', () => {
    const d = dnsOf(parse(buildXrayJson([xrayEp], { routingPreset: 'cn-split', dnsRules: CORP })))!;
    expect(d.servers).toEqual([corpServer, expect.objectContaining({ address: '223.5.5.5' }), DEFAULT_SERVER]);
  });

  it('a server named by host (DoH) is pinned by full: name, an IP one by address; the two rules are one each', () => {
    const rules = [rule('https://dns.corp.example/dns-query', 'a.example'), rule('tcp://10.0.0.2', 'b.example'), rule('10.0.0.3', 'c.example')];
    const cfg = parse(buildXrayJson([xrayEp], { ownPresetRules: OWN, dnsRules: rules }));
    const p = endpointTag(xrayEp);
    expect(cfg.routing.rules.slice(0, 3)).toEqual([
      { type: 'field', ip: ['10.0.0.2', '10.0.0.3'], outboundTag: p },
      { type: 'field', domain: ['full:dns.corp.example'], outboundTag: p },
      { type: 'field', port: '53', outboundTag: 'dns-out' },
    ]);
  });

  it('the balancer bundle pins to the balancer', () => {
    const cfg = parse(buildXrayJson([xrayEp, xrayEp2], { bundle: 'balancer', ownPresetRules: OWN, dnsRules: CORP }));
    expect(cfg.routing.rules[0]).toEqual({ type: 'field', ip: ['10.0.0.2'], balancerTag: 'balancer-auto' });
  });

  it('DoT only: skipped, the document is what it was without rules; DoT beside others: only the others', () => {
    const dot = [rule('tls://10.0.0.9', 'x.example')];
    expect(buildXrayJson([xrayEp], { ownPresetRules: OWN, dnsRules: dot })).toBe(buildXrayJson([xrayEp], { ownPresetRules: OWN }));
    expect(buildXrayJsonArray([xrayEp], { routingPreset: 'ru-split', dnsRules: dot })).toBe(buildXrayJsonArray([xrayEp], { routingPreset: 'ru-split' }));
    const cfg = parse(buildXrayJson([xrayEp], { ownPresetRules: OWN, dnsRules: [...dot, ...CORP] }));
    expect(dnsOf(cfg)!.servers).toEqual([corpServer, DEFAULT_SERVER]);
    expect(text(cfg.routing.rules)).not.toContain('10.0.0.9');
  });

  it('empty rules: byte for byte the output without the option, in all three forms', () => {
    for (const routingPreset of ['proxy-all', 'ru-split', 'cn-split'] as const) {
      expect(buildXrayJson([xrayEp], { routingPreset, dnsRules: [] })).toBe(buildXrayJson([xrayEp], { routingPreset }));
      expect(buildXrayJsonArray([xrayEp, hy2Ep], { routingPreset, dnsRules: [] })).toBe(buildXrayJsonArray([xrayEp, hy2Ep], { routingPreset }));
      expect(buildXrayJson([xrayEp], { routingPreset, forRouter: true, dnsRules: [] })).toBe(buildXrayJson([xrayEp], { routingPreset, forRouter: true }));
    }
  });

  it('array: each config pins to its own proxy and carries the dns outbound; hysteria too', () => {
    const arr = parseArray(buildXrayJsonArray([xrayEp, xrayEp2, hy2Ep], { ownPresetRules: OWN, dnsRules: CORP }));
    expect(arr).toHaveLength(3);
    for (const [i, e] of [xrayEp, xrayEp2, hy2Ep].entries()) {
      const c = arr[i]!;
      const t = endpointTag(e);
      expect(dnsOf(c)).toEqual({ queryStrategy: 'UseIPv4', servers: [corpServer, DEFAULT_SERVER] });
      expect(c.routing.rules[0]).toEqual({ type: 'field', ip: ['10.0.0.2'], outboundTag: t });
      expect(c.routing.rules[1]).toEqual({ type: 'field', port: '53', outboundTag: 'dns-out' });
      expect(tags(c).filter((x) => x === 'dns-out')).toHaveLength(1);
    }
  });

  it('xkeen: the dns section and the pin, no dns outbound, no port 53 rule', () => {
    const cfg = parse(buildXrayJson([xrayEp], { ownPresetRules: OWN, dnsRules: CORP, forRouter: true }));
    expect(dnsOf(cfg)!.servers).toEqual([corpServer, DEFAULT_SERVER]);
    expect(cfg.routing.rules[0]).toEqual({ type: 'field', ip: ['10.0.0.2'], outboundTag: endpointTag(xrayEp) });
    expect(tags(cfg)).not.toContain('dns-out');
    expect(text(cfg.routing.rules)).not.toContain('"port":"53"');
    expect(cfg.log).toBeUndefined();
    const split = parse(buildXrayJson([xrayEp], { routingPreset: 'ru-split', dnsRules: CORP, forRouter: true }));
    expect(dnsOf(split)!.servers).toHaveLength(3);
    expect(tags(split)).not.toContain('dns-out');
  });

  it('a frame with no proxy gets none of it', () => {
    const base = buildXrayJson([], { ownPresetRules: OWN });
    expect(buildXrayJson([], { ownPresetRules: OWN, dnsRules: CORP })).toBe(base);
    const ru = buildXrayJson([], { routingPreset: 'ru-split' });
    expect(buildXrayJson([], { routingPreset: 'ru-split', dnsRules: CORP })).toBe(ru);
    expect(buildXrayJsonArray([], { ownPresetRules: OWN, dnsRules: CORP })).toBe('[]\n');
    // nodes of other protocols only: no xray proxy either
    expect(buildXrayJson([naiveEp], { ownPresetRules: OWN, dnsRules: CORP })).toBe(buildXrayJson([naiveEp], { ownPresetRules: OWN }));
  });

  it('a frame with its own dns: it stands whole, nothing of the rules is added', () => {
    const frame = PRESET_FRAME({ dns: { servers: ['9.9.9.9'] } });
    for (const o of [{ ownPresetRules: OWN }, { routingPreset: 'ru-split' as const }]) {
      const cfg = parse(buildXrayJson([xrayEp], { ...o, frame, dnsRules: CORP }));
      expect(dnsOf(cfg)).toEqual({ servers: ['9.9.9.9'] });
      expect(tags(cfg)).not.toContain('dns-out');
      expect(text(cfg.routing.rules)).not.toContain('10.0.0.2');
      expect(text(cfg.routing.rules)).not.toContain('"port":"53"');
      expect(buildXrayJson([xrayEp], { ...o, frame, dnsRules: CORP })).toBe(buildXrayJson([xrayEp], { ...o, frame }));
    }
  });

  it('a frame without iceslab.routing: preset gets no panel routing, so none of it', () => {
    const frame = readFrame('xray-json', JSON.stringify({ outbounds: [{ tag: 'direct', protocol: 'freedom' }], routing: { rules: [] } }));
    expect(buildXrayJson([xrayEp], { ownPresetRules: OWN, frame, dnsRules: CORP })).toBe(buildXrayJson([xrayEp], { ownPresetRules: OWN, frame }));
    const cfg = parse(buildXrayJson([xrayEp], { ownPresetRules: OWN, frame, dnsRules: CORP }));
    expect(dnsOf(cfg)).toBeUndefined();
    expect(tags(cfg)).not.toContain('dns-out');
  });

  it('a frame outbound already tagged dns-out is used, not added twice; the frame\'s own rules come after the panel\'s', () => {
    const frame = PRESET_FRAME({
      outbounds: [{ tag: 'direct', protocol: 'freedom' }, { tag: 'dns-out', protocol: 'dns', settings: { nonRecursive: true } }],
      routing: { rules: [{ type: 'field', protocol: ['bittorrent'], outboundTag: 'direct' }] },
    });
    const cfg = parse(buildXrayJson([xrayEp], { ownPresetRules: OWN, frame, dnsRules: CORP }));
    expect(tags(cfg).filter((x) => x === 'dns-out')).toHaveLength(1);
    expect(cfg.outbounds.find((o) => o.tag === 'dns-out')).toEqual({ tag: 'dns-out', protocol: 'dns', settings: { nonRecursive: true } });
    expect(cfg.routing.rules[1]).toEqual({ type: 'field', port: '53', outboundTag: 'dns-out' });
    const bt = cfg.routing.rules.findIndex((r) => (r.protocol as string[] | undefined)?.[0] === 'bittorrent');
    expect(bt).toBeGreaterThan(1);
  });

  it('the TLS fragment dialer and the dns outbound both stay: fragment before dns-out', () => {
    const cfg = parse(buildXrayJson([xrayEp], { ownPresetRules: OWN, dnsRules: CORP, tlsFragment: true }));
    expect(tags(cfg).slice(-2)).toEqual(['fragment', 'dns-out']);
  });

  describe('iceslab: { dns: merge } (19.8)', () => {
    const OUTS = [{ tag: 'direct', protocol: 'freedom' }, { tag: 'block', protocol: 'blackhole' }];
    // Same key order with and without the mark, so the output compares byte for byte.
    const MERGE = (dns: unknown, mark = true) =>
      JSON.stringify({
        iceslab: { routing: 'preset', ...(mark ? { dns: 'merge' } : {}) },
        ...(dns === undefined ? {} : { dns }),
        outbounds: OUTS,
        routing: { rules: [] },
      });
    const frameOf = (dns: unknown, type: 'xray-json' | 'xray-json-array' = 'xray-json') => readFrame(type, MERGE(dns));
    const OWN_STR = { queryStrategy: 'UseIP', hosts: { 'h.example': '192.0.2.1' }, servers: ['8.8.8.8'] };
    const o = { ownPresetRules: OWN, dnsRules: CORP };

    it('servers a list of strings: the rules\' servers first, the template\'s other fields as they were', () => {
      const cfg = parse(buildXrayJson([xrayEp], { ...o, frame: frameOf(OWN_STR) }));
      expect(dnsOf(cfg)).toEqual({ ...OWN_STR, servers: [corpServer, '8.8.8.8'] });
      expect(Object.keys(dnsOf(cfg)!)).toEqual(['queryStrategy', 'hosts', 'servers']);
    });

    it('servers a list of objects, and servers absent', () => {
      const objs = [{ address: '9.9.9.9', domains: ['domain:own.example'] }];
      expect(dnsOf(parse(buildXrayJson([xrayEp], { ...o, frame: frameOf({ servers: objs }) })))).toEqual({ servers: [corpServer, ...objs] });
      expect(dnsOf(parse(buildXrayJson([xrayEp], { ...o, frame: frameOf({ tag: 'dns-in' }) })))).toEqual({ tag: 'dns-in', servers: [corpServer] });
      expect(dnsOf(parse(buildXrayJson([xrayEp], { ...o, frame: frameOf({}) })))).toEqual({ servers: [corpServer] });
    });

    it('the pin, the dns outbound and the port 53 rule go in as without a dns of the template\'s own', () => {
      const merged = parse(buildXrayJson([xrayEp], { ...o, frame: frameOf(OWN_STR) }));
      const plain = parse(buildXrayJson([xrayEp], { ...o, frame: readFrame('xray-json', MERGE(undefined, false)) }));
      expect(merged.routing.rules).toEqual(plain.routing.rules);
      expect(tags(merged)).toEqual(tags(plain));
      expect(tags(merged)).toContain('dns-out');
      expect(merged.routing.rules.some((r) => r.port === '53')).toBe(true);
    });

    it('the operator\'s rule goes first, so for a name in both it answers', () => {
      const own = [{ address: '9.9.9.9', domains: ['domain:corp.example'] }];
      const servers = dnsOf(parse(buildXrayJson([xrayEp], { ...o, frame: frameOf({ servers: own }) })))!.servers;
      expect(servers).toEqual([corpServer, ...own]);
    });

    it('xkeen: the servers and the pin, no dns outbound and no port 53 rule', () => {
      const cfg = parse(buildXrayJson([xrayEp], { ...o, forRouter: true, frame: frameOf(OWN_STR) }));
      expect(dnsOf(cfg)).toEqual({ ...OWN_STR, servers: [corpServer, '8.8.8.8'] });
      expect(tags(cfg)).not.toContain('dns-out');
      expect(text(cfg.routing.rules)).not.toContain('"port":"53"');
      expect(text(cfg.routing.rules)).toContain('10.0.0.2');
    });

    it('the array: every element', () => {
      const cfgs = parseArray(buildXrayJsonArray([xrayEp, xrayEp2], { ...o, frame: frameOf(OWN_STR, 'xray-json-array') }));
      expect(cfgs).toHaveLength(2);
      for (const c of cfgs) {
        expect((c as unknown as { dns: Dns }).dns).toEqual({ ...OWN_STR, servers: [corpServer, '8.8.8.8'] });
        expect(c.outbounds.map((x) => x.tag)).toContain('dns-out');
      }
    });

    it('a dns that is not an object, or servers that is not a list: it stands whole, as without the mark', () => {
      for (const dns of ['dns.example', ['8.8.8.8'], { servers: '8.8.8.8' }, { servers: { a: 1 } }]) {
        const frame = frameOf(dns);
        const marked = buildXrayJson([xrayEp], { ...o, frame });
        const bare = buildXrayJson([xrayEp], { ...o, frame: readFrame('xray-json', MERGE(dns, false)) });
        expect(marked, text(dns)).toBe(bare);
        expect(dnsOf(parse(marked))).toEqual(dns);
        expect(tags(parse(marked))).not.toContain('dns-out');
      }
    });

    it('without the mark the template wins whole, whatever the rules are', () => {
      const frame = readFrame('xray-json', MERGE(OWN_STR, false));
      const cfg = parse(buildXrayJson([xrayEp], { ...o, frame }));
      expect(dnsOf(cfg)).toEqual(OWN_STR);
      expect(buildXrayJson([xrayEp], { ...o, frame })).toBe(buildXrayJson([xrayEp], { ...o, frame, dnsRules: [] }));
    });

    it('with the mark and no rules (or no proxy, or all DoT) the template is served as written', () => {
      const frame = frameOf(OWN_STR);
      const unmarked = readFrame('xray-json', MERGE(OWN_STR, false));
      for (const [eps, rules] of [[[xrayEp], []], [[], CORP], [[xrayEp], [rule('tls://10.0.0.9', 'dot.example')]]] as const) {
        expect(buildXrayJson([...eps], { ...o, frame, dnsRules: rules })).toBe(buildXrayJson([...eps], { ...o, frame: unmarked, dnsRules: rules }));
      }
      expect(buildXrayJsonArray([xrayEp], { ...o, frame: frameOf(OWN_STR, 'xray-json-array'), dnsRules: [] })).toBe(
        buildXrayJsonArray([xrayEp], { ...o, frame: readFrame('xray-json-array', MERGE(OWN_STR, false)), dnsRules: [] }),
      );
    });

    it('the mark without `routing: preset` does nothing: no panel routing reaches that frame', () => {
      const frame = readFrame('xray-json', JSON.stringify({ iceslab: { dns: 'merge' }, dns: OWN_STR, outbounds: [{ tag: 'direct', protocol: 'freedom' }], routing: { rules: [] } }));
      expect(dnsOf(parse(buildXrayJson([xrayEp], { ...o, frame })))).toEqual(OWN_STR);
    });
  });
});
