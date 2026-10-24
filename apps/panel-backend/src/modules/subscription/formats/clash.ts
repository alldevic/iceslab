import { transportServed, type RoutingPresetId } from '@iceslab/shared';
import { isPlainXray, type SubscriptionEndpoint } from '../subscription.formats.js';
import { makeTagger } from '../endpoint-identity.js';
import { BUILTIN_PRESET_RULES, type DeviceRouteRule } from '../../routing-presets/routing-presets.builtins.js';
import { clashDeviceRuleLines, clashNeedsGeo } from '../subscription.device-rules.js';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { asArray, asObject, defaultFrame, openFrame, type Frame } from '../subscription.frames.js';

/**
 * Clash YAML subscription formatter (targets Clash Meta / Mihomo, covers
 * VLESS+REALITY, Hysteria2, Trojan+REALITY, and Shadowsocks native types).
 *
 * Scope:
 *   - hysteria              → `type: hysteria2`
 *   - xray (VLESS+REALITY)  → `type: vless` with `reality-opts`
 *   - xray (Trojan+REALITY) → `type: trojan` with `reality-opts` (slice 24c part 3a)
 *   - shadowsocks           → `type: ss` with cipher + password (slice 24d)
 *   - mieru                 → `type: mieru`, TCP transport
 *   - amneziawg / naive are NOT emitted: classic Clash has no native support
 *     and Clash Meta's experimental wireguard/naive support diverges per
 *     fork. AmneziaWG users get the wg-quick `.conf` format; Naive users
 *     get the naive+https URI directly.
 *
 * The output is hand-emitted YAML (no js-yaml dep): the schema is fixed and
 * small, and string-based generation gives us bit-for-bit deterministic
 * output across runs (good for diff-testing and avoiding spurious config
 * reloads in clients that hash the body).
 */

// Quote a value with double quotes if it contains anything that would need
// escaping in YAML, otherwise emit it bare. Conservative: passwords, names,
// and reality short-ids may contain `:`, `#`, special chars.
function yamlString(value: string): string {
  if (/^[A-Za-z0-9_\-./]+$/.test(value)) return value;
  return JSON.stringify(value); // double-quoted, JSON escapes are valid YAML
}

/**
 * Routing Templates (R1c + H2) - a split `routingPreset` prepends split-routing
 * rules ahead of the MATCH catch-all (ads -> REJECT, region domains / region
 * IPs / private ranges -> DIRECT) and emits a geo-database block so mihomo can
 * fetch geosite.dat / country.mmdb itself. `ru-split` uses RU categories +
 * Yandex DNS; `cn-split` uses GEOSITE,cn / GEOIP,CN + AliDNS 223.5.5.5:
 *
 *   - `geox-url` points at the testingcf.jsdelivr.net mirror of
 *     MetaCubeX/meta-rules-dat (the docs' own example) because the default
 *     raw.githubusercontent.com source is blocked in RU - exactly where this
 *     preset is used. `geo-auto-update` keeps the databases fresh.
 *   - Private ranges are explicit IP-CIDR/IP-CIDR6 rules with `no-resolve`
 *     (deterministic, no geo dependency) instead of a mmdb pseudo-country.
 *   - `GEOIP,RU` stays last among the DIRECT rules and without `no-resolve`:
 *     it is the fallback that may resolve a domain that missed every GEOSITE
 *     rule before deciding tunnel-vs-direct.
 *
 * Default 'proxy-all' keeps the output byte-identical to pre-R1 builds.
 */
export interface ClashBuildOpts {
  routingPreset?: RoutingPresetId;
  /** A-229: an own preset's rules, in place of the built-in preset's. */
  ownPresetRules?: readonly DeviceRouteRule[];
  /** A-236: the operator template to fill; absent = the mihomo Default. */
  frame?: Frame;
  /** A-236 step 4: the core the file is written for. `clash` (the format) is
   *  mihomo. Default mihomo. */
  dialect?: 'mihomo' | 'stash' | 'clash-legacy';
  /**
   * R3 - operator-defined custom domain lists (direct/proxy/block). Each domain
   * becomes a `DOMAIN-SUFFIX` rule emitted at the head of the `rules:` section
   * (before any ru-split lines and the MATCH catch-all). xray geosite-style
   * prefixes (domain:/full:/regexp:/keyword:) are stripped since Clash does not
   * understand them. Empty/undefined = none = byte-identical output.
   */
  customDomainLists?: { direct: string[]; proxy: string[]; block: string[] };
}

// Geo-database block (shared by every split preset). The testingcf.jsdelivr.net
// mirror of MetaCubeX/meta-rules-dat carries both `cn` and `ru` geo data, so
// this block is preset-independent. NOTE (H2): jsdelivr CDN reachability inside
// mainland China is variable (a different problem than RU's GitHub block), so
// the CN geo-db fetch source may need field validation; if so it is a one-line
// URL swap here, not a redesign.
const SPLIT_GEO_LINES: readonly string[] = [
  'geo-auto-update: true',
  'geo-update-interval: 72',
  'geox-url:',
  '  geosite: "https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite.dat"',
  '  geoip: "https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.dat"',
  '  mmdb: "https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/country.mmdb"',
  '',
];

/**
 * Split DNS (R2). fake-ip keeps app-side resolution instant; RU domains are
 * answered by Yandex DNS (77.88.8.8) via nameserver-policy so RU CDNs return
 * geo-correct IPs, everything else goes to DoH. `default-nameserver` and
 * `proxy-server-nameserver` are plain IPs: they bootstrap the DoH hostnames
 * and resolve the proxy node addresses without a chicken-and-egg loop.
 * NOTE: mihomo sends DNS directly (not through the tunnel) by default; DoH
 * keeps those queries encrypted on the wire.
 */
const RU_SPLIT_DNS_LINES: readonly string[] = [
  'dns:',
  '  enable: true',
  '  enhanced-mode: fake-ip',
  '  fake-ip-range: 198.18.0.1/16',
  '  fake-ip-filter:',
  '    - "*.lan"',
  '    - "+.local"',
  '  default-nameserver:',
  '    - 77.88.8.8',
  '    - 1.1.1.1',
  '  proxy-server-nameserver:',
  '    - 77.88.8.8',
  '    - 1.1.1.1',
  '  nameserver:',
  '    - https://1.1.1.1/dns-query',
  '    - https://dns.google/dns-query',
  '  nameserver-policy:',
  '    "geosite:category-ru": 77.88.8.8',
  '    "geosite:category-gov-ru": 77.88.8.8',
  '',
];

/**
 * Split DNS (H2) - the China mirror of RU_SPLIT_DNS_LINES. China domains are
 * answered by AliDNS (223.5.5.5) via nameserver-policy so CN CDNs return
 * geo-correct IPs; the bootstrap / proxy-server nameservers swap Yandex for
 * AliDNS. The DoH `nameserver` block and the fake-ip block stay identical.
 */
const CN_SPLIT_DNS_LINES: readonly string[] = [
  'dns:',
  '  enable: true',
  '  enhanced-mode: fake-ip',
  '  fake-ip-range: 198.18.0.1/16',
  '  fake-ip-filter:',
  '    - "*.lan"',
  '    - "+.local"',
  '  default-nameserver:',
  '    - 223.5.5.5',
  '    - 1.1.1.1',
  '  proxy-server-nameserver:',
  '    - 223.5.5.5',
  '    - 1.1.1.1',
  '  nameserver:',
  '    - https://1.1.1.1/dns-query',
  '    - https://dns.google/dns-query',
  '  nameserver-policy:',
  '    "geosite:cn": 223.5.5.5',
  '',
];

/**
 * DNS for `proxy-all`. Until now this preset emitted no `dns:` section at all,
 * which is fine while mihomo runs as a system proxy (the app hands it a domain
 * and it resolves remotely) and broken the moment it runs in TUN mode: the
 * client captures the DNS query, has no resolver configured for it, and the
 * profile imports cleanly while nothing resolves. That failure reads as a
 * client bug, which is the worst kind for us.
 *
 * Same loop-safe shape as the split presets, minus the geo policy, since
 * proxy-all has no notion of a domain that should stay local:
 *   - `default-nameserver` and `proxy-server-nameserver` are plain IPs. They
 *     bootstrap the DoH hostnames below and resolve the node's own address,
 *     neither of which can go through a tunnel that is not up yet.
 *   - everything else is DoH, so the queries this preset does make are not
 *     readable by the local network.
 *   - fake-ip keeps app-side resolution instant and means real domains are
 *     never resolved locally at all, which for proxy-all is the point.
 *
 * This retires the "byte-identical to pre-R1 builds" guarantee the preset used
 * to carry. Deliberate: that guarantee was protecting an output that did not
 * work in TUN.
 */
const PROXY_ALL_DNS_LINES: readonly string[] = [
  'dns:',
  '  enable: true',
  '  enhanced-mode: fake-ip',
  '  fake-ip-range: 198.18.0.1/16',
  '  fake-ip-filter:',
  '    - "*.lan"',
  '    - "+.local"',
  '  default-nameserver:',
  '    - 1.1.1.1',
  '    - 8.8.8.8',
  '  proxy-server-nameserver:',
  '    - 1.1.1.1',
  '    - 8.8.8.8',
  '  nameserver:',
  '    - https://1.1.1.1/dns-query',
  '    - https://dns.google/dns-query',
  '',
];

// The rule lines of a preset are rendered from its DeviceRouteRule list
// (subscription.device-rules.ts, A-229): the built-ins' and an own preset's alike. The
// RU/CN line arrays that lived here rendered the same lines, the private
// ranges as explicit CIDRs with no-resolve and GEOIP last without it.

export function buildClashYaml(
  endpoints: SubscriptionEndpoint[],
  buildOpts: ClashBuildOpts = {},
): string {
  // Routing preset (R1c + H2 + A-229). The DNS block stays per built-in: the
  // split ones name the resolver of the country whose domains go direct. An
  // own preset names no country, so it takes the proxy-all block, which is
  // there for the TUN case and holds for any rule set.
  const preset = buildOpts.routingPreset ?? 'proxy-all';
  const own = buildOpts.ownPresetRules;
  const deviceRules = own ?? BUILTIN_PRESET_RULES[preset];
  const dnsLines = own
    ? PROXY_ALL_DNS_LINES
    : preset === 'ru-split'
      ? RU_SPLIT_DNS_LINES
      : preset === 'cn-split'
        ? CN_SPLIT_DNS_LINES
        : PROXY_ALL_DNS_LINES;
  const proxies: string[] = [];
  const proxyNames: string[] = [];
  // A-236 step 4: the dialect. One builder, the fields the three cores spell
  // differently branched where they differ (Stash: stash.wiki/en/proxy-
  // protocols/proxy-types; legacy Clash: clash.wiki/configuration/
  // outbound.html; both read 2026-10-24). Which doors and transports each
  // dialect carries is the shared tables' (FORMAT_DOORS, TRANSPORT_SUPPORT).
  const dialect = buildOpts.dialect ?? 'mihomo';
  const stash = dialect === 'stash';
  const legacy = dialect === 'clash-legacy';
  const transportRow = dialect === 'mihomo' ? 'clash' : dialect;

  // A Clash proxy name is both the row a person taps and the string every
  // proxy-group and rule points at, so it stays readable and is made unique
  // instead of being replaced by an id. Same reasoning as the sing-box tag.
  const nameOf = makeTagger();
  for (const e of endpoints) {
    // A socks/http door is named by what it is: "-xray" on a SOCKS5 proxy
    // would tell the person picking it from the list the wrong thing.
    const name = nameOf(e, `${e.nodeName}-${isPlainXray(e) ? e.subprotocol : e.protocol}`);
    const before = proxies.length;
    if (e.protocol === 'hysteria') {
      proxyNames.push(name);
      const lines = [
        `  - name: ${yamlString(name)}`,
        `    type: hysteria2`,
        `    server: ${e.host}`,
        `    port: ${e.port}`,
        // Stash spells the password `auth`.
        `    ${stash ? 'auth' : 'password'}: ${yamlString(e.password)}`,
      ];
      if (e.obfsPassword) {
        lines.push(
          `    obfs: salamander`,
          `    obfs-password: ${yamlString(e.obfsPassword)}`,
        );
      }
      // Slice 31.5: Clash Meta (mihomo) port-hopping. The `ports` key
      // accepts a `START-END` (hyphen) or comma-list form; we emit the
      // hyphen form to match the URI's `mport`. Server-side iptables
      // REDIRECT range must cover this.
      if (
        typeof e.portHoppingStart === 'number' &&
        typeof e.portHoppingEnd === 'number'
      ) {
        lines.push(`    ports: ${e.portHoppingStart}-${e.portHoppingEnd}`);
      }
      // E30a: the panel's self-signed certificate on a node addressed by IP.
      // mihomo's `fingerprint` is the sha256 of the certificate DER (colons
      // optional); a leaf that matches is accepted with no other check, so no
      // skip-cert-verify (component/ca/fingerprint.go, read 2026-09-25).
      // Stash spells it `server-cert-fingerprint`, a common TLS parameter:
      // "the SHA256 fingerprint of the server certificate in Hex format"
      // (stash.wiki/en/proxy-protocols/proxy-types, read 2026-10-24).
      if (e.tlsPin) lines.push(`    ${stash ? 'server-cert-fingerprint' : 'fingerprint'}: ${e.tlsPin.certSha256}`);
      proxies.push(lines.join('\n'));
    } else if (isPlainXray(e)) {
      // The Telegram doors: mihomo `socks5` / `http` with the user's login.
      // No TLS, and UDP stays off as it is on the node (udp: false there).
      proxyNames.push(name);
      proxies.push(
        [
          `  - name: ${yamlString(name)}`,
          `    type: ${e.subprotocol === 'socks' ? 'socks5' : 'http'}`,
          `    server: ${e.host}`,
          `    port: ${e.port}`,
          `    username: ${yamlString(e.username)}`,
          `    password: ${yamlString(e.password)}`,
          ...(e.subprotocol === 'socks' ? ['    udp: false'] : []),
        ].join('\n'),
      );
    } else if (e.protocol === 'xray') {
      const sub = e.subprotocol ?? 'vless';
      // A-133 (wiki.metacubex.one/en/config/proxies/{vless,vmess,trojan} and
      // .../transport, read 22.10). A `network` mihomo does not know is not
      // refused there: "If unset or set to another value, TCP is used", so a
      // network written as it stands went out as a line that dials bare TCP.
      //   vless   ws, grpc, xhttp (xhttp-opts: path, host);
      //   vmess   ws, grpc (mkcp too, but its seed and header are not in the
      //           endpoint, and a default that differs from the node fails);
      //   trojan  ws, grpc;
      //   httpupgrade on all three is `network: ws` with
      //   `ws-opts.v2ray-http-upgrade: true`, not a network of its own.
      // Anything else (kcp everywhere, xhttp off vless) is left out, as the
      // other proxy-line formats leave out what their client does not speak.
      // The shared table decides (A-224).
      if (!transportServed(transportRow, e)) continue;
      proxyNames.push(name);
      // Clash Meta `network` uses "tcp" for our "raw", "ws" for httpupgrade.
      const network =
        e.network === 'raw' || !e.network ? 'tcp' : e.network === 'httpupgrade' ? 'ws' : e.network;
      const httpUpgrade = e.network === 'httpupgrade';
      // securityLayer: 'default' = REALITY, else 'tls' (own cert) / 'none'
      // (plain, e.g. CDN terminates TLS). REALITY emits reality-opts; tls emits
      // a plain TLS block; none disables client TLS.
      const sec = e.securityLayer ?? 'default';
      const isReality = sec === 'default';
      const useTls = sec !== 'none';

      const block = [
        `  - name: ${yamlString(name)}`,
        `    type: ${sub === 'trojan' ? 'trojan' : sub === 'vmess' ? 'vmess' : 'vless'}`,
        `    server: ${e.host}`,
        `    port: ${e.port}`,
        sub === 'trojan' ? `    password: ${yamlString(e.uuid)}` : `    uuid: ${e.uuid}`,
      ];
      // VMess needs alterId (0 = AEAD) + a client cipher.
      if (sub === 'vmess') {
        block.push(`    alterId: 0`, `    cipher: auto`);
      }
      block.push(`    network: ${network}`, `    tls: ${useTls}`, `    udp: true`);
      if (useTls && e.sni) {
        // Stash and legacy Clash name the SNI of vless and trojan `sni`; vmess
        // keeps `servername` in all three.
        const sniKey = (stash && sub !== 'vmess') || (legacy && sub === 'trojan') ? 'sni' : 'servername';
        block.push(`    ${sniKey}: ${yamlString(e.sni)}`);
      }
      // Vision flow needs a TLS-like layer (reality or tls), not plain none.
      if (sub === 'vless' && useTls && e.flow) {
        block.push(`    flow: ${yamlString(e.flow)}`);
      }
      if (e.alpn && e.alpn.length > 0) {
        block.push(`    alpn: [${e.alpn.map((a) => yamlString(a)).join(', ')}]`);
      }
      if (e.allowInsecure) {
        block.push(`    skip-cert-verify: true`);
      }
      // legacy Clash has no uTLS fingerprint.
      if (useTls && e.fingerprint && !legacy) {
        block.push(`    client-fingerprint: ${yamlString(e.fingerprint)}`);
      }
      // REALITY material only for the reality layer.
      if (isReality) {
        block.push(
          `    reality-opts:`,
          `      public-key: ${yamlString(e.publicKey)}`,
          `      short-id: ${yamlString(e.shortId)}`,
        );
      }
      // Transport options. ws carries httpupgrade too (v2ray-http-upgrade);
      // there was a `network: httpupgrade` with `httpupgrade-opts` here, which
      // mihomo has no such name for and read as TCP. xhttp has its own block.
      // grpc has its own block below.
      if (network === 'ws') {
        const opts: string[] = [];
        if (e.path) opts.push(`      path: ${yamlString(e.path)}`);
        if (e.hostHeader) {
          opts.push(`      headers:`);
          opts.push(`        Host: ${yamlString(e.hostHeader)}`);
        }
        if (httpUpgrade) opts.push(`      v2ray-http-upgrade: true`);
        if (opts.length > 0) {
          block.push(`    ws-opts:`);
          block.push(...opts);
        }
      }
      if (network === 'xhttp') {
        const opts: string[] = [];
        if (e.path) opts.push(`      path: ${yamlString(e.path)}`);
        if (e.hostHeader) opts.push(`      host: ${yamlString(e.hostHeader)}`);
        // The node's mode when it is not auto: mihomo takes the same four
        // values ("auto, stream-one, stream-up, or packet-up", transport page,
        // read 22.10), and a client on its own default against a non-auto
        // server does not connect.
        if (e.xhttpMode && e.xhttpMode !== 'auto') opts.push(`      mode: ${e.xhttpMode}`);
        if (opts.length > 0) {
          block.push(`    xhttp-opts:`);
          block.push(...opts);
        }
      }
      if (network === 'grpc' && e.serviceName) {
        block.push(`    grpc-opts:`);
        block.push(`      grpc-service-name: ${yamlString(e.serviceName)}`);
      }

      proxies.push(block.join('\n'));
    } else if (e.protocol === 'shadowsocks') {
      // Slice 24d: Clash Meta uses `type: ss` with a `cipher` field that
      // matches our `method` exactly (clash and xray share the SS2022 names).
      proxyNames.push(name);
      proxies.push(
        [
          `  - name: ${yamlString(name)}`,
          `    type: ss`,
          `    server: ${e.host}`,
          `    port: ${e.port}`,
          `    cipher: ${yamlString(e.method)}`,
          `    password: ${yamlString(e.password)}`,
          `    udp: true`,
        ].join('\n'),
      );
    } else if (e.protocol === 'tuic') {
      // TUIC v5 (sing-box engine) -> mihomo `type: tuic`. Self-signed cert in
      // the alpha so skip-cert-verify; uuid+password auth, native UDP relay.
      proxyNames.push(name);
      proxies.push(
        [
          `  - name: ${yamlString(name)}`,
          `    type: tuic`,
          `    server: ${e.host}`,
          `    port: ${e.port}`,
          // Stash takes v4 and v5 and wants the version said.
          ...(stash ? ['    version: 5'] : []),
          `    uuid: ${yamlString(e.uuid)}`,
          `    password: ${yamlString(e.password)}`,
          `    congestion-controller: ${yamlString(e.congestionControl || 'bbr')}`,
          `    alpn: [h3]`,
          `    sni: ${yamlString(e.serverName)}`,
          // Not in Stash's documented TUIC fields.
          ...(stash ? [] : ['    udp-relay-mode: native']),
          `    skip-cert-verify: true`,
        ].join('\n'),
      );
    } else if (e.protocol === 'anytls') {
      // AnyTLS (sing-box engine) -> mihomo `type: anytls`. Password-only auth;
      // self-signed cert in the alpha so skip-cert-verify.
      proxyNames.push(name);
      proxies.push(
        [
          `  - name: ${yamlString(name)}`,
          `    type: anytls`,
          `    server: ${e.host}`,
          `    port: ${e.port}`,
          `    password: ${yamlString(e.password)}`,
          `    sni: ${yamlString(e.serverName)}`,
          `    skip-cert-verify: true`,
        ].join('\n'),
      );
    } else if (e.protocol === 'shadowtls') {
      // ShadowTLS v3 -> mihomo `type: ss` with the `shadow-tls` plugin. The ss
      // cipher/password is the inner key; plugin-opts carries the shadowtls host
      // (camouflage SNI) + per-user password + version. shadow-tls does a real
      // handshake to a valid host, so no skip-cert-verify.
      proxyNames.push(name);
      proxies.push(
        [
          `  - name: ${yamlString(name)}`,
          `    type: ss`,
          `    server: ${e.host}`,
          `    port: ${e.port}`,
          `    cipher: ${yamlString(e.ssMethod)}`,
          `    password: ${yamlString(e.ssPassword)}`,
          `    plugin: shadow-tls`,
          `    plugin-opts:`,
          `      host: ${yamlString(e.handshake)}`,
          `      password: ${yamlString(e.shadowtlsPassword)}`,
          `      version: 3`,
          `    udp: true`,
        ].join('\n'),
      );
    } else if (e.protocol === 'mieru') {
      // Mieru -> mihomo `type: mieru`. Missing until now, which meant a user
      // whose only endpoint was Mieru imported a Clash profile with their node
      // silently absent: the other formatters (surge/loon/quantumultx) carried
      // it, so the gap looked like a client bug rather than ours.
      //
      // The node binds TCP and UDP on the same port (mieru/config.go), and we
      // advertise TCP: it is the transport that survives the middleboxes this
      // protocol exists to get through, and mihomo takes one, not both.
      //
      // Two fields are left out on purpose. `mtu` tunes the server-side tunnel
      // and mihomo has no key for it, so sending it would be inventing config.
      // `multiplexing` is omitted because mihomo's own default is the value we
      // would have written anyway.
      proxyNames.push(name);
      proxies.push(
        [
          `  - name: ${yamlString(name)}`,
          `    type: mieru`,
          `    server: ${e.host}`,
          `    port: ${e.port}`,
          // Stash writes the transport in lower case (`tcp` or `udp`).
          `    transport: ${stash ? 'tcp' : 'TCP'}`,
          `    username: ${yamlString(e.username)}`,
          `    password: ${yamlString(e.password)}`,
        ].join('\n'),
      );
    }
    // A-236 step 6: the host's line under the server name, for the apps that
    // show one (the route leaves it on the endpoint only for them). The
    // operator's text, so through the YAML writer, never spliced in.
    if (proxies.length > before && e.serverDescription) {
      proxies[proxies.length - 1] += `\n${keyLines('serverDescription', e.serverDescription, '    ').join('\n')}`;
    }
  }

  // A-236 step 3: the nodes and the panel's routing go into the frame, the
  // operator's template or the Default (templates.defaults.ts, the shape this
  // builder always wrote).
  return renderClashFrame(buildOpts.frame ?? defaultFrame(stash ? 'stash' : legacy ? 'clash' : 'mihomo'), {
    proxies,
    proxyNames,
    deviceRules,
    dnsLines,
    customDomainLists: buildOpts.customDomainLists,
  });
}

/** A scalar the way the YAML library writes it plain or quoted. */
function scalar(v: unknown): string {
  return stringifyYaml(v, { lineWidth: 0 }).trimEnd();
}

/** `key: value` lines of any value, each prefixed. */
function keyLines(key: string, value: unknown, prefix: string): string[] {
  return stringifyYaml({ [key]: value }, { lineWidth: 0 }).trimEnd().split('\n').map((l) => prefix + l);
}

/**
 * The nodes and the panel's routing into a Clash-family frame (mihomo; stash
 * and legacy clash with step 4). The frame is written back key by key, in its
 * order, in the style this builder always wrote, so the Default comes out byte
 * for byte as before (golden):
 *   - where `iceslab:` stood, under `routing: preset`: the geo databases (when
 *     the rules name them and the frame has no geox-url of its own) and the
 *     preset's DNS (when the frame has no `dns` of its own);
 *   - `proxies`: the frame's own, then the nodes;
 *   - `proxy-groups`: each group gets the node names after its own members,
 *     as its `iceslab:` says (include-proxies false: none; select-random-proxy:
 *     one; shuffle-proxies-order: shuffled). A group left with no member at
 *     all is dropped, and a rule or group that named it gets DIRECT / loses it;
 *   - `proxy-providers` with `iceslab: { include-proxies: true }` get the nodes
 *     as their payload;
 *   - `rules`: under `routing: preset` the operator's custom domain lists and
 *     the preset's lines first, then the frame's own;
 *   - anything else as the YAML library writes it.
 * A frame with no `proxies` key gets one at the end: the nodes always go out.
 */
export function renderClashFrame(
  frame: Frame,
  p: {
    proxies: string[];
    proxyNames: string[];
    deviceRules: readonly DeviceRouteRule[];
    dnsLines: readonly string[];
    customDomainLists?: { direct: string[]; proxy: string[]; block: string[] };
  },
): string {
  const { cfg, routing } = openFrame(frame);
  const nodeNames = new Set(p.proxyNames);

  // Groups first: which receive nodes, which go.
  const groups = asArray(cfg['proxy-groups']).map((g) => {
    const group = asObject(g);
    const svc = asObject(group.iceslab);
    delete group.iceslab;
    let nodes = [...p.proxyNames];
    if (svc['include-proxies'] === false) nodes = [];
    else if (svc['select-random-proxy'] === true) nodes = nodes.length ? [nodes[Math.floor(Math.random() * nodes.length)]!] : [];
    else if (svc['shuffle-proxies-order'] === true) nodes = nodes.sort(() => Math.random() - 0.5);
    group.proxies = [...asArray(group.proxies).map(String), ...nodes];
    return group;
  });
  // A group with no member and nothing that fills it in the client (`use`,
  // `include-all*`; wiki.metacubex.one/en/config/proxy-groups, read 24.10) is
  // left out: mihomo would route it to its empty-fallback, which is not what a
  // rule naming the group meant. Today's Default with no node drops its Auto
  // group and says MATCH,DIRECT, as the builder always did.
  const fedByClient = (g: Frame) =>
    asArray(g.use).length > 0 || g['include-all'] === true || g['include-all-proxies'] === true || g['include-all-providers'] === true;
  const dropped = new Set(
    groups.filter((g) => asArray(g.proxies).length === 0 && !fedByClient(g)).map((g) => String(g.name)),
  );
  const kept = groups
    .filter((g) => !dropped.has(String(g.name)))
    .map((g): Frame => ({ ...g, proxies: asArray(g.proxies).filter((m) => !dropped.has(String(m))) }));
  // Where the panel's `proxy` rules go: the first group that holds a node.
  const target =
    kept.find((g) => asArray(g.proxies).some((m) => nodeNames.has(String(m))))?.name as string | undefined;

  const lines: string[] = [];
  const keys = Object.keys(frame);
  if (!keys.includes('proxies')) keys.push('proxies');
  for (const key of keys) {
    if (key === 'iceslab') {
      if (!routing) continue;
      // The geo databases are fetched only when the rules name them (GEOSITE /
      // GEOIP). DNS is emitted for every preset.
      if (clashNeedsGeo(p.deviceRules) && cfg['geox-url'] === undefined) lines.push(...SPLIT_GEO_LINES);
      if (cfg.dns === undefined) lines.push(...p.dnsLines);
    } else if (key === 'proxies') {
      lines.push('proxies:');
      const own = asArray(cfg.proxies);
      const ownLines = own.length ? stringifyYaml(own, { lineWidth: 0 }).trimEnd().split('\n').map((l) => `  ${l}`) : [];
      if (ownLines.length === 0 && p.proxies.length === 0) lines.push('  []');
      lines.push(...ownLines, ...p.proxies);
      lines.push('');
    } else if (key === 'proxy-groups') {
      lines.push('proxy-groups:');
      if (kept.length === 0) lines.push('  []');
      for (const g of kept) lines.push(...groupLines(g, nodeNames));
      lines.push('');
    } else if (key === 'proxy-providers') {
      const providers = asObject(cfg['proxy-providers']);
      for (const prov of Object.values(providers)) {
        const pv = asObject(prov);
        const svc = asObject(pv.iceslab);
        delete pv.iceslab;
        if (svc['include-proxies'] === true) pv.payload = parseYaml(p.proxies.join('\n') || '[]');
      }
      lines.push(...keyLines(key, providers, ''));
    } else if (key === 'rules') {
      // R3 - operator custom domain lists -> DOMAIN-SUFFIX rules. Order
      // block -> direct -> proxy so a block listing wins over a direct/proxy
      // listing of an overlapping domain. Strip xray geosite-style prefixes
      // Clash cannot parse. The proxy bucket goes where the panel's proxy
      // rules go, and only when there is such a group.
      const cdl = routing ? p.customDomainLists : undefined;
      const stripPfx = (d: string): string => d.replace(/^(domain|full|regexp|keyword):/, '');
      const panel = routing
        ? [
            ...(cdl
              ? [
                  ...cdl.block.map((d) => `  - DOMAIN-SUFFIX,${stripPfx(d)},REJECT`),
                  ...cdl.direct.map((d) => `  - DOMAIN-SUFFIX,${stripPfx(d)},DIRECT`),
                  ...(target ? cdl.proxy.map((d) => `  - DOMAIN-SUFFIX,${stripPfx(d)},${target}`) : []),
                ]
              : []),
            ...clashDeviceRuleLines(p.deviceRules, target ?? null),
          ]
        : [];
      const own = asArray(cfg.rules).map((r) => `  - ${retarget(String(r), dropped)}`);
      if (panel.length + own.length === 0) lines.push('rules: []');
      else lines.push('rules:', ...panel, ...own);
    } else {
      lines.push(...keyLines(key, cfg[key], ''));
    }
  }
  return lines.join('\n') + '\n';
}

/** A rule whose target is a dropped group goes DIRECT. The target is the last
 *  field, or the one before `no-resolve`. */
function retarget(rule: string, dropped: Set<string>): string {
  const parts = rule.split(',');
  const at = parts[parts.length - 1]?.trim() === 'no-resolve' ? parts.length - 2 : parts.length - 1;
  if (at >= 1 && dropped.has(parts[at]!.trim())) parts[at] = 'DIRECT';
  return parts.join(',');
}

/** One proxy group as this builder always wrote it: node names quoted the way
 *  their blocks are, the frame's own values as the YAML library writes them,
 *  `proxies` where the frame has it or last. */
function groupLines(g: Frame, nodeNames: Set<string>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(g)) {
    if (k === 'proxies') {
      const members = asArray(v).map(String);
      if (members.length === 0) {
        out.push('    proxies: []');
        continue;
      }
      out.push('    proxies:');
      for (const m of members) out.push(`      - ${nodeNames.has(m) ? yamlString(m) : scalar(m)}`);
    } else if (v === null || typeof v !== 'object') {
      out.push(`    ${k}: ${scalar(v)}`);
    } else {
      out.push(...keyLines(k, v, '    '));
    }
  }
  if (out.length > 0) out[0] = `  - ${out[0]!.slice(4)}`;
  return out;
}
