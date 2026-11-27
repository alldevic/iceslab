import { transportServed, type DnsRule, type RoutingPresetId } from '@iceslab/shared';
import { emitsVisionFlow, isPlainXray, type SubscriptionEndpoint } from '../subscription.formats.js';
import { makeTagger } from '../endpoint-identity.js';
import { exitsHaveIpv6, singboxDnsStrategy } from '../subscription.address-family.js';
import { BUILTIN_PRESET_RULES, type DeviceRouteRule } from '../../routing-presets/routing-presets.builtins.js';
import { singboxDeviceRoute, singboxDnsRules } from '../subscription.device-rules.js';
import type { SelfHostedGeo } from '../../geo-sets/geo-self-host.js';
import type { SingboxExtRef } from '../../geo-sets/geo-ext-lists.js';
import { asArray, asObject, defaultFrame, insertAfter, openFrame, type Frame } from '../subscription.frames.js';

/**
 * Sing-box JSON subscription formatter (sing-box 1.10+).
 *
 * Targets Sing-box itself, Hiddify-Next, NekoBox-iOS, NekoBox-Android.
 *
 * Scope:
 *   - hysteria2          (slice 21)
 *   - xray vless+REALITY (slice 21, slice 24c part 2 transports)
 *   - xray trojan+REALITY (slice 24c part 3a)
 *   - shadowsocks (SS2022 + legacy AEAD) (slice 24d)
 *
 * AmneziaWG/Naive are NOT emitted: AmneziaWG users get the wg-quick `.conf`
 * format; Naive users get the `naive+https` URI directly. Adding them here
 * would require sing-box's `wireguard` outbound (which lacks the AmneziaWG
 * obfuscation params) or a `naive` outbound that doesn't exist upstream.
 *
 * Output shape - minimal valid sing-box config:
 *   - `log`: standard
 *   - `outbounds`: per-endpoint proxies + Auto selector + direct
 *   - `route.final = "Auto"`: catch-all sends every connection through the
 *     selector. `auto_detect_interface: true` lets sing-box hop networks
 *     without restart.
 *
 * A single minimal `tun` inbound (see buildSingboxJson); no `experimental`, the
 * client app fills that in. `dns` only under a built-in split preset or with DNS
 * rules in force (dnsBlock in fillSingboxFrame).
 */
/**
 * Slice 29: when `bundle === 'url-test'`, the formatter wraps proxy tags in
 * a `url-test` group named `Auto-URLTest` that probes each outbound every
 * `urltestIntervalSec` seconds and routes through the lowest-latency one.
 * Otherwise (default), we emit the legacy `selector` group that lets the
 * client UI pick manually. Both forms still emit a `direct` outbound and a
 * `route.final` pointer at the chosen group.
 */
export interface SingboxBuildOpts {
  bundle?: 'selector' | 'url-test';
  urltestIntervalSec?: number;
  urltestProbeUrl?: string;
  routingPreset?: RoutingPresetId;
  /** A-229: an own preset's rules, in place of the built-in preset's. */
  ownPresetRules?: readonly DeviceRouteRule[];
  /** Stage 19: the DNS rules in force (the preset's own, then the panel-wide);
   *  sing-box 1.12+ runs them (19.6, see fillSingboxFrame). */
  dnsRules?: readonly DnsRule[];
  /** A-236: the operator template to fill; absent = the Default in the code. */
  frame?: Frame;
  /** What the panel serves to clients itself (GEO_SELF_HOST); null/undefined = the base's addresses. */
  geo?: SelfHostedGeo | null;
  /** Milestone 10.6: `ext:` links of the operator's domain lists, as the panel's `.srs`; the route resolves them. */
  extRefs?: readonly SingboxExtRef[];
}

/**
 * Routing Templates (R1b + H2) - a split `routingPreset` adds `route.rules` +
 * `route.rule_set` ahead of `route.final`: ads/malware rejected, region domains
 * and region/private IPs direct, everything else falls through to the tunnel.
 * `ru-split` uses RU rule-sets; `cn-split` uses geosite-cn / geoip-cn.
 *
 * sing-box removed geosite:/geoip: in 1.12, so the only portable vehicle is
 * remote rule-sets (.srs) from the SagerNet-published repos. We deliberately
 * do NOT emit `download_detour`: it is deprecated since 1.14, and redundant
 * here - until a rule-set is downloaded its rules cannot match, so the
 * download itself falls through `route.final` and rides the tunnel. We also
 * skip `experimental.cache_file` (rule-set caching) to keep the "client app
 * fills in the rest" contract; the .srs files are small and re-fetch cheaply.
 *
 * Rules use the modern `action:` form (rule `outbound` is deprecated since
 * 1.11), so the ru-split preset needs sing-box 1.11+. With the default
 * 'proxy-all' preset the output stays byte-identical to pre-R1 builds and
 * keeps working on 1.10.
 *
 * Split DNS is emitted only under a built-in split preset, in the one shape
 * sing-box 1.12+ accepts (see fillSingboxFrame); proxy-all and an own preset
 * have no regional half to resolve differently and get a `dns` block only when
 * DNS rules (stage 19) are in force.
 */
// The route rules and rule-sets of a preset are rendered from its
// DeviceRouteRule list (subscription.device-rules.ts, A-229): the built-ins' and an own
// preset's alike, geo names as the SagerNet `.srs` rule-sets the built-ins
// have always used. The RU/CN arrays that lived here rendered the same.

export function buildSingboxJson(
  endpoints: SubscriptionEndpoint[],
  opts: SingboxBuildOpts = {},
): string {
  const outbounds: Record<string, unknown>[] = [];
  const proxyTags: string[] = [];
  // Routing preset (R1b + H2 + A-229); proxy-all has no rules, so the output
  // stays byte-identical to pre-R1 builds.
  const deviceRules = opts.ownPresetRules ?? BUILTIN_PRESET_RULES[opts.routingPreset ?? 'proxy-all'];

  // A sing-box tag is what the selector shows and what a client remembers as
  // "the proxy I picked", so it cannot become an opaque id the way an xray
  // outbound tag can: it has to stay the readable name AND be unique. Labels are
  // made unique for every format at once in disambiguateEndpointLabels; the
  // tagger is what holds the guarantee when a formatter is called directly, with
  // endpoints that never passed through the service.
  const tagOf = makeTagger();
  for (const e of endpoints) {
    // A route of a cascade entry (A-262, expanded before any format) is named
    // by its label, as in the links.
    const tag = tagOf(e, e.routeLabel ?? `${e.nodeName}-${e.protocol}`);
    if (e.protocol === 'hysteria') {
      proxyTags.push(tag);
      // sing-box requires `tls.enabled: true` for hysteria2 outbounds,
      // without it the parser fails with "TLS required" (caught in Hiddify
      // 4.1.1 on 2026-05-06). Hysteria2 always uses TLS by design, so this
      // is purely a parser-satisfaction quirk.
      // Slice 31.5: sing-box accepts `server_ports: ["START:END"]` (colon
      // separator, NOT hyphen, Hiddify URI uses hyphen, sing-box JSON uses
      // colon). When the field is present, sing-box's hysteria2 outbound
      // picks a random port from the range for each connection and rotates
      // it. The `server_port` field is still required as a fallback / initial
      // connect target.
      const portHopRange =
        typeof e.portHoppingStart === 'number' &&
        typeof e.portHoppingEnd === 'number'
          ? [`${e.portHoppingStart}:${e.portHoppingEnd}`]
          : undefined;
      outbounds.push({
        type: 'hysteria2',
        tag,
        server: e.host,
        server_port: e.port,
        ...(portHopRange ? { server_ports: portHopRange } : {}),
        password: e.password,
        // The client's bandwidth claim (clientBandwidthClaim, A-154): the
        // profile's pair turned over when the profile has one, and nothing
        // when it has none. The node runs `ignore_client_bandwidth` (BBR)
        // only for a profile without a bandwidth, and there a claim plays no
        // part; with one it runs Brutal, and each direction takes the lower
        // of the two claims, so a fixed claim here would cap the profile.
        ...(e.upMbps ? { up_mbps: e.upMbps } : {}),
        ...(e.downMbps ? { down_mbps: e.downMbps } : {}),
        ...(e.obfsPassword
          ? { obfs: { type: 'salamander', password: e.obfsPassword } }
          : {}),
        tls: {
          enabled: true,
          // E30a: the panel's self-signed certificate on a node addressed by
          // IP, given as the trust anchor itself with `insecure` off, the form
          // the cascade legs use (cascades/link-tls.ts). sing-box then checks
          // the name against it, so the name is the one in its SAN.
          server_name: e.tlsPin ? e.tlsPin.serverName : e.host,
          // As lines, like the legs' PEM: one string with newlines is taken too.
          ...(e.tlsPin ? { certificate: e.tlsPin.certPem.trim().split(/\r?\n/) } : {}),
          // ALPN h3 is mandatory for some sing-box / Hiddify iOS builds,
          // without it the QUIC stream multiplexer never opens proxy
          // streams even though the QUIC connection itself is fine.
          alpn: ['h3'],
        },
      });
    } else if (isPlainXray(e)) {
      // The Telegram doors: sing-box `socks` (version 5) / `http` outbound with
      // the user's login. No TLS, as on the node.
      proxyTags.push(tag);
      outbounds.push(
        e.subprotocol === 'socks'
          ? {
              type: 'socks',
              tag,
              server: e.host,
              server_port: e.port,
              version: '5',
              username: e.username,
              password: e.password,
            }
          : {
              type: 'http',
              tag,
              server: e.host,
              server_port: e.port,
              username: e.username,
              password: e.password,
            },
      );
    } else if (e.protocol === 'xray') {
      // sing-box's V2Ray transports are http, ws, quic, grpc and httpupgrade
      // (sing-box.sagernet.org/configuration/shared/v2ray-transport, read
      // 22.10: "No mKCP transport", no XHTTP). xhttp and kcp went out with no
      // transport block, that is bare TCP: a line that looked fine and never
      // connected, the REALITY-over-XHTTP default among them (A-133). Left
      // out, as the proxy-line formats leave out what their client lacks.
      // The shared table decides (A-224).
      if (!transportServed('singbox', e)) continue;
      proxyTags.push(tag);
      const sub = e.subprotocol ?? 'vless';
      // securityLayer: 'default' = REALITY, else 'tls' (own cert) / 'none'
      // (plain, e.g. CDN-fronted). REALITY adds the reality block; tls is a
      // plain TLS block; none omits tls entirely.
      const sec = e.securityLayer ?? 'default';
      const isReality = sec === 'default';
      const useTls = sec !== 'none';

      // Transport selector. raw needs no explicit transport block; others do.
      const transport =
        e.network === 'ws'
          ? {
              transport: {
                type: 'ws',
                ...(e.path ? { path: e.path } : {}),
                ...(e.hostHeader ? { headers: { Host: e.hostHeader } } : {}),
              },
            }
          : e.network === 'httpupgrade'
            ? {
                transport: {
                  type: 'httpupgrade',
                  ...(e.path ? { path: e.path } : {}),
                  ...(e.hostHeader ? { host: e.hostHeader } : {}),
                },
              }
            : e.network === 'grpc'
              ? {
                  transport: {
                    type: 'grpc',
                    service_name: e.serviceName ?? '',
                  },
                }
              : {};

      let xrayTls: Record<string, unknown> | undefined;
      if (useTls) {
        xrayTls = {
          enabled: true,
          server_name: e.sni,
          utls: { enabled: true, fingerprint: e.fingerprint },
        };
        // REALITY material only for the reality layer.
        if (isReality) {
          xrayTls.reality = {
            enabled: true,
            public_key: e.publicKey,
            short_id: e.shortId,
          };
        }
        if (e.alpn && e.alpn.length > 0) xrayTls.alpn = e.alpn;
        if (e.allowInsecure) xrayTls.insecure = true;
      }

      // Per-subprotocol fields. VMess: AEAD (alter_id 0) + client cipher.
      const proto =
        sub === 'trojan'
          ? { type: 'trojan', password: e.uuid }
          : sub === 'vmess'
            ? { type: 'vmess', uuid: e.uuid, security: 'auto', alter_id: 0 }
            : {
                type: 'vless',
                uuid: e.uuid,
                // Vision flow: one rule for every format, see emitsVisionFlow.
                ...(emitsVisionFlow(e) ? { flow: e.flow } : {}),
              };

      outbounds.push({
        ...proto,
        tag,
        server: e.host,
        server_port: e.port,
        ...(xrayTls ? { tls: xrayTls } : {}),
        ...transport,
      });
    } else if (e.protocol === 'shadowsocks') {
      // Slice 24d: Shadowsocks 2022 (and legacy AEAD). No TLS layer; the
      // AEAD ciphertext is the disguise. method+password drives the outbound.
      proxyTags.push(tag);
      outbounds.push({
        type: 'shadowsocks',
        tag,
        server: e.host,
        server_port: e.port,
        method: e.method,
        password: e.password,
        // `network` stays unset: sing-box then enables tcp AND udp. Pinning it
        // to 'tcp' switches UDP off in the outbound ("UDP is not supported by
        // outbound", verified on 1.13.19 against a 1.13 shadowsocks inbound), so
        // DNS, QUIC and calls through this endpoint went nowhere. Measured: with
        // 'tcp' no reply, with the key absent or 'udp' the reply arrives.
        udp_over_tcp: false,
      });
    } else if (e.protocol === 'tuic') {
      // TUIC v5 (sing-box engine). QUIC + mandatory TLS; self-signed cert in
      // the alpha so insecure=true. uuid+password auth, native UDP relay.
      proxyTags.push(tag);
      outbounds.push({
        type: 'tuic',
        tag,
        server: e.host,
        server_port: e.port,
        uuid: e.uuid,
        password: e.password,
        congestion_control: e.congestionControl || 'bbr',
        udp_relay_mode: 'native',
        tls: {
          enabled: true,
          server_name: e.serverName,
          alpn: ['h3'],
          insecure: true,
        },
      });
    } else if (e.protocol === 'anytls') {
      // AnyTLS (sing-box engine). TCP+TLS, password-only; self-signed cert in
      // the alpha so insecure=true.
      proxyTags.push(tag);
      outbounds.push({
        type: 'anytls',
        tag,
        server: e.host,
        server_port: e.port,
        password: e.password,
        tls: {
          enabled: true,
          server_name: e.serverName,
          insecure: true,
        },
      });
    } else if (e.protocol === 'shadowtls') {
      // ShadowTLS v3 (sing-box engine). The client uses a shadowsocks outbound
      // that `detour`s through a shadowtls outbound (the latter does the real
      // TLS handshake to the camouflage host). Two outbounds; the ss one is the
      // selectable proxy, the shadowtls one is its dialer.
      proxyTags.push(tag);
      const stlsTag = `${tag}-stls`;
      outbounds.push({
        type: 'shadowsocks',
        tag,
        method: e.ssMethod,
        password: e.ssPassword,
        detour: stlsTag,
        // ShadowTLS carries TCP and only TCP, so UDP-over-TCP is the whole of
        // this channel's UDP; without it QUIC, calls and games vanish while TCP
        // keeps working. `network` is left unset: pinning it to 'tcp' makes
        // the flag moot.
        udp_over_tcp: true,
      });
      outbounds.push({
        type: 'shadowtls',
        tag: stlsTag,
        server: e.host,
        server_port: e.port,
        version: 3,
        password: e.shadowtlsPassword,
        tls: {
          enabled: true,
          server_name: e.handshake,
          utls: { enabled: true, fingerprint: 'chrome' },
        },
      });
    }
  }

  // A-236 step 3: the nodes go into the frame, the operator's template or the
  // Default (templates.defaults.ts, the shape this builder always wrote: a
  // single tun inbound, a selector, direct, route.final; no `dns` (a split
  // preset adds one in fillSingboxFrame), no `experimental`, no mixed/socks/http inbound, which would open a localhost
  // proxy port). Slice 29's `?bundle=url-test` swaps the Default's selector
  // for a url-test group; a template of the operator's has its own groups and
  // the bundle does not touch them.
  const frame =
    opts.frame ?? (opts.bundle === 'url-test' ? urltestDefault(opts) : defaultFrame('singbox'));
  const splitPreset = opts.ownPresetRules ? null : (opts.routingPreset ?? 'proxy-all');
  return (
    fillSingboxFrame(frame, outbounds, proxyTags, deviceRules, {
      preset: splitPreset,
      strategy: singboxDnsStrategy(exitsHaveIpv6(endpoints)),
      geo: opts.geo,
      extRefs: opts.extRefs,
      dnsRules: opts.dnsRules,
    }) + '\n'
  );
}

const REGIONAL_DNS_TAG = 'dns-regional';
const REGIONAL_DNS_SERVER: Partial<Record<RoutingPresetId, string>> = { 'ru-split': '77.88.8.8', 'cn-split': '223.5.5.5' };

const LOCAL_DNS_TAG = 'dns-local';

/**
 * The `dns` block and the server `route.default_domain_resolver` names, or null
 * for none. A built-in split preset has the regional half (its `geosite-*` rule
 * sets, the domains that go direct, resolved by the regional server); the
 * operator's DNS rules (milestone 19.6, `operator`) stand in front of it in
 * `dns.rules`, so a name both name goes to the operator's server wholly. With no
 * regional half the block exists only for operator rules, and the default
 * resolver for the proxy's own host name is the system one (`local`): there is
 * no regional server to take that part. `routeRules` are the preset's rendered
 * route rules.
 */
function dnsBlock(
  preset: RoutingPresetId | null,
  routeRules: readonly Record<string, unknown>[],
  proxyTag: string,
  strategy: string | undefined,
  operator: { servers: Record<string, unknown>[]; rules: Record<string, unknown>[] },
): { dns: Record<string, unknown>; resolver: string } | null {
  const server = preset ? REGIONAL_DNS_SERVER[preset] : undefined;
  const regionalSets = server
    ? routeRules.flatMap((r) =>
        r.outbound === 'direct' ? asArray(r.rule_set).filter((t): t is string => typeof t === 'string' && t.startsWith('geosite-')) : [],
      )
    : [];
  const regional = server !== undefined && regionalSets.length > 0;
  if (!regional && operator.rules.length === 0) return null;
  return {
    dns: {
      servers: [
        regional ? { type: 'udp', tag: REGIONAL_DNS_TAG, server } : { type: 'local', tag: LOCAL_DNS_TAG },
        { type: 'https', tag: 'dns-proxy', server: '1.1.1.1', detour: proxyTag },
        ...operator.servers,
      ],
      rules: [...operator.rules, ...(regional ? [{ rule_set: regionalSets, server: REGIONAL_DNS_TAG }] : [])],
      final: 'dns-proxy',
      ...(strategy ? { strategy } : {}),
    },
    resolver: regional ? REGIONAL_DNS_TAG : LOCAL_DNS_TAG,
  };
}

/** One route rule and one remote rule-set per `ext:` link; `proxy` goes where route.final goes, and is left out with no proxy. */
function extRuleSets(
  refs: readonly SingboxExtRef[],
  proxyOutbound: string | null,
): { rules: Record<string, unknown>[]; ruleSets: Record<string, unknown>[] } {
  const rules: Record<string, unknown>[] = [];
  const sets = new Map<string, Record<string, unknown>>();
  for (const bucket of ['block', 'direct', 'proxy'] as const) {
    const action =
      bucket === 'block'
        ? { action: 'reject' }
        : bucket === 'direct'
          ? { action: 'route', outbound: 'direct' }
          : proxyOutbound
            ? { action: 'route', outbound: proxyOutbound }
            : null;
    const mine = refs.filter((r) => r.bucket === bucket);
    if (!action || mine.length === 0) continue;
    for (const r of mine) sets.set(r.tag, { type: 'remote', tag: r.tag, format: 'binary', url: r.url });
    rules.push({ rule_set: mine.map((r) => r.tag), ...action });
  }
  return { rules, ruleSets: [...sets.values()] };
}

const GROUP_TYPES = new Set(['selector', 'urltest']);

/** The Default with Slice 29's url-test group in place of the selector. */
function urltestDefault(opts: SingboxBuildOpts): Frame {
  const f = structuredClone(defaultFrame('singbox'));
  f.outbounds = asArray(f.outbounds).map((o) =>
    asObject(o).type === 'selector'
      ? {
          type: 'urltest',
          tag: 'Auto-URLTest',
          outbounds: [],
          url: opts.urltestProbeUrl ?? 'https://www.gstatic.com/generate_204',
          interval: `${opts.urltestIntervalSec ?? 300}s`,
          tolerance: 50,
        }
      : o,
  );
  f.route = { ...asObject(f.route), final: 'Auto-URLTest' };
  return f;
}

/**
 * The nodes into a sing-box frame:
 *   - their outbounds go first in `outbounds`;
 *   - every `selector` and `urltest` group gets the node tags in front of its
 *     own members, and a selector with no `default` gets the first node;
 *   - with no node at all, the groups that would hold them go, and every
 *     reference to one (route.final, a rule's outbound) becomes `direct`;
 *   - `iceslab.routing: preset` puts the preset's rules and rule-sets ahead of
 *     the frame's own; a `proxy` rule goes where route.final goes;
 *   - the same switch with a node and no `dns` of the frame's own adds the DNS
 *     block (below) and `route.default_domain_resolver`: under a built-in split
 *     preset always, otherwise (proxy-all, an own preset) only when DNS rules
 *     are in force. The rules then also get the DNS hijack (below).
 *
 * Split DNS, in the one shape every release that can read this config accepts.
 * Measured by the fork with `sing-box check`: 1.11.15 rejects the subscription
 * regardless (`unknown outbound type: anytls`); 1.12.9 warns on the legacy
 * `address:` form, 1.13.19 errors on it, 1.14.0 removed it; the typed form plus
 * `default_domain_resolver` is accepted by all of them. So there is one form to
 * write. The regional server is reached directly and by address (a name would
 * need resolving first); everything else goes over DoH through the proxy, so
 * the query is neither readable nor answerable on the local wire. The rule sets
 * the DNS rule names are the ones `route` already declares, taken from
 * singboxDeviceRoute's own output. `default_domain_resolver` points at the
 * regional server: it resolves the proxy's own hostname, which must not depend
 * on the proxy. `check` proves the config loads, not that resolution behaves.
 *
 * DNS rules (milestone 19.6, stage 19): one typed server per distinct server
 * string with `detour` on the proxy (a server through the tunnel needs it:
 * m19-01), one `dns.rules` entry per rule, ahead of the regional one. `dns.rules`
 * apply only to queries sing-box itself takes, so `route.rules` opens with a
 * `hijack-dns` rule (and a `sniff` limited to `dns` ahead of it, which is what
 * lets `protocol: dns` match) unless the frame has its own; without it an app's
 * query goes raw through the proxy to the resolver it asked. The `geosite:` sets
 * the rules name are declared in `route.rule_set` once, whoever else names them.
 * With no rules the output is what it was.
 * JSON.stringify with two spaces, as this builder always wrote.
 */
function fillSingboxFrame(
  frame: Frame,
  proxyOutbounds: Record<string, unknown>[],
  proxyTags: string[],
  deviceRules: readonly DeviceRouteRule[],
  dnsOpts: {
    preset: RoutingPresetId | null;
    strategy: string | undefined;
    geo?: SelfHostedGeo | null;
    extRefs?: readonly SingboxExtRef[];
    dnsRules?: readonly DnsRule[];
  },
): string {
  const { cfg, routing } = openFrame(frame);
  const own = asArray(cfg.outbounds).map(asObject);
  const gone = new Set<string>();
  const groups = own.flatMap((o) => {
    if (!GROUP_TYPES.has(String(o.type))) return [o];
    if (proxyTags.length === 0) {
      gone.add(String(o.tag));
      return [];
    }
    o.outbounds = [...proxyTags, ...asArray(o.outbounds)];
    if (o.type === 'selector' && o.default === undefined) o.default = proxyTags[0];
    return [o];
  });
  cfg.outbounds = [...proxyOutbounds, ...groups];

  const route = asObject(cfg.route);
  if (typeof route.final === 'string' && gone.has(route.final)) route.final = 'direct';
  const ownRules = asArray(route.rules).map((r) => {
    const rule = asObject(r);
    return typeof rule.outbound === 'string' && gone.has(rule.outbound) ? { ...rule, outbound: 'direct' } : rule;
  });
  const target = proxyTags.length > 0 && typeof route.final === 'string' ? route.final : null;
  const preset = routing ? singboxDeviceRoute(deviceRules, target, dnsOpts.geo) : { rules: [], ruleSets: [] };
  // The operator's `ext:` lists come before the preset's rules, block first, as the clash rules do.
  const ext = routing ? extRuleSets(dnsOpts.extRefs ?? [], target) : { rules: [], ruleSets: [] };
  const operator =
    routing && target && cfg.dns === undefined
      ? singboxDnsRules(dnsOpts.dnsRules ?? [], target, dnsOpts.geo)
      : { servers: [], rules: [], ruleSets: [] };
  const block = routing && target && cfg.dns === undefined ? dnsBlock(dnsOpts.preset, preset.rules, target, dnsOpts.strategy, operator) : null;
  const dns = block?.dns ?? null;
  // The hijack goes first: nothing of the frame's may route a DNS query away before it.
  const hijack =
    operator.rules.length > 0 && !ownRules.some((r) => r.action === 'hijack-dns')
      ? [
          ...(ownRules.some((r) => r.action === 'sniff') ? [] : [{ action: 'sniff', sniffer: ['dns'] }]),
          { protocol: 'dns', action: 'hijack-dns' },
        ]
      : [];
  const rules = [...hijack, ...ext.rules, ...preset.rules, ...ownRules];
  const declared = [...ext.ruleSets, ...preset.ruleSets.filter((s) => !ext.ruleSets.some((e) => e.tag === s.tag)), ...asArray(route.rule_set)];
  const ruleSets = [...declared, ...operator.ruleSets.filter((s) => !declared.some((e) => asObject(e).tag === s.tag))];
  const rest = Object.fromEntries(Object.entries(route).filter(([k]) => k !== 'rules' && k !== 'rule_set'));
  if (cfg.route !== undefined || rules.length > 0) {
    cfg.route = {
      ...(rules.length > 0 ? { rules, ...(ruleSets.length > 0 ? { rule_set: ruleSets } : {}) } : {}),
      ...(dns && rest.default_domain_resolver === undefined ? { default_domain_resolver: block!.resolver } : {}),
      ...rest,
    };
  }
  // Right after `log`, where a hand-written config keeps it.
  return JSON.stringify(dns ? insertAfter(cfg, 'log', 'dns', dns) : cfg, null, 2);
}
