import type { RoutingPresetId } from '@iceslab/shared';
import {
  cannotCarryTransport,
  emitsVisionFlow,
  cannotCarryVlessEncryption,
  type SubscriptionEndpoint,
} from '../subscription.formats.js';

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
 * AmneziaWG/WireGuard/Naive are NOT emitted: both wg flavours get the wg-quick
 * `.conf` format; Naive users get the `naive+https` URI directly. AmneziaWG
 * has no representation here at all (sing-box's `wireguard` outbound lacks the
 * obfuscation params) and `naive` doesn't exist upstream. Plain WireGuard
 * *could* be emitted, but sing-box moved it from `outbounds` to `endpoints` in
 * 1.11, so one shape or the other breaks silently depending on the client's
 * version, whereas the `.conf` every WireGuard app already imports does not.
 *
 * Output shape - minimal valid sing-box config:
 *   - `log`: standard
 *   - `outbounds`: per-endpoint proxies + Auto selector + direct
 *   - `route.final = "Auto"`: catch-all sends every connection through the
 *     selector. `auto_detect_interface: true` lets sing-box hop networks
 *     without restart.
 *
 * A single minimal `tun` inbound (see buildSingboxJson); no `dns`, no
 * `experimental`, the client app fills those in. That keeps the body short and
 * avoids drift across sing-box versions.
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
  /**
   * G6 - when set, the split preset's remote .srs rule-sets are fetched from
   * this self-hosted base (PUBLIC_URL/geo/<token>) instead of SagerNet's GitHub
   * (unstable from RU). Each rule-set's url becomes `${geoBaseUrl}/${tag}.srs`
   * (the tag already matches the generated filename). Undefined = the external
   * SagerNet default = byte-identical output.
   */
  geoBaseUrl?: string;
  /**
   * Names of the artifacts the panel's current geo build actually produced.
   * Only rule-sets whose `<tag>.srs` is present are rewritten - a 404 remote
   * rule-set URL fails sing-box startup, so a missing one keeps its external
   * default. Undefined = rewrite everything (trust the caller).
   */
  geoArtifacts?: ReadonlySet<string>;
  /**
   * G6b - operator custom categories to route, each `ext:<file>:<cat>` ref from
   * the subscription's custom domain lists mapped to a bucket. Unlike the
   * standard split presets there is NO external default for these (they exist
   * only on the panel), so each is emitted as a self-hosted remote rule-set
   * `custom-<cat>.srs` ONLY when geoBaseUrl is set and that artifact is present
   * (geoArtifacts). Empty/undefined = nothing added (byte-identical output).
   */
  customGeoRefs?: ReadonlyArray<CustomGeoRef>;
}

/** One operator custom category + where matched traffic egresses. */
export interface CustomGeoRef {
  cat: string;
  bucket: 'direct' | 'proxy' | 'block';
}

// Rewrite each rule-set's url to the self-hosted `${base}/${tag}.srs` when a geo
// base is configured; otherwise return the external (SagerNet) defaults.
function withGeoBase(
  ruleSets: ReadonlyArray<Record<string, unknown>>,
  geoBaseUrl?: string,
  available?: ReadonlySet<string>,
): ReadonlyArray<Record<string, unknown>> {
  if (!geoBaseUrl) return ruleSets;
  const base = geoBaseUrl.replace(/\/+$/, '');
  return ruleSets.map((rs) => {
    const file = `${String(rs.tag)}.srs`;
    if (available && !available.has(file)) return rs;
    return { ...rs, url: `${base}/${file}` };
  });
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
 * Split DNS (R2) is deliberately NOT emitted for sing-box: the DNS server
 * format was reworked in 1.12 (typed servers replace address strings) and
 * the DNS-rule address filters again in 1.14 - any single shape we pick
 * breaks a real slice of installed clients. The route rules above already
 * split by destination; resolution stays with the client app's own DNS
 * config (clash/xrayjson formats do carry split DNS, see R2 in ROADMAP).
 */
const RU_SPLIT_RULE_SETS: ReadonlyArray<Record<string, unknown>> = [
  {
    type: 'remote',
    tag: 'geosite-category-ads-all',
    format: 'binary',
    url: 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-category-ads-all.srs',
  },
  {
    type: 'remote',
    tag: 'geosite-category-ru',
    format: 'binary',
    url: 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-category-ru.srs',
  },
  {
    type: 'remote',
    tag: 'geosite-category-gov-ru',
    format: 'binary',
    url: 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-category-gov-ru.srs',
  },
  {
    type: 'remote',
    tag: 'geoip-ru',
    format: 'binary',
    url: 'https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-ru.srs',
  },
];

const RU_SPLIT_RULES: ReadonlyArray<Record<string, unknown>> = [
  { rule_set: ['geosite-category-ads-all'], action: 'reject' },
  { ip_is_private: true, action: 'route', outbound: 'direct' },
  {
    rule_set: ['geosite-category-ru', 'geosite-category-gov-ru', 'geoip-ru'],
    action: 'route',
    outbound: 'direct',
  },
];

/**
 * H2 - the China mirror of the RU rule-sets. `geosite-cn.srs` (SagerNet/
 * sing-geosite) is the single comprehensive mainland category, so one geosite
 * set, not two; `geoip-cn.srs` from SagerNet/sing-geoip. Same `.srs` URL
 * pattern as RU. As with ru-split, split DNS is deliberately omitted (the
 * sing-box DNS server format churned across 1.12/1.14).
 */
const CN_SPLIT_RULE_SETS: ReadonlyArray<Record<string, unknown>> = [
  {
    type: 'remote',
    tag: 'geosite-category-ads-all',
    format: 'binary',
    url: 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-category-ads-all.srs',
  },
  {
    type: 'remote',
    tag: 'geosite-cn',
    format: 'binary',
    url: 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-cn.srs',
  },
  {
    type: 'remote',
    tag: 'geoip-cn',
    format: 'binary',
    url: 'https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs',
  },
];

const CN_SPLIT_RULES: ReadonlyArray<Record<string, unknown>> = [
  { rule_set: ['geosite-category-ads-all'], action: 'reject' },
  { ip_is_private: true, action: 'route', outbound: 'direct' },
  {
    rule_set: ['geosite-cn', 'geoip-cn'],
    action: 'route',
    outbound: 'direct',
  },
];

/** RAW/WS/gRPC/HTTPUpgrade. See `cannotCarryTransport`. */
const SINGBOX_TRANSPORTS = ['raw', 'ws', 'grpc', 'httpupgrade'] as const;

export function buildSingboxJson(
  endpoints: SubscriptionEndpoint[],
  opts: SingboxBuildOpts = {},
): string {
  const outbounds: Record<string, unknown>[] = [];
  const proxyTags: string[] = [];
  // Routing preset (R1b + H2). Each split preset selects its own route rules +
  // remote rule-sets; proxy-all leaves them null so the output stays
  // byte-identical to pre-R1 builds.
  const preset = opts.routingPreset ?? 'proxy-all';
  const splitRules =
    preset === 'ru-split'
      ? RU_SPLIT_RULES
      : preset === 'cn-split'
        ? CN_SPLIT_RULES
        : null;
  const splitRuleSets =
    preset === 'ru-split'
      ? withGeoBase(RU_SPLIT_RULE_SETS, opts.geoBaseUrl, opts.geoArtifacts)
      : preset === 'cn-split'
        ? withGeoBase(CN_SPLIT_RULE_SETS, opts.geoBaseUrl, opts.geoArtifacts)
        : null;

  for (const e of endpoints) {
    const tag = `${e.nodeName}-${e.protocol}`;
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
        // Brutal CC bandwidth declaration. Without these the client
        // negotiates a 0-byte send window, handshake succeeds but every
        // proxied request times out at tx=0. The server can override via
        // `ignoreClientBandwidth: true` (recommended default in our
        // adapter), but supplying real values here keeps Brutal CC active
        // when the server does honour client bandwidth.
        up_mbps: e.upMbps ?? 50,
        down_mbps: e.downMbps ?? 100,
        ...(e.obfsPassword
          ? { obfs: { type: 'salamander', password: e.obfsPassword } }
          : {}),
        tls: {
          enabled: true,
          server_name: e.host,
          // ALPN h3 is mandatory for some sing-box / Hiddify iOS builds,
          // without it the QUIC stream multiplexer never opens proxy
          // streams even though the QUIC connection itself is fine.
          alpn: ['h3'],
          // Set when sing-box serves the inbound: that path holds the same
          // self-signed certificate as TUIC and AnyTLS below, and those two
          // have always said so. See the hysteria branch of the subscription
          // service for the measurement.
          ...(e.allowInsecure ? { insecure: true } : {}),
        },
      });
    } else if (e.protocol === 'xray') {
      // U5: sing-box's VLESS outbound has no `encryption` field at all
      // (option/vless.go), so an inbound running VLESS-Encryption cannot be
      // described here. Skipping beats emitting an outbound whose every
      // handshake the node rejects.
      if (cannotCarryVlessEncryption(e)) continue;
      // sing-box has no XHTTP - refused upstream on purpose, "no plan" from the
      // maintainer - and no mKCP. Both used to fall through the `ws`/`grpc`
      // check below into an outbound with NO transport block, which sing-box
      // dials as plain TCP: an entry that imports cleanly and cannot ever reach
      // the server.
      if (cannotCarryTransport(e, SINGBOX_TRANSPORTS)) continue;
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
                // Vision flow needs a TLS-like layer (reality or tls), not none.
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
        // SS2022 supports UDP relay; sing-box defaults `network: tcp` so
        // we must enable UDP explicitly to match what the server emits.
        network: 'tcp',
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
        network: 'tcp',
        udp_over_tcp: false,
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

  // Slice 29: `url-test` group (auto-failover by latency). Default still
  // emits the legacy `selector` so manual-pick UIs (Hiddify "Connect to:")
  // keep working; admins flip to url-test via `?bundle=url-test`.
  const bundle = opts.bundle ?? 'selector';
  let primaryTag = 'direct';
  if (proxyTags.length > 0) {
    if (bundle === 'url-test') {
      outbounds.push({
        type: 'urltest',
        tag: 'Auto-URLTest',
        outbounds: proxyTags,
        url: opts.urltestProbeUrl ?? 'https://www.gstatic.com/generate_204',
        interval: `${opts.urltestIntervalSec ?? 300}s`,
        tolerance: 50,
      });
      primaryTag = 'Auto-URLTest';
    } else {
      outbounds.push({
        type: 'selector',
        tag: 'Auto',
        outbounds: [...proxyTags, 'direct'],
        default: proxyTags[0],
      });
      primaryTag = 'Auto';
    }
  }
  outbounds.push({ type: 'direct', tag: 'direct' });

  // G6b - operator custom categories as self-hosted remote rule-sets. A plain
  // inline domain still has no portable sing-box vehicle post-1.12, but an
  // `ext:<file>:<cat>` ref does: the panel serves `custom-<cat>.srs`. Emitted
  // only when self-hosting is on AND the artifact is present (a 404 remote
  // rule-set bricks sing-box startup). Bucket -> action mirrors the xray/clash
  // custom lists: direct -> route direct, block -> reject, proxy -> the tunnel.
  const customRuleSets: Record<string, unknown>[] = [];
  const customRules: Record<string, unknown>[] = [];
  if (opts.geoBaseUrl && opts.customGeoRefs && opts.customGeoRefs.length > 0) {
    const base = opts.geoBaseUrl.replace(/\/+$/, '');
    const emitted = new Set<string>();
    for (const ref of opts.customGeoRefs) {
      // The panel stores/serves a composed category under its UPPERCASED name
      // (geo.compose composeCategory -> name.toUpperCase()), so the artifact is
      // `custom-<UPPER>.srs`. Normalise the ref here so file/tag/url match it -
      // otherwise a lowercase-authored ext:ref (the common case) never matches
      // geoArtifacts and the category is silently dropped.
      const cat = ref.cat.toUpperCase();
      const file = `custom-${cat}.srs`;
      if (opts.geoArtifacts && !opts.geoArtifacts.has(file)) continue;
      const tag = `custom-${cat}`;
      if (!emitted.has(tag)) {
        customRuleSets.push({ type: 'remote', tag, format: 'binary', url: `${base}/${file}` });
        emitted.add(tag);
      }
      customRules.push(
        ref.bucket === 'block'
          ? { rule_set: [tag], action: 'reject' }
          : ref.bucket === 'direct'
            ? { rule_set: [tag], action: 'route', outbound: 'direct' }
            : { rule_set: [tag], action: 'route', outbound: primaryTag },
      );
    }
  }

  // Operator custom rules take precedence over the broad split preset (first
  // match wins), so they come first. Empty custom lists -> byte-identical output.
  const routeRules = [...customRules, ...(splitRules ?? [])];
  const routeRuleSets = [...(splitRuleSets ?? []), ...customRuleSets];

  // R3 - plain inline domains are still NOT emitted for sing-box (no portable
  // post-1.12 vehicle); only ext: custom-category refs above are. xray/xkeen +
  // clash carry the plain lists.
  const config = {
    log: { level: 'info', timestamp: true },
    // A single minimal tun inbound. Happ and the sing-box CLI reject a config
    // with no `inbounds` as invalid and fall back to the routing-less plain
    // format; Hiddify/NekoBox inject their own OS-managed tun and override this,
    // so they are unaffected. Deliberately NO mixed/socks/http inbound: that
    // would open a listening localhost proxy port (a leak surface). tun only.
    inbounds: [
      {
        type: 'tun',
        tag: 'tun-in',
        address: ['172.18.0.1/30', 'fdfe:dcba:9876::1/126'],
        auto_route: true,
        strict_route: false,
        stack: 'mixed',
      },
    ],
    outbounds,
    route: {
      ...(routeRules.length > 0 ? { rules: routeRules, rule_set: routeRuleSets } : {}),
      final: primaryTag,
      auto_detect_interface: true,
    },
  };
  return JSON.stringify(config, null, 2) + '\n';
}
