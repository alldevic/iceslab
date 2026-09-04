import type { RoutingPresetId } from '@iceslab/shared';
import {
  emitsVisionFlow,
  expandCascadeExits,
  type SubscriptionEndpoint,
} from '../subscription.formats.js';

/**
 * Xray-core client JSON subscription formatter.
 *
 * Targets v2rayN, NekoRay/NekoBox in Xray mode, and any client that imports
 * "Xray JSON" subscription URLs (i.e. apps that run xray-core under the hood).
 *
 * Scope: VLESS+REALITY+Vision endpoints only. Hysteria2 is reachable from
 * Xray (via the `hysteria2` outbound) but most Xray-native clients still
 * default to vmess/vless, users who want Hysteria pick the Sing-box format
 * or the plain hysteria2:// URI directly. Keeping this format VLESS-only
 * dodges the cross-protocol matrix and avoids subtle xray-version-coupled
 * outbound shape drift.
 *
 * Output shape:
 *   - `log`: warning-level
 *   - `inbounds`: a single SOCKS5 inbound on 127.0.0.1:10808 (UDP enabled)
 *     so local apps can dial through the tunnel
 *   - `outbounds`: one vless+REALITY entry per endpoint, plus `freedom`
 *     (`direct`) and `blackhole` (`block`) for routing rules
 *   - `routing`: catch-all → first proxy. The client UI lets the user pick
 *     a different outbound by tag.
 */
/**
 * Slice 29 follow-up: Xray `observatory + balancer` for auto-failover.
 * When `bundle === 'balancer'`, we emit an `observatory` block that periodically
 * probes every proxy outbound, and route through a balancer-tagged tag that
 * picks the lowest-latency one. Default ('flat') keeps the legacy "first
 * outbound wins" routing rule for back-compat.
 */
/**
 * TLS-fragment - when `tlsFragment` is on we emit a `freedom` outbound carrying
 * a `fragment` object and dial every proxy outbound THROUGH it via
 * `streamSettings.sockopt.dialerProxy`. This splits the client's outgoing
 * ClientHello so SNI-based DPI (RU TSPU / RKN) cannot cleanly match the
 * handshake. Defaults mirror the upstream-verified shape:
 * packets="tlshello" (fragments the TLS handshake), length="100-200",
 * interval="10-20". The fragment outbound's tag MUST exactly equal the
 * dialerProxy value; we pick a tag that cannot collide with any proxy/direct/
 * block tag. When off, the output stays byte-identical to pre-fragment builds.
 */
/**
 * Routing Templates (R1a + H2) - a split `routingPreset` prepends split-routing
 * rules ahead of the catch-all: ads/malware -> block, region domains + region/
 * private IPs -> direct, everything else falls through to the tunnel.
 *   - `ru-split`: RU domains (geosite:category-ru + category-gov-ru) + geoip:ru.
 *   - `cn-split`: China domains (geosite:cn) + geoip:cn (single comprehensive
 *     category, so one domain rule not two), clean DNS via AliDNS 223.5.5.5.
 * Uses the geosite:/geoip: databases that ship inside every xray client
 * install, so no extra files are needed. `domainStrategy` switches to
 * IPOnDemand so the preset's geoip:ru / geoip:cn rule can fire at all - see the
 * comment on routing.domainStrategy below for why IPIfNonMatch, the obvious
 * choice, is dead here. Default 'proxy-all' keeps the output byte-identical to
 * pre-R1 builds.
 */
export interface XrayJsonBuildOpts {
  bundle?: 'flat' | 'balancer';
  probeUrl?: string;
  probeIntervalSec?: number;
  routingPreset?: RoutingPresetId;
  /**
   * XKeen / router target (`?format=xkeen`). XKeen runs xray-core on a Keenetic
   * router via a confdir split (01_log / 02_dns / 03_inbounds / 04_outbounds /
   * 05_routing ...). The router supplies its own log + transparent inbound, so
   * we omit `log` and `inbounds` and emit only outbounds + routing (+ split-DNS
   * when ru-split). The result is a drop-in for the router's 04_outbounds +
   * 05_routing (+ 02_dns) files. All the REALITY/transport/balancer logic is
   * shared with the desktop xrayjson format.
   */
  forRouter?: boolean;
  /**
   * R3-b - raw custom xray routing rules (operator-authored), prepended ahead
   * of the preset rules + catch-all so they take precedence. Each entry is a
   * literal xray routing-rule object referencing the tags this builder emits
   * (`direct`, `block`, or a proxy tag). Empty/undefined = none.
   */
  customRules?: Record<string, unknown>[];
  /**
   * R3 - operator-defined custom domain lists (direct/proxy/block). Each
   * non-empty bucket becomes one field rule (domain array -> outboundTag),
   * slotted between the raw `customRules` and the preset rules. block wins over
   * direct/proxy on an overlapping domain (block rule is emitted first).
   * Empty/undefined = none = byte-identical output.
   */
  customDomainLists?: { direct: string[]; proxy: string[]; block: string[] };
  /**
   * TLS-fragment - when true, append a `freedom` outbound carrying a `fragment`
   * object and set `sockopt.dialerProxy` on every proxy outbound so the
   * ClientHello is split before it leaves the client. Default false keeps the
   * output byte-identical. Xray JSON only (the technique is Xray-native).
   */
  tlsFragment?: boolean;
  /**
   * Preset geo data as literal matchers, keyed by category name. When given,
   * the split preset inlines it instead of naming `geosite:`/`geoip:` — see
   * splitRulesFor for why that matters. Omitted = name the categories, which is
   * all an installation without a geo build can do.
   */
  presetGeoInline?: PresetGeoInline;
  /**
   * 3.15 - require credentials on the local socks/http listeners.
   *
   * Those listeners sit on 127.0.0.1 of the buyer's own device, and on Android
   * loopback is NOT isolated per app: any installed app can open 10808/10809
   * and ride the tunnel, spending the buyer's quota and leaving from their
   * address. Credentials help precisely because the config lives in the VPN
   * client's sandbox, which a hostile app cannot read.
   *
   * Measured with real xray 26.3.27: both listeners ENFORCE this (no or wrong
   * credentials -> socks refuses the handshake, http answers 407), and the
   * noauth pair we ship today answers 200 to anyone.
   *
   * Undefined = omit it entirely = byte-identical output. Default off on
   * purpose: Android's ProxyInfo carries no credential fields, so an
   * authenticated http inbound may break system-proxy mode - the very mode
   * whose breakage cost us a day. Turning this on needs a measurement on a
   * device, not an argument.
   */
  localProxyAuth?: { user: string; pass: string };
}

/** Preset categories as literal xray matchers: domains and IPv4 CIDRs. */
export interface PresetGeoInline {
  domains: Record<string, string[]>;
  cidrs: Record<string, string[]>;
}

// TLS-fragment defaults (upstream-verified). `tlshello` fragments the TLS
// handshake itself, which is what beats SNI-DPI.
const TLS_FRAGMENT_SETTINGS: Record<string, string> = {
  packets: 'tlshello',
  length: '100-200',
  interval: '10-20',
};

/**
 * The local listeners a client binds on the device.
 *
 * SOCKS alone is not enough, and the failure it causes looks like anything but
 * a missing inbound. Happ starts a system HTTP proxy and takes its port from an
 * `http` inbound in the config; with only SOCKS it logs
 * `No HTTP inbound found to start proxy on port 10810`, binds nothing, and the
 * browser answers `ERR_PROXY_CONNECTION_FAILED` — which reads as "the VPN is
 * broken", not as "the document is missing a listener". Reported as "no sites
 * open at all", on both entry transports, by buyers whose app runs in
 * system-proxy mode; buyers whose app runs a TUN never saw it.
 *
 * 10808/10809 is the pair this ecosystem has used since v2rayNG, so a client
 * looking for either finds it where it expects.
 */
function localInbounds(
  auth?: { user: string; pass: string },
): ReadonlyArray<Record<string, unknown>> {
  // `accounts` is what both xray inbounds read; socks additionally needs
  // `auth: 'password'` to stop accepting the anonymous method. `udp` stays on
  // either way - it carries DNS and calls, and dropping it would look like a
  // network fault, not like a credential change.
  const socksSettings = auth
    ? { auth: 'password', accounts: [auth], udp: true }
    : { auth: 'noauth', udp: true };
  const httpSettings = auth ? { accounts: [auth] } : {};
  return [
    {
      tag: 'socks-in',
      port: 10808,
      listen: '127.0.0.1',
      protocol: 'socks',
      settings: socksSettings,
    },
    {
      tag: 'http-in',
      port: 10809,
      listen: '127.0.0.1',
      protocol: 'http',
      settings: httpSettings,
    },
  ];
}

const RU_SPLIT_RULES: ReadonlyArray<Record<string, unknown>> = [
  { type: 'field', domain: ['geosite:category-ads-all'], outboundTag: 'block' },
  {
    type: 'field',
    domain: ['geosite:category-ru', 'geosite:category-gov-ru'],
    outboundTag: 'direct',
  },
  { type: 'field', ip: ['geoip:private', 'geoip:ru'], outboundTag: 'direct' },
];

/**
 * RFC1918 + the rest of what `geoip:private` means, written out.
 *
 * Inlined rather than named because `private` LOOKS like a built-in and is not:
 * xray reads it out of geoip.dat like any other code, so a document naming it
 * fails to load on a client whose .dat lacks it — measured, `code not found in
 * geoip.dat: PRIVATE`.
 */
const PRIVATE_CIDRS: readonly string[] = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '255.255.255.255/32',
];

/**
 * Split DNS (R2). RU domains resolve via Yandex DNS (77.88.8.8) so RU CDNs
 * return geo-correct answers; `skipFallback` keeps those queries off the
 * general resolver. Everything else asks 1.1.1.1. Xray's built-in DNS obeys
 * the routing table above, so the 77.88.8.8 query itself rides direct
 * (matches geoip:ru) while 1.1.1.1 rides the tunnel - no plaintext foreign
 * DNS on the RU wire. Plain-IP servers dodge the DoH bootstrap problem
 * (resolving the resolver's own hostname).
 *
 * Two things here answer the same complaint, and they are separate claims.
 *
 * `queryStrategy` is IPv4-only because the AAAA it would otherwise hand out
 * names a route this deployment cannot carry. Measured 2026-09-03: the cascade
 * exit has ZERO global IPv6 addresses and no IPv6 connectivity, so a client
 * that prefers the AAAA answer sends its first connection into a tunnel with
 * nowhere to put it. Worth being exact about what this does NOT fix: with the
 * strategy unset the AAAA resolved perfectly well (two records for
 * example.com, measured through this very config), so a missing AAAA was never
 * the failure - handing out an unroutable one was.
 *
 * The fallback resolver is DoH, and that is the asymmetry the buyer actually
 * hit. clash has said `https://1.1.1.1/dns-query` since its DNS block was
 * written, sing-box says `type: https` - and this format alone sent a plain
 * UDP query to 1.1.1.1 through the tunnel. A core that does not relay UDP over
 * its outbound (and hy2 in an unknown client build is exactly that kind of
 * unknown) answers every name with `record not found`, which is what xray
 * reports when a query produced no record at all, while TCP through the same
 * tunnel keeps working. That is the reported shape: the tunnel is up, Hiddify
 * on DoH is fine, Happ on UDP resolves nothing. An IP literal, not a hostname,
 * so there is no DoH bootstrap problem to dodge.
 *
 * The strategy value has to be spelled from xray's accepted set: an
 * unrecognised string silently falls back to UseIP rather than failing, so a
 * typo here reads as "did not help" instead of as an error.
 */
const RU_SPLIT_DNS: Record<string, unknown> = {
  queryStrategy: 'UseIPv4',
  servers: [
    {
      address: '77.88.8.8',
      domains: ['geosite:category-ru', 'geosite:category-gov-ru'],
      skipFallback: true,
    },
    'https://1.1.1.1/dns-query',
  ],
};

/**
 * Routing Templates (H2) - `cn-split` is the China-direct mirror of `ru-split`.
 * China is comprehensively covered by the single `geosite:cn` / `geoip:cn`
 * category (no second gov category like RU), so one domain rule, not two.
 * Ads-block, private-range-direct and the catch-all stay identical in shape.
 */
const CN_SPLIT_RULES: ReadonlyArray<Record<string, unknown>> = [
  { type: 'field', domain: ['geosite:category-ads-all'], outboundTag: 'block' },
  { type: 'field', domain: ['geosite:cn'], outboundTag: 'direct' },
  { type: 'field', ip: ['geoip:private', 'geoip:cn'], outboundTag: 'direct' },
];

/**
 * Split DNS (H2). China domains resolve via AliDNS (223.5.5.5) so CN CDNs
 * return geo-correct answers; `skipFallback` keeps those queries off the
 * general resolver. Everything else asks 1.1.1.1. Xray's built-in DNS obeys
 * the routing table above, so the 223.5.5.5 query itself rides direct
 * (matches geoip:cn) while 1.1.1.1 rides the tunnel - no plaintext foreign
 * DNS on the CN wire. Plain-IP server dodges the DoH bootstrap problem (the
 * same rationale as the Yandex IP in RU_SPLIT_DNS).
 */
const CN_SPLIT_DNS: Record<string, unknown> = {
  // Both knobs for the same reasons as RU_SPLIT_DNS: no IPv6 to route an AAAA
  // into, and a resolver behind the tunnel that does not depend on the client
  // relaying UDP.
  queryStrategy: 'UseIPv4',
  servers: [
    {
      address: '223.5.5.5',
      domains: ['geosite:cn'],
      skipFallback: true,
    },
    'https://1.1.1.1/dns-query',
  ],
};

// Preset selectors, shared by the single-config builder and the array (T2) so
// both pick the same split rules / DNS from one place.
/** Which preset categories each split names, so the inline path can look them up. */
const PRESET_CATS: Record<string, { site: string[]; ip: string }> = {
  'ru-split': { site: ['category-ru', 'category-gov-ru'], ip: 'ru' },
  'cn-split': { site: ['cn'], ip: 'cn' },
};

/**
 * The split rules, inlined when the caller could supply the geo data.
 *
 * NAMING a category is a bet on a file we do not control: the client reads
 * whatever .dat it holds, and when that file lacks the category xray refuses to
 * START — not "no ad-blocking", a dead channel. Three buyers hit it, and
 * refreshing the subscription did nothing for them because only the ARTIFACT had
 * been fixed and the document still named the categories.
 *
 * So when the geo build can hand over the matchers, they go in literally and the
 * document stops depending on the client's files. Measured: RU domains 28 KB,
 * RU networks 238 KB, private 15 lines — 266 KB per config.
 *
 * The ads rule is NOT inlined and NOT kept: 148 872 matchers is 4.2 MB per
 * config, and a blocked request has no source address to protect, so that rule
 * belongs on the node — where it costs nothing and covers every client instead
 * of only those holding the right .dat.
 *
 * The IP rule stays because the SOURCE ADDRESS is what it protects. Services
 * that check the caller — banks, Gosuslugi — must see the buyer's own address,
 * and a Russian service on a foreign domain (`pobeda.aero`) is caught by this
 * list and by nothing else. Dropping it would route exactly those through the
 * tunnel and show them a datacenter.
 *
 * With no geo build there is nothing to inline and naming the categories is the
 * only vehicle left, so that stays the fallback.
 */
function splitRulesFor(
  preset: RoutingPresetId,
  inline?: PresetGeoInline,
): ReadonlyArray<Record<string, unknown>> | null {
  const cats = PRESET_CATS[preset];
  if (!cats || !inline) {
    return preset === 'ru-split' ? RU_SPLIT_RULES : preset === 'cn-split' ? CN_SPLIT_RULES : null;
  }
  const domains = cats.site.flatMap((c) => inline.domains[c] ?? []);
  const cidrs = inline.cidrs[cats.ip] ?? [];
  if (domains.length === 0 || cidrs.length === 0) {
    // A half-built geo answer would silently narrow the split, which is worse
    // than naming the categories: at least that fails loudly.
    return preset === 'ru-split' ? RU_SPLIT_RULES : preset === 'cn-split' ? CN_SPLIT_RULES : null;
  }
  return [
    { type: 'field', domain: domains, outboundTag: 'direct' },
    { type: 'field', ip: [...PRIVATE_CIDRS, ...cidrs], outboundTag: 'direct' },
  ];
}

/**
 * The split DNS block, with the same inlining — and it needs it just as much:
 * the regional resolver is scoped by `domains: ['geosite:category-ru', …]`, and
 * a missing category there fails the config exactly like a routing rule does.
 */
function splitDnsFor(
  preset: RoutingPresetId,
  inline?: PresetGeoInline,
): Record<string, unknown> | null {
  const base = preset === 'ru-split' ? RU_SPLIT_DNS : preset === 'cn-split' ? CN_SPLIT_DNS : null;
  const cats = PRESET_CATS[preset];
  if (!base || !cats || !inline) return base;
  const domains = cats.site.flatMap((c) => inline.domains[c] ?? []);
  if (domains.length === 0) return base;
  const servers = (base.servers as unknown[]).map((srv) =>
    srv && typeof srv === 'object' && 'domains' in srv ? { ...(srv as object), domains } : srv,
  );
  return { ...base, servers };
}

/**
 * Build one xray proxy outbound from an endpoint. Extracted from buildXrayJson
 * (T1) so the single-config builder and buildXrayJsonArray emit byte-identical
 * outbounds from one place. The caller owns the proxyTags bookkeeping; the tag
 * is also on the returned object as `.tag`.
 */
function buildProxyOutbound(
  e: SubscriptionEndpoint,
  tlsFragment: boolean,
  fragmentTag: string,
): Record<string, unknown> {
  if (e.protocol !== 'xray') throw new Error('unreachable'); // narrowing
  const tag = `${e.nodeName}-xray`;
  const sub = e.subprotocol ?? 'vless';
  const network = e.network ?? 'raw';
  // securityLayer: 'default' = REALITY, else 'tls' (own cert) / 'none' (plain).
  const sec = e.securityLayer ?? 'default';
  const security = sec === 'default' ? 'reality' : sec;
  const useTls = sec !== 'none';

  // settings block by subprotocol.
  let settings: Record<string, unknown>;
  if (sub === 'trojan') {
    settings = { servers: [{ address: e.host, port: e.port, password: e.uuid }] };
  } else if (sub === 'vmess') {
    settings = {
      vnext: [
        { address: e.host, port: e.port, users: [{ id: e.uuid, security: 'auto', alterId: 0 }] },
      ],
    };
  } else {
    settings = {
      vnext: [
        {
          address: e.host,
          port: e.port,
          // Vision flow needs a TLS-like layer (reality or tls), not none.
          // U5: `encryption` is a per-user field on the VLESS outbound (xray
          // infra/conf/vless.go reads it off the account), so the client string
          // goes here and nowhere else. Absent -> the historical 'none'.
          users: [
            {
              id: e.uuid,
              encryption: e.vlessEncryption || 'none',
              ...(emitsVisionFlow(e) ? { flow: e.flow } : {}),
            },
          ],
        },
      ],
    };
  }

  const streamSettings: Record<string, unknown> = { network, security };
  if (security === 'reality') {
    streamSettings.realitySettings = {
      publicKey: e.publicKey,
      shortId: e.shortId,
      serverName: e.sni,
      fingerprint: e.fingerprint,
      show: false,
      spiderX: '',
      // U5: the client half of post-quantum REALITY. Same key name as
      // xray's own client config (infra/conf/transport_security.go).
      ...(e.realityMldsa65Verify ? { mldsa65Verify: e.realityMldsa65Verify } : {}),
    };
  } else if (security === 'tls') {
    streamSettings.tlsSettings = {
      serverName: e.sni,
      fingerprint: e.fingerprint,
      ...(e.alpn && e.alpn.length > 0 ? { alpn: e.alpn } : {}),
      ...(e.allowInsecure ? { allowInsecure: true } : {}),
    };
  }
  // transport-specific settings.
  if (network === 'ws') {
    streamSettings.wsSettings = {
      ...(e.path ? { path: e.path } : {}),
      ...(e.hostHeader ? { headers: { Host: e.hostHeader } } : {}),
    };
  } else if (network === 'httpupgrade') {
    streamSettings.httpupgradeSettings = {
      ...(e.path ? { path: e.path } : {}),
      ...(e.hostHeader ? { host: e.hostHeader } : {}),
    };
  } else if (network === 'xhttp') {
    // `mode` was pinned to 'auto' here regardless of what the operator chose,
    // and the node renders their choice on the server. That pairing is not a
    // cosmetic mismatch: xray's xhttp server rejects a request whose framing its
    // configured mode disallows (splithttp/hub.go -> HTTP 400), and an `auto`
    // client picks stream-one under REALITY and packet-up without it
    // (splithttp/dialer.go). A REALITY node set to packet-up therefore refused
    // every client this format produced.
    streamSettings.xhttpSettings = {
      ...(e.path ? { path: e.path } : {}),
      ...(e.hostHeader ? { host: e.hostHeader } : {}),
      mode: e.xhttpMode ?? 'auto',
    };
  } else if (network === 'grpc') {
    streamSettings.grpcSettings = { serviceName: e.serviceName ?? '' };
  } else if (network === 'kcp') {
    streamSettings.kcpSettings = { header: { type: 'none' } };
  }

  // TLS-fragment - dial this proxy THROUGH the fragment freedom outbound.
  // Merge into any existing sockopt so we never clobber other fields.
  if (tlsFragment) {
    const existingSockopt =
      (streamSettings.sockopt as Record<string, unknown> | undefined) ?? {};
    streamSettings.sockopt = { ...existingSockopt, dialerProxy: fragmentTag };
  }

  return {
    tag,
    protocol: sub === 'trojan' ? 'trojan' : sub === 'vmess' ? 'vmess' : 'vless',
    settings,
    streamSettings,
  };
}

/**
 * Build a hysteria2 outbound for the array format, in xray-core's client shape
 * (protocol "hysteria", settings.version 2 + address/port,
 * streamSettings.network "hysteria" + hysteriaSettings).
 *
 * VERIFIED 2026-09-03 against the live s1 hysteria2 inbound (sing-box 1.13.19,
 * self-signed cert, Salamander obfs, Brutal 500/500) with xray 26.3.27, one
 * fault removed at a time. The document this function used to produce did not
 * connect at all, and there were THREE independent reasons, each of which
 * looks like a different kind of outage:
 *
 *   1. No obfuscation. The server drops every packet unread, so the client
 *      sees silence and a QUIC idle timeout - the signature of an unreachable
 *      node, not of a bad config. Salamander lives in `finalmask.udp` here.
 *   2. A self-signed certificate with nothing saying to trust it:
 *      `cannot validate certificate ... does not contain any IP SANs`.
 *      `allowInsecure` is REMOVED from this core, not deprecated - a config
 *      carrying it fails to load outright - so the trust is expressed by
 *      pinning the leaf, and the fingerprint has to come from the operator.
 *   3. `up`/`down` in `hysteriaSettings` are the deprecated slot: the core
 *      only warns about them and then advertises `Hysteria-CC-RX: 0`. A
 *      sing-box server that sets its own up/down AND `ignore_client_bandwidth`
 *      answers precisely that request with its masquerade page, which the
 *      client reports as `auth failed`. Nothing about the message suggests
 *      bandwidth. Both are emitted: `quicParams` for cores that moved, the old
 *      pair for cores that have not.
 *
 * Anything this function cannot make connectable is dropped by the caller
 * rather than handed out - see the filter in buildXrayJsonArray.
 */
function buildHysteriaOutbound(e: SubscriptionEndpoint, tag: string): Record<string, unknown> {
  if (e.protocol !== 'hysteria') throw new Error('unreachable'); // narrowing
  const hysteriaSettings: Record<string, unknown> = { version: 2, auth: e.password };
  // Brutal CC bandwidth, unit-suffixed ("100mbps"). Kept in the deprecated slot
  // for cores that still read it; `quicParams` below is where cores that moved
  // read it, and reason 3 above is what happens when only this pair is sent.
  if (typeof e.upMbps === 'number') hysteriaSettings.up = `${e.upMbps}mbps`;
  if (typeof e.downMbps === 'number') hysteriaSettings.down = `${e.downMbps}mbps`;

  const finalmask: Record<string, unknown> = {};
  if (e.obfsPassword) {
    finalmask.udp = [{ type: 'salamander', settings: { password: e.obfsPassword } }];
  }
  if (typeof e.upMbps === 'number' || typeof e.downMbps === 'number') {
    finalmask.quicParams = {
      congestion: 'brutal',
      ...(typeof e.upMbps === 'number' ? { brutalUp: `${e.upMbps}mbps` } : {}),
      ...(typeof e.downMbps === 'number' ? { brutalDown: `${e.downMbps}mbps` } : {}),
    };
  }

  const tlsSettings: Record<string, unknown> = { serverName: e.host };
  // Never `allowInsecure`: it is removed from this core, and a config carrying
  // it does not load. hysteriaOutboundIsUsable is what keeps an endpoint that
  // NEEDS it and has no fingerprint from reaching this point at all.
  if (e.pinnedPeerCertSha256) tlsSettings.pinnedPeerCertSha256 = e.pinnedPeerCertSha256;

  return {
    tag,
    protocol: 'hysteria',
    settings: { version: 2, address: e.host, port: e.port },
    streamSettings: {
      network: 'hysteria',
      security: 'tls',
      tlsSettings,
      hysteriaSettings,
      ...(Object.keys(finalmask).length > 0 ? { finalmask } : {}),
    },
  };
}

/**
 * Whether an endpoint can produce a hysteria outbound that could connect.
 *
 * A hysteria server whose certificate the client is asked to skip verifying
 * has no way to say so in this format any more, so what the panel would emit
 * is a server entry that fails certificate validation on every client reading
 * it. That is worse than no entry: the buyer sees a channel, tries it, and
 * concludes the VPN is broken. Same rule as the port-hopping range the node
 * does not confirm - what the panel cannot make work, it does not promise.
 */
function hysteriaOutboundIsUsable(e: SubscriptionEndpoint): boolean {
  if (e.protocol !== 'hysteria') return true;
  return !e.allowInsecure || Boolean(e.pinnedPeerCertSha256);
}

export function buildXrayJson(
  endpoints: SubscriptionEndpoint[],
  opts: XrayJsonBuildOpts = {},
): string {
  endpoints = expandCascadeExits(endpoints);
  const xrayEps = endpoints.filter((e) => e.protocol === 'xray');
  const proxyTags: string[] = [];
  const bundle = opts.bundle ?? 'flat';
  // Routing preset (R1a + H2). Each split preset selects its own rule array +
  // split-DNS block; proxy-all leaves both null so the output stays
  // byte-identical to pre-R1 builds.
  const preset = opts.routingPreset ?? 'proxy-all';
  const splitRules = splitRulesFor(preset, opts.presetGeoInline);
  const splitDns = splitDnsFor(preset, opts.presetGeoInline);

  // TLS-fragment - the fragment outbound's tag must not collide with any proxy
  // (`${nodeName}-xray`), `direct`, or `block` tag, and must exactly equal the
  // dialerProxy value we stamp onto each proxy outbound. Prefer "fragment";
  // fall back to "tls-fragment" if some emitted outbound already owns the
  // "fragment" tag (defensive - keeps the guarantee even if the proxy tag
  // scheme ever changes to not carry the `-xray` suffix).
  const tlsFragment = opts.tlsFragment === true && xrayEps.length > 0;
  const reservedTags = new Set<string>(['direct', 'block']);
  for (const e of xrayEps) {
    if (e.protocol === 'xray') reservedTags.add(`${e.nodeName}-xray`);
  }
  const fragmentTag = reservedTags.has('fragment') ? 'tls-fragment' : 'fragment';

  // T1: per-endpoint outbound now built by the shared buildProxyOutbound. Caller
  // keeps the proxyTags bookkeeping (order and values unchanged, so the output
  // stays byte-identical to the inline version).
  const proxyOutbounds = xrayEps.map((e) => {
    proxyTags.push(`${e.nodeName}-xray`);
    return buildProxyOutbound(e, tlsFragment, fragmentTag);
  });

  // Slice 29 follow-up: when balancer is on AND we have ≥2 proxies, wrap
  // the proxy tags in an `observatory` probe + `balancer` selector. With
  // <2 proxies it's pointless (and the balancer block would still work but
  // probe one outbound, wasting bandwidth) so we fall through to flat mode.
  const balancerActive = bundle === 'balancer' && proxyTags.length >= 2;
  const observatory = balancerActive
    ? {
        subjectSelector: proxyTags,
        probeURL: opts.probeUrl ?? 'https://www.gstatic.com/generate_204',
        probeInterval: `${opts.probeIntervalSec ?? 300}s`,
      }
    : undefined;
  const balancers = balancerActive
    ? [{ tag: 'balancer-auto', selector: proxyTags, strategy: { type: 'leastPing' } }]
    : undefined;

  // R3 - operator custom domain lists -> one field rule per non-empty bucket.
  // Order block -> direct -> proxy so a block listing wins over a direct/proxy
  // listing of an overlapping domain. The proxy bucket needs an actual proxy
  // outbound to target; with no xray endpoints it is dropped (no valid tag).
  const cdl = opts.customDomainLists;
  // xray routing has no `keyword:` prefix - a plain (unprefixed) string already
  // IS a substring/keyword match. Strip the explicit `keyword:` that domainMatchers
  // emits (so clash can map it to DOMAIN-KEYWORD) back to bare here; leave
  // domain:/full:/regexp:/geosite:/ext: untouched (all native xray prefixes).
  const forXray = (list: string[]): string[] =>
    list.map((d) => (d.startsWith('keyword:') ? d.slice('keyword:'.length) : d));
  const customDomainRules: Record<string, unknown>[] = cdl
    ? [
        ...(cdl.block.length ? [{ type: 'field', domain: forXray(cdl.block), outboundTag: 'block' }] : []),
        ...(cdl.direct.length ? [{ type: 'field', domain: forXray(cdl.direct), outboundTag: 'direct' }] : []),
        ...(cdl.proxy.length && proxyTags.length > 0
          ? [{ type: 'field', domain: forXray(cdl.proxy), outboundTag: proxyTags[0] }]
          : []),
      ]
    : [];

  // forRouter (XKeen): drop log + the client SOCKS inbound; the router owns
  // those. Keep dns (split presets), outbounds and routing.
  const config: Record<string, unknown> = {
    ...(opts.forRouter ? {} : { log: { loglevel: 'warning' } }),
    ...(splitDns ? { dns: splitDns } : {}),
    ...(opts.forRouter
      ? {}
      : {
          inbounds: localInbounds(opts.localProxyAuth),
        }),
    outbounds: [
      ...proxyOutbounds,
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'block', protocol: 'blackhole' },
      // TLS-fragment - the freedom dialer the proxy outbounds tunnel through.
      // Only appended when on, so the off path stays byte-identical.
      ...(tlsFragment
        ? [
            {
              tag: fragmentTag,
              protocol: 'freedom',
              settings: { fragment: { ...TLS_FRAGMENT_SETTINGS } },
            },
          ]
        : []),
    ],
    routing: {
      // Split presets need IPOnDemand, not IPIfNonMatch. Under IPIfNonMatch a
      // domain-typed destination gets its second, IP-based pass only if NO rule
      // matched the first - and this preset appends a catch-all LAST, which
      // matches always. So the second pass never comes and the preset's own
      // geoip:ru / geoip:cn rule is dead: measured 2026-09-01 on a live xray
      // client, habr.com (foreign domain, Russian address) went into the tunnel
      // with `geoip:ru -> direct` sitting right there in the config. Nothing
      // fails; the split quietly does not split. Same trap and same fix as
      // egress.policy.ts (egressDomainStrategy), where it is measured in full.
      // Cost: IPOnDemand resolves EVERY connection before routing, and under
      // the split DNS below non-RU names resolve through the tunnel.
      // proxy-all keeps AsIs - no rule there needs an address.
      domainStrategy: splitRules ? 'IPOnDemand' : 'AsIs',
      ...(balancers ? { balancers } : {}),
      rules: [
        // R3-b custom rules win over presets + catch-all.
        ...(opts.customRules ?? []),
        // R3 custom domain lists sit below raw rules, above the preset rules.
        ...customDomainRules,
        ...(splitRules ?? []),
        balancerActive
          ? { type: 'field', network: 'tcp,udp', balancerTag: 'balancer-auto' }
          : proxyTags.length > 0
          ? { type: 'field', network: 'tcp,udp', outboundTag: proxyTags[0] }
          : { type: 'field', network: 'tcp,udp', outboundTag: 'direct' },
      ],
    },
  };
  if (observatory) config.observatory = observatory;
  return JSON.stringify(config, null, 2) + '\n';
}

// `expandCascadeExits` and `withVlessRouteTag` moved to subscription.formats.ts
// on 2026-09-02. They were never xray-json's own: clash, sing-box, Surge, Loon
// and QuantumultX render an xray server too and all five skipped the expansion,
// so their subscribers would have got the entry's country under a line that
// says the exit's. Living beside SubscriptionEndpoint, every format can reach
// them without importing this one. Re-exported so existing callers keep working.
export { expandCascadeExits, withVlessRouteTag } from '../subscription.formats.js';

// `cascadeExitLabel` lived here until 2026-08-15. It suffixed a label with the
// host remark whenever the host was named, which it did per endpoint, blind to
// whether anything actually collided: labels that needed no differentiator got
// one, and two entries of a pool (a real collision) got the same suffix rule
// applied from two places that could not see each other. Making labels unique
// needs the whole list at once, so it now happens once in
// subscription.service (disambiguateCascadeLabels) and every format inherits it.

/**
 * A1 array format (T1 skeleton + T2 routing + hy2). A top-level JSON array of
 * standalone configs, one per xray OR hysteria endpoint, each with its own
 * `remarks` (server name), SOCKS inbound, outbounds (its proxy + direct + block)
 * and per-config routing. This is what Happ / V2RayTun parse as N separate
 * servers;
 * the single-config buildXrayJson (one config, N outbounds) they read as one
 * server, which is the migration blocker this closes.
 *
 * A4 (route-profiles, exit selection): an xray endpoint whose node is a balancer-
 * cascade entry carries `cascadeExits`. Such an endpoint expands into one config
 * PER exit instead of one: same entry host/transport, UUID bytes 7-8 set to the
 * exit index+1 (the node's `vlessRoute:<i+1> -> cascade-link-out-<i>` rule pins
 * it), remark = exit name. The client picks the exit by picking the server.
 *
 * T2: each config carries the SAME routing surface the single-config builder
 * does (custom rules, custom domain lists, split preset + split DNS, TLS-
 * fragment), but every "proxy" target is THIS config's own proxy rather than a
 * shared first-outbound. buildXrayJson stays untouched, the balancer bundle
 * still needs it.
 */
export function buildXrayJsonArray(
  endpoints: SubscriptionEndpoint[],
  opts: XrayJsonBuildOpts = {},
): string {
  // xray endpoints AND hysteria endpoints, in endpoint order so the array order
  // matches the эталон. Other protocols are skipped, this is an xray/hy2
  // surface; a hy2 endpoint this format cannot render connectably is skipped
  // too (see hysteriaOutboundIsUsable).
  const supported = endpoints.filter(
    (e) =>
      (e.protocol === 'xray' || e.protocol === 'hysteria') && hysteriaOutboundIsUsable(e),
  );
  const preset = opts.routingPreset ?? 'proxy-all';
  const splitRules = splitRulesFor(preset, opts.presetGeoInline);
  const splitDns = splitDnsFor(preset, opts.presetGeoInline);
  const tlsFragment = opts.tlsFragment === true;
  const cdl = opts.customDomainLists;

  // Builds one standalone config. `remark` is the client-facing server label:
  // the node name normally, the exit name for an A4 route-profile expansion.
  const makeConfig = (e: SubscriptionEndpoint, remark: string) => {
    // Per-protocol primary outbound + tag. TLS-fragment is xray-only (it splits
    // the TCP ClientHello; hy2 rides QUIC, nothing to fragment). Tags carry a
    // protocol suffix so `fragment` can never collide.
    const isXray = e.protocol === 'xray';
    const tag = isXray ? `${e.nodeName}-xray` : `${e.nodeName}-hysteria`;
    const fragmentTag = 'fragment';
    const applyFragment = tlsFragment && isXray;
    const primary = isXray
      ? buildProxyOutbound(e, applyFragment, fragmentTag)
      : buildHysteriaOutbound(e, tag);

    const outbounds: Record<string, unknown>[] = [
      primary,
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'block', protocol: 'blackhole' },
    ];
    if (applyFragment) {
      outbounds.push({
        tag: fragmentTag,
        protocol: 'freedom',
        settings: { fragment: { ...TLS_FRAGMENT_SETTINGS } },
      });
    }

    // R3 custom domain lists, this config's own outbound is the only proxy target.
    const customDomainRules: Record<string, unknown>[] = cdl
      ? [
          ...(cdl.block.length ? [{ type: 'field', domain: cdl.block, outboundTag: 'block' }] : []),
          ...(cdl.direct.length ? [{ type: 'field', domain: cdl.direct, outboundTag: 'direct' }] : []),
          ...(cdl.proxy.length ? [{ type: 'field', domain: cdl.proxy, outboundTag: tag }] : []),
        ]
      : [];

    const rules: Record<string, unknown>[] = [
      // Precedence mirrors buildXrayJson: raw custom rules, then domain lists,
      // then the split preset. Then the per-config contract (эталон Remnawave):
      // torrent off the tunnel, everything else through this proxy.
      ...(opts.customRules ?? []),
      ...customDomainRules,
      ...(splitRules ?? []),
      { type: 'field', protocol: ['bittorrent'], outboundTag: 'direct' },
      { type: 'field', network: 'tcp,udp', outboundTag: tag },
    ];

    return {
      remarks: remark,
      log: { loglevel: 'warning' },
      ...(splitDns ? { dns: splitDns } : {}),
      inbounds: localInbounds(opts.localProxyAuth),
      outbounds,
      routing: {
        // IPOnDemand for the same reason as buildXrayJson: the catch-all below
        // is last and always matches, so IPIfNonMatch's second pass never comes
        // and the preset's geoip rule never fires. See the comment there.
        domainStrategy: splitRules ? 'IPOnDemand' : 'AsIs',
        rules,
      },
    };
  };

  // A4: an xray endpoint fronting a balancer cascade expands into one config per
  // exit (tag in UUID bytes 7-8), each labelled by its exit. Everything else
  // (hy2, or an xray endpoint with no exits) stays a single config as before.
  const configs = expandCascadeExits(supported).map((e) => makeConfig(e, e.nodeName));
  return JSON.stringify(configs, null, 2) + '\n';
}
